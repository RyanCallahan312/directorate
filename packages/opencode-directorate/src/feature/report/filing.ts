// Filing the Directive: directorate_report through its protocol gates, and automatic reporting for abandoned or expired
// reviews. Either way the report is rendered and saved once, and the seal is reported from then on.
import { Clock, DateTime, Effect, Result, Schema } from "effect";

import { failure } from "../../platform/error.ts";
import type { ReviewError } from "../../platform/error.ts";
import { optional, str } from "../../platform/platform.ts";
import type { DefineTool, Host } from "../../platform/platform.ts";
import { Store } from "../../records/records.ts";
import type { Seal } from "../../seal/record.ts";
import {
  changedSinceSeal,
  currentFingerprint,
  locked,
  Sessions,
  writable,
} from "../../seal/seal.ts";
import type { Current } from "../../seal/seal.ts";
import { budget, GRACE_MS, windowOf } from "../../workflow/review/window.ts";
import type { Ledger } from "../ledger/entry.ts";
import { assess } from "./directive.ts";
import type { Freshness } from "./directive.ts";
import {
  coverageGate,
  dossierGate,
  driftGate,
  personnelGate,
  pushesBack,
  seatsGate,
} from "./gates.ts";
import type { Hold } from "./gates.ts";
import { renderReport } from "./render.ts";

/** What changed since the seal; failures to check are reported as unverified, never raised. */
const freshness = (seal: Seal, cur: Result.Result<Current, ReviewError>) =>
  Result.match(cur, {
    onFailure: (e) => Effect.succeed<Freshness>({ unverified: e.message }),
    onSuccess: (c) =>
      c.fingerprint === seal.fingerprint
        ? Effect.succeed<Freshness>({})
        : changedSinceSeal(seal, c).pipe(
            Effect.timeoutOrElse({
              duration: 20_000,
              orElse: () =>
                failure("listing changed files timed out after 20s"),
            }),
            Effect.match({
              onFailure: (e): Freshness => ({
                stale: ["(changes not enumerated)"],
                unverified: e.message,
              }),
              onSuccess: (changed): Freshness => ({
                stale: changed.length ? changed : ["(fingerprint changed)"],
              }),
            })
          ),
  });

/**
 * Renders and saves the report; the seal is reported from then on. Caller holds the seal's lock. `cur` is the freshness
 * check the caller already ran, if any.
 */
export const finalize = Effect.fn("Directorate.finalize")(function* finalize(
  seal: Seal,
  ledger: Ledger,
  opts: {
    approach?: string | undefined;
    synthesis?: string | undefined;
    extraReasons?: readonly string[];
    auto?: boolean;
    cur?: Result.Result<Current, ReviewError>;
  }
) {
  const { stale, unverified } = yield* freshness(
    seal,
    opts.cur ?? (yield* Effect.result(currentFingerprint(seal)))
  );

  const assessed = {
    ...seal,
    freshnessUnverified: unverified,
    staleFiles: stale,
  };

  const { phase } = yield* budget(windowOf(seal));

  const a = assess(assessed, ledger, { stale, unverified }, phase);

  const status = opts.auto && a.status === "complete" ? "partial" : a.status;
  const reasons = [...a.reasons, ...(opts.extraReasons ?? [])];

  const md = renderReport({
    approach: opts.approach,
    ledger,
    reasons,
    seal: assessed,
    status,
    synthesis: opts.synthesis,
  });

  const reported: Seal = {
    ...assessed,
    autoReported: opts.auto || undefined,
    directive: { reasons, status },
    reportedAt: yield* DateTime.now,
  };

  yield* (yield* Store).publish(reported, md);

  return { md, seal: reported };
});

/**
 * Directive filing for this plugin instance. `filed` hears of every seal reported here; `recovered` tells the caller of a
 * review the watchdog woke that the Liaison filed it.
 */
export const registerReport = Effect.fnUntraced(function* registerReport(
  filed: (sealId: string) => void,
  recovered: (seal: Seal, md: string) => Effect.Effect<void, never, Host>
) {
  const store = yield* Store;
  const sessions = yield* Sessions;

  /** Reported, without the Liaison: abandoned for a new review, or past the deadline and its grace period. */
  const autoReport = Effect.fn("Directorate.autoReport")(function* autoReport(
    id: string,
    reason: string,
    abandonedBy?: string
  ) {
    const saved = yield* store.withLock(
      id,
      Effect.gen(function* saved() {
        const seal = yield* store.load(id);

        if (seal.reportedAt) {
          return;
        }

        if (abandonedBy && seal.ownerSession !== abandonedBy) {
          return yield* failure(`Only the owner of ${id} can abandon it.`);
        }

        if (
          !abandonedBy &&
          (yield* Clock.currentTimeMillis) <
            DateTime.toEpochMillis(seal.deadline) + GRACE_MS
        ) {
          return;
        }

        return yield* finalize(
          abandonedBy ? { ...seal, abandoned: true } : seal,
          yield* store.loadLedger(id),
          { auto: true, extraReasons: [reason] }
        );
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
    tool: DefineTool<
      Sessions | Host | Effect.Services<ReturnType<typeof finalize>>
    >
  ) => {
    // Reported: each gate pushes back once per new gap; locked budgets pass every gate.
    tool({
      description:
        "Issue the final Directorate Directive. Protocol gates push back once for each new gap (unread regions, missing Seats, subagents still running, containment drift, unverified entries); calling again proceeds and records the gap. Renders the directive from the dossier: only verified entries become findings. Output the returned markdown verbatim.",
      *execute(input, c) {
        const { md, seal: reported } = yield* locked(
          c,
          input.seal,
          function* issueDirective(seal) {
            // A reported seal shows its saved report to anyone allowed to ask.
            if (seal.reportedAt) {
              return { md: yield* store.readReport(seal.id), seal: undefined };
            }

            yield* writable(seal, c, "directorate_report", true);
            const ledger = yield* store.loadLedger(seal.id);
            const { phase } = yield* budget(windowOf(seal));

            const pushBack = (gates: Seal["gates"], message: string) =>
              store
                .save({ ...seal, gates: { ...seal.gates, ...gates } })
                .pipe(Effect.andThen(failure(message)));

            /** A gate pushes back once for each new id it has not already pushed back on. */
            const once = (gate: Hold) => {
              const remembered = pushesBack(seal, phase, gate);

              return remembered
                ? pushBack(remembered, gate.message)
                : Effect.void;
            };

            yield* once(coverageGate(seal));
            yield* once(seatsGate(seal, phase));
            yield* once(personnelGate(seal));
            const cur = yield* Effect.result(currentFingerprint(seal));

            const drift = Result.isSuccess(cur)
              ? driftGate(
                  seal,
                  phase,
                  cur.success.fingerprint,
                  cur.success.unfetched
                )
              : undefined;

            if (Result.isSuccess(cur) && drift) {
              return yield* pushBack(
                { freshness: cur.success.fingerprint },
                drift
              );
            }

            yield* once(dossierGate(ledger));

            return yield* finalize(seal, ledger, {
              approach: input.approach,
              cur,
              synthesis: input.synthesis,
            });
          }
        );

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
      name: "directorate_report",
    });
  };

  return { autoReport, reportTool };
});
