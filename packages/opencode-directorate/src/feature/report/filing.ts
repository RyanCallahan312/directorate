// Filing the Directive: directorate_report through its protocol gates, and automatic reporting for abandoned or expired
// reviews. Either way the report is rendered and saved once, and the seal is reported from then on.
import { Clock, DateTime, Effect, Result, Schema } from "effect";

import type { SessionId } from "../../platform/host-id.ts";
import { actor, optional, str } from "../../platform/platform.ts";
import type { DefineTool, Host } from "../../platform/platform.ts";
import { Records, sealIdOf } from "../../records/records.ts";
import { Seal } from "../../seal/record.ts";
import type { SealId } from "../../seal/seal-id.ts";
import {
  AutoReport,
  changesSinceSeal,
  currentFingerprint,
  FreshnessUnchecked,
  Sessions,
  ToolCall,
} from "../../seal/seal.ts";
import type { Current } from "../../seal/seal.ts";
import { abandoned, AbandonRefused } from "../../workflow/review/custody.ts";
import { budget, GRACE_MS } from "../../workflow/review/window.ts";
import { Liaison } from "../agents/agent.ts";
import type { Ledger } from "../ledger/entry.ts";
import {
  assess,
  Directive,
  directiveFiled,
  freshnessChecked,
  isComplete,
  pushedBack,
} from "./directive.ts";
import type { Freshness } from "./directive.ts";
import { heldAfterFreshness, heldBeforeFreshness } from "./gates.ts";
import { renderReport, ReportSchema } from "./render.ts";

/** A freshness check's outcome: the target's current ends, or why they could not be told. */
type CurrentCheck = Result.Result<
  Current,
  Effect.Error<ReturnType<typeof currentFingerprint>>
>;

/** How a Directive is filed: with the Liaison's prose, or unattended (`auto`) with the reasons it was filed without it. */
const FilingSchema = Schema.Struct({
  approach: ReportSchema.fields.approach,
  auto: Schema.optionalKey(Schema.Boolean),
  extraReasons: Schema.optionalKey(Schema.Array(Schema.String)),
  synthesis: ReportSchema.fields.synthesis,
});

/** What directorate_report answers: the report, and the seal it reported now (none if the seal was reported before). */
const ReportedSchema = Schema.Struct({
  md: Schema.String,
  seal: Schema.UndefinedOr(Seal),
});

/** A protocol gate pushes back: the Liaison reads why, and calling again proceeds. */
class ProtocolHold extends Schema.TaggedError<
  ProtocolHold,
  { readonly brand: unique symbol }
>()("ProtocolHold", { message: Schema.String }) {}

/** What changed since the seal; failures to check are reported as unverified, never raised. */
const freshness = (seal: Seal, cur: CurrentCheck) =>
  Result.match(cur, {
    onFailure: (e) => Effect.succeed<Freshness>({ unverified: e.message }),
    onSuccess: (c) =>
      c.fingerprint === seal.fingerprint
        ? Effect.succeed<Freshness>({})
        : changesSinceSeal(seal, c).pipe(
            Effect.timeoutOrElse({
              duration: 20_000,
              orElse: () =>
                Effect.fail(
                  new FreshnessUnchecked({
                    message: "listing changed files timed out after 20s",
                  })
                ),
            }),
            Effect.match({
              onFailure: (e): Freshness => ({
                stale: ["(changes not enumerated)"],
                unverified: e.message,
              }),
              onSuccess: ({ listed }): Freshness => ({
                stale: listed.length ? listed : ["(fingerprint changed)"],
              }),
            })
          ),
  });

/**
 * Renders the report and the reported seal, for the door to save together; the seal is reported from then on. `cur` is
 * the freshness check the caller already ran, if any.
 */
export const finalize = Effect.fn("Directorate.finalize")(function* finalize(
  seal: Seal,
  ledger: Ledger,
  opts: typeof FilingSchema.Type,
  cur?: CurrentCheck
) {
  const { stale, unverified } = yield* freshness(
    seal,
    cur ?? (yield* Effect.result(currentFingerprint(seal)))
  );

  const assessed = freshnessChecked(seal, { stale, unverified });
  const { phase } = yield* budget(seal.window);

  const a = assess(assessed, ledger, { stale, unverified }, phase);

  const status = opts.auto && isComplete(a.status) ? "partial" : a.status;
  const reasons = [...a.reasons, ...(opts.extraReasons ?? [])];

  const md = renderReport({
    approach: opts.approach,
    ledger,
    reasons,
    seal: assessed,
    status,
    synthesis: opts.synthesis,
  });

  const reported = directiveFiled(
    assessed,
    Directive.make({ reasons, status }),
    yield* DateTime.now,
    opts.auto
  );

  return { md, seal: reported };
});

/**
 * Directive filing for this plugin instance. `filed` hears of every seal reported here; `recovered` tells the caller of a
 * review the watchdog woke that the Liaison filed it.
 */
export const registerReport = Effect.fnUntraced(function* registerReport(
  filed: (sealId: SealId) => void,
  recovered: (seal: Seal, md: string) => Effect.Effect<void, never, Host>
) {
  const store = yield* Records;
  const sessions = yield* Sessions;

  /** Reported, without the Liaison: abandoned for a new review, or past the deadline and its grace period. */
  const autoReport = Effect.fn("Directorate.autoReport")(function* autoReport(
    id: SealId,
    reason: string,
    abandonedBy?: SessionId
  ) {
    const saved = yield* sessions.mutate(id, AutoReport.make({}), (review) =>
      Effect.gen(function* fileUnattended() {
        const { seal } = review;

        if (abandonedBy && seal.ownerSession !== abandonedBy) {
          return yield* new AbandonRefused({ seal: id });
        }

        if (
          !abandonedBy &&
          (yield* Clock.currentTimeMillis) <
            DateTime.toEpochMillis(seal.deadline) + GRACE_MS
        ) {
          return { out: undefined };
        }

        const directive = yield* finalize(
          abandonedBy ? abandoned(seal) : seal,
          yield* review.ledger,
          { auto: true, extraReasons: [reason] }
        );

        return { out: directive, report: directive.md, seal: directive.seal };
      })
    );

    if (!saved) {
      return;
    }

    filed(saved.seal.id);
    yield* sessions.close(saved.seal);
    yield* sessions.notify(
      saved.seal,
      `The Directorate <intervened/filed> the directive for ${id} (${reason}):\n\n${saved.md}`
    );
  });

  const reportTool = (
    tool: DefineTool<Host | Effect.Services<ReturnType<typeof finalize>>>
  ) => {
    // Reported: each gate pushes back once per new gap; locked budgets pass every gate.
    tool({
      description:
        "Issue the final Directorate Directive. Protocol gates push back once for each new gap (unread regions, missing Seats, subagents still running, containment drift, unverified entries); calling again proceeds and records the gap. Renders the directive from the dossier: only verified entries become findings. Output the returned markdown verbatim.",
      *execute(input, c, name) {
        const filing = yield* sessions.mutate(
          yield* sealIdOf(input.seal, "door"),
          ToolCall.make({
            actor: actor(c),
            callers: "owner",
            lockdown: "exempt",
            reported: "shown",
            tool: name,
          }),
          (review) =>
            Effect.gen(function* issueDirective() {
              const { seal } = review;

              // A reported seal shows its saved report to anyone allowed to ask.
              if (seal.reportedAt) {
                return {
                  out: Result.succeed({
                    md: yield* store.readReport(seal.id),
                    seal: undefined,
                  }),
                };
              }

              const ledger = yield* review.ledger;
              const { phase } = yield* budget(seal.window);

              /** The gate's gaps are remembered on the seal; the Liaison reads why, and calling again proceeds. */
              const pushBack = ({
                message,
                remembered,
              }: NonNullable<ReturnType<typeof heldBeforeFreshness>>) => ({
                out: Result.fail(new ProtocolHold({ message })),
                seal: pushedBack(seal, remembered),
              });

              const held = heldBeforeFreshness(seal, phase);

              if (held) {
                return pushBack(held);
              }

              const cur = yield* Effect.result(currentFingerprint(seal));

              const heldAfter = heldAfterFreshness(
                seal,
                ledger,
                phase,
                Result.isSuccess(cur) ? cur.success : undefined
              );

              if (heldAfter) {
                return pushBack(heldAfter);
              }

              const reported = yield* finalize(
                seal,
                ledger,
                { approach: input.approach, synthesis: input.synthesis },
                cur
              );

              return {
                out: Result.succeed(reported),
                report: reported.md,
                seal: reported.seal,
              };
            })
        );

        const { md, seal: reported } = yield* Effect.fromResult<
          typeof ReportedSchema.Type,
          ProtocolHold
        >(filing);

        if (reported) {
          filed(reported.id);
          yield* sessions.close(reported);

          if (reported.recovery?.ownerSession === reported.ownerSession) {
            yield* recovered(reported, md);
          }
        }

        return { content: md };
      },
      input: Schema.Struct({
        approach: optional(
          str.annotate({
            description:
              "1–3 sentences: does the overall approach fit the goal?",
          })
        ),
        seal: str,
        synthesis: optional(
          str.annotate({
            description:
              "Optional: shared root causes, how fixes interact, order of work. No new claims.",
          })
        ),
      }),
      lockdown: [Liaison],
      name: "directorate_report",
    });
  };

  return { autoReport, reportTool };
});
