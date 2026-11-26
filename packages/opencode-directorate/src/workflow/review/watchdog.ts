// The watchdog: past the deadline and its grace period it reports for the Liaison; before it, it settles runs missed
// across a reload and wakes a standalone review whose Liaison stalled.
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Clock, DateTime, Effect, Schedule } from "effect";

import { Liaison } from "../../feature/agents/agent.ts";
import { settleChildren } from "../../feature/dispatch/dispatch.ts";
import { ignore, recover } from "../../platform/error.ts";
import {
  activity,
  foreign,
  Git,
  Host,
  locationKey,
  ProcessIdentity,
} from "../../platform/platform.ts";
import { Records } from "../../records/records.ts";
import type { Seal } from "../../seal/record.ts";
import { RecoveryWake, Sessions, Watchdog } from "../../seal/seal.ts";
import { halted, Recovery, waking, woken } from "./custody.ts";
import { interruptedReview } from "./interrupted.ts";
import { shipped } from "./ship-link.ts";
import type { AutoReport } from "./tools.ts";
import { GRACE_MS } from "./window.ts";

/** Tells the caller of a review the watchdog woke that its Liaison filed the Directive, if the caller is still here. */
export const notifyRecoveredReview = Effect.fnUntraced(
  function* notifyRecoveredReview(seal: Seal, md: string) {
    const host = yield* Host;

    const { parentID } = yield* host.session.get({
      sessionID: Session.ID.make(seal.ownerSession),
    });

    if (!parentID) {
      return;
    }

    const parent = yield* host.session.get({ sessionID: parentID });

    if (
      locationKey(parent.location) === locationKey(host.location) &&
      !parent.time.archived &&
      !parent.revert
    ) {
      yield* host.session.synthetic({
        resume: false,
        sessionID: parentID,
        text: `The Directorate finished the recovered review ${seal.id}:\n\n${md}`,
      });
    }
  },
  recover("could not deliver the recovered Directive")
);

/**
 * The deadline sweep, every 30 seconds after the first 30. `loadedAt` is when this plugin instance loaded: only reviews
 * sealed before it are recovered. `recoverShips` names the ship that owns each seal it recovers.
 */
export const watchdog = Effect.fnUntraced(function* watchdog(
  loadedAt: number,
  autoReport: AutoReport,
  recoverShips: Effect.Effect<ReadonlyMap<string, string>>
) {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const store = yield* Records;
  const { pid } = yield* ProcessIdentity;

  const myRepo = yield* (yield* Git)
    .root(host.location.directory)
    .pipe(Effect.orElseSucceed(() => null));

  // ---------- the budget ----------
  // Past the deadline and its grace period, the watchdog reports for the Liaison. One scoped sweep at a time; reload
  // interrupts both the sweep and the event consumer.
  /** Seals a sweep found reported, never read again: a reported seal never reopens. */
  const reported = new Set<string>();

  /**
   * A standalone review whose Liaison ended a turn without reporting before this instance loaded: wake it once. A review
   * the user stopped, or one a ship owns, is not this sweep's to continue.
   */
  const recoverable = (seal: Seal) =>
    seal.owner === Liaison.id &&
    !seal.reportedAt &&
    !seal.halted &&
    seal.ship === undefined &&
    DateTime.toEpochMillis(seal.createdAt) < loadedAt;

  const recoverReview = Effect.fn("Directorate.recoverReview")(
    function* recoverReview(seal: Seal) {
      const sealedAt = DateTime.toEpochMillis(seal.createdAt);

      if (!recoverable(seal)) {
        return;
      }

      /**
       * The Liaison's session, if it is here and stalled: left mid-turn by a restart, or idle after a turn of this
       * review that succeeded without reporting.
       */
      const stalledOwner = Effect.gen(function* stalledOwner() {
        const session = yield* sessions.info(seal.ownerSession);

        if (
          !session ||
          locationKey(session.location) !== locationKey(host.location) ||
          session.agent !== Liaison.id ||
          session.time.archived ||
          session.revert
        ) {
          return;
        }

        const act = yield* activity(host, session);

        const stalled =
          act.state === "orphaned" ||
          (act.state === "idle" &&
            act.session.outcome === "succeeded" &&
            act.at >= sealedAt);

        return stalled ? session.id : undefined;
      });

      const sessionID = yield* stalledOwner;

      if (!sessionID || (yield* sessions.recordedSeal(sessionID)) !== seal.id) {
        return;
      }

      yield* sessions.mutate(seal.id, RecoveryWake.make({}), (review) =>
        Effect.gen(function* resumeOwner() {
          const current = review.seal;

          if (
            !recoverable(current) ||
            current.ownerSession !== sessionID ||
            (yield* foreign(current.pid)) ||
            (yield* stalledOwner) !== sessionID
          ) {
            return { out: undefined };
          }

          const messages = yield* host.session.context({ sessionID });

          if (interruptedReview(current, messages)) {
            return { out: undefined, seal: halted(current) };
          }

          const prior =
            current.recovery?.ownerSession === sessionID
              ? current.recovery
              : undefined;

          const delivered =
            prior &&
            messages.some(
              (message) =>
                message.type === "synthetic" && message.id === prior.id
            );

          // A still-queued wake does not need a duplicate, nor does one already handled by this instance.
          if (
            prior?.admitted &&
            (!delivered || prior.admittedMillis >= loadedAt)
          ) {
            return { out: undefined };
          }

          const retry = prior?.admitted ? undefined : prior;

          const recovery = Recovery.make({
            id: retry?.id ?? SessionMessage.ID.create(),
            ownerSession: sessionID,
          });

          // The intent is saved before the wake, and the wake's ID is reused until its admission is saved: the host
          // keeps the first admission of an ID, so neither a lost wake nor a lost acknowledgement repeats or drops it.
          if (!retry) {
            yield* review.checkpoint(waking(current, pid, recovery));
          }

          if (!delivered || !retry) {
            yield* host.session.synthetic({
              delivery: "queue",
              id: SessionMessage.ID.make(recovery.id),
              sessionID,
              text: `Continue the existing Directorate review ${seal.id} after OpenCode reloaded or restarted. Use its saved coverage, child runs and ledger, and finish with directorate_report. Do not start a new seal or extend the deadline.`,
            });
          }

          return {
            out: undefined,
            seal: woken(current, pid, recovery, yield* DateTime.now),
          };
        })
      );
    }
  );

  const sweep = Effect.gen(function* sweep() {
    const shipOwners = yield* recoverShips.pipe(
      recover("ship recovery sweep failed")
    );

    const bound = yield* sessions.boundSeals;
    const now = yield* Clock.currentTimeMillis;

    for (const seal of yield* store.listWithout(reported)) {
      if (seal.reportedAt) {
        reported.add(seal.id);
        continue;
      }

      // After a reload no session is bound yet: recover this instance's reviews, wherever their repository is, and any
      // review of this repository.
      if (
        !(
          bound.has(seal.id) ||
          seal.host === host.location.directory ||
          (myRepo !== null && seal.repo === myRepo)
        )
      ) {
        continue;
      }

      if (now < DateTime.toEpochMillis(seal.deadline) + GRACE_MS) {
        // Another live server's review is not this one's to settle or wake.
        if (!(yield* foreign(seal.pid))) {
          yield* settleChildren(seal).pipe(
            Effect.andThen(
              Effect.gen(function* recoverOwner() {
                if (!shipOwners || seal.ship !== undefined) {
                  return;
                }

                const shipID = shipOwners.get(seal.id);

                if (shipID) {
                  // Older seals stored membership only on the Ship. Retain it even if Ship is stopped later.
                  return yield* sessions.mutate(
                    seal.id,
                    Watchdog.make({}),
                    ({ seal: current }) =>
                      Effect.succeed({
                        out: undefined,
                        seal:
                          current.ship === undefined
                            ? shipped(current, shipID)
                            : undefined,
                      })
                  );
                }

                yield* recoverReview(seal);
              })
            ),
            ignore(`could not recover review ${seal.id}`, "Warn")
          );
        }

        continue;
      }

      yield* autoReport(
        seal.id,
        "the Liaison did not report before lockdown; filed automatically"
      ).pipe(
        ignore(`could not save the deadline report for ${seal.id}`, "Warn")
      );
    }
  });

  yield* sweep.pipe(
    recover("deadline sweep failed"),
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.delay("30 seconds"),
    Effect.forkScoped
  );
});
