// The Directive: the protocol gates and the report they let through. The slice's entry: filing the report.
// shortcut: only finalize; Phase 3 moves directorate_report, its five gates, and autoReport here.
import { DateTime, Effect, Result } from "effect";

import { failure } from "../../platform/error.ts";
import type { ReviewError } from "../../platform/error.ts";
import { Store } from "../../records/records.ts";
import type { Seal } from "../../seal/record.ts";
import { changedSinceSeal, currentFingerprint } from "../../seal/seal.ts";
import type { Current } from "../../seal/seal.ts";
import { budget } from "../../workflow/review/window.ts";
import type { Ledger } from "../ledger/entry.ts";
import { assess } from "./directive.ts";
import type { Freshness } from "./directive.ts";
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

  const { phase } = yield* budget(seal);

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
