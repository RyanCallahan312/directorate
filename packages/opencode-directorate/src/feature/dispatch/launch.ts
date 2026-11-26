// Launching: the subagent tool's hooks. A launch is registered before the child runs, so a fast child is never missed,
// and the subagent's result settles it even if session.created was missed.
import { DateTime, Effect, Option, Predicate, Schema } from "effect";

import { ignore } from "../../platform/error.ts";
import { adapter, Host } from "../../platform/platform.ts";
import { Store } from "../../records/records.ts";
import { HostEvent, Sessions } from "../../seal/seal.ts";
import { childNamed, Liaison, Seat } from "../agents/agent.ts";
import {
  followUpPrompt,
  launchTitle,
  launched,
  openSeat,
  resumed,
  returned,
  seatName,
  withdrawn,
} from "./lifecycle.ts";
import type { Child } from "./lifecycle.ts";

/** An Auditor, Seat, or Compliance launch, as the subagent tool's input; with a sessionID it continues an existing child. */
const decodeAssignment = Schema.decodeUnknownOption(
  Schema.Struct({
    agent: Schema.Literals(Liaison.dispatches),
    description: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    sessionID: Schema.optional(Schema.String),
  })
);

/** What the subagent tool reports about the child it ran. */
const decodeChildMeta = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionID: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
  })
);

export const registerLaunches = Effect.fnUntraced(function* registerLaunches() {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const store = yield* Store;
  const { hook } = yield* adapter<Sessions | Store>();

  // ---------- Auditors, Seats, and Compliance ----------
  // Launching: registered before the child runs, so a fast child is never missed. A completed child calling tools again
  // is running again; check before locking, since most calls change nothing.
  yield* host.tool.hook(
    "execute.before",
    hook("executeBefore", function* onExecuteBefore(ev) {
      if (ev.tool !== "subagent") {
        const id = yield* sessions.boundTo(ev.sessionID);

        if (!id || !childNamed(ev.agent)) {
          return;
        }

        const seal = yield* store
          .load(id)
          .pipe(Effect.orElseSucceed(() => null));

        if (!seal || !resumed(seal, ev.sessionID)) {
          return;
        }

        yield* sessions
          .mutate(id, HostEvent.make({}), ({ seal: s }) =>
            Effect.succeed({ out: undefined, seal: resumed(s, ev.sessionID) })
          )
          .pipe(
            ignore(`could not mark ${ev.sessionID} running in ${id}`, "Warn")
          );

        return;
      }

      const assignment = Option.getOrUndefined(decodeAssignment(ev.input));

      if (!assignment) {
        return;
      }

      const seal = yield* sessions.active(ev.sessionID);

      if (!seal) {
        return;
      }

      const startedAt = yield* DateTime.now;
      // Assign seats under the seal lock so parallel launches take different models.
      let launch: Child | undefined;
      yield* sessions
        .mutate(seal.id, HostEvent.make({}), ({ seal: s }) => {
          // A follow-up continues a child session: a new run of it, keeping the seat it was launched for.
          const prior = assignment.sessionID
            ? s.children.findLast((c) => c.session === assignment.sessionID)
            : undefined;

          if (assignment.sessionID) {
            launch = {
              agent: assignment.agent,
              call: ev.id,
              description: assignment.description ?? prior?.description,
              followUp: {},
              model: assignment.model ?? prior?.model,
              prompt: assignment.prompt ?? "",
              session: assignment.sessionID,
              startedAt,
              status: "launching",
            };

            return Effect.succeed({
              out: undefined,
              seal: launched(s, launch),
            });
          }

          const model =
            assignment.agent === Seat.id && !assignment.model
              ? openSeat(s)
              : undefined;

          launch = {
            agent: assignment.agent,
            call: ev.id,
            description: model
              ? `${assignment.description ?? "Directorate Seat"} · ${seatName(model)}`
              : assignment.description,
            model: model ?? assignment.model,
            prompt: assignment.prompt ?? "",
            startedAt,
            status: "launching",
          };

          return Effect.succeed({ out: undefined, seal: launched(s, launch) });
        })
        .pipe(
          ignore(`could not register ${assignment.agent} in ${seal.id}`, "Warn")
        );

      if (launch) {
        yield* sessions.launch(ev.id, seal.id, ev.sessionID);
      }

      if (launch && Predicate.isObject(ev.input)) {
        if (launch.followUp) {
          ev.input = { ...ev.input, prompt: followUpPrompt(launch) };
        } else if (launch.model) {
          ev.input = {
            ...ev.input,
            description: launchTitle(launch),
            model: launch.model,
          };
        } else {
          ev.input = {
            ...ev.input,
            description: launchTitle(launch),
          };
        }
      }
    })
  );

  /** A launch of a seal reported before the launch ran: stop the child it started, which no review owns now. */
  const stopUnowned = Effect.fn("Directorate.stopUnowned")(
    function* stopUnowned(
      call: string,
      sealId: string | undefined,
      session: string | undefined
    ) {
      const reported = sealId
        ? yield* store.load(sealId).pipe(Effect.orElseSucceed(() => null))
        : null;

      const launch = reported?.reportedAt
        ? reported.children.find(
            (x) => x.call === call && x.status === "launching"
          )
        : undefined;

      const child = session ?? launch?.session;

      if (launch && child) {
        yield* sessions.interrupt(child);
      }
    }
  );

  // The subagent result is authoritative even if session.created was missed (a plugin reload mid-launch).
  yield* host.tool.hook(
    "execute.after",
    hook("executeAfter", function* onExecuteAfter(ev) {
      if (ev.tool !== "subagent") {
        return;
      }

      const result = ev.status === "completed" ? ev.result : undefined;

      const meta = Option.getOrElse(
        decodeChildMeta(result?.metadata?.metadata ?? result?.metadata),
        () => ({ sessionID: undefined, status: undefined })
      );

      const launchedFor = yield* sessions.launchedFor(ev.id);
      yield* sessions.launchSettled(ev.id);
      const seal = yield* sessions.active(ev.sessionID);

      // Launched for a review that is no longer this session's, even if the Liaison has sealed another since.
      if (!seal || (launchedFor && launchedFor !== seal.id)) {
        return yield* stopUnowned(ev.id, launchedFor, meta.sessionID);
      }

      const text = JSON.stringify(result?.content ?? "");

      let outcome: Child["status"] = "running";

      if (ev.status === "error") {
        outcome = "failed";
      } else if (
        meta.status === "completed" ||
        /state=\\?"completed/u.test(text)
      ) {
        outcome = "completed";
      } else if (
        /state=\\?"(?:failed|error|interrupted)/u.test(text) ||
        meta.status === "failed"
      ) {
        outcome = "failed";
      }

      const endedAt = yield* DateTime.now;
      let child: string | undefined;
      yield* sessions
        .mutate(seal.id, HostEvent.make({}), ({ seal: s }) => {
          const launch = s.children.find((x) => x.call === ev.id);

          // Not an Auditor, Seat, or Compliance of this review.
          if (!launch) {
            return Effect.succeed({ out: undefined });
          }

          // Rejected before it ran: the subagent tool checks permission (drain, lockdown, rules) after this launch
          // registered, so there is no child, and no failure to report.
          if (ev.status === "error" && launch.status === "launching") {
            return Effect.succeed({
              out: undefined,
              seal: withdrawn(s, launch),
            });
          }

          child = meta.sessionID ?? launch.session;

          return Effect.succeed({
            out: undefined,
            seal: returned(s, ev.id, meta.sessionID, outcome, endedAt),
          });
        })
        .pipe(ignore(`could not record subagent result in ${seal.id}`, "Warn"));

      if (child) {
        yield* sessions.bind(child, seal.id);
      }
    })
  );
});
