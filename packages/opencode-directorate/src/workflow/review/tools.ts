// Opening and refreshing a review: directorate_seal (started fresh, resumed from another session, a re-check, or restarted
// by abandoning) and directorate_refresh, and what each tells the Liaison.
import { DateTime, Effect, Schema, Semaphore } from "effect";

import { seatName } from "../../feature/dispatch/lifecycle.ts";
import { ModelRef } from "../../feature/dispatch/seat.ts";
import { currentSeverity, unresolved } from "../../feature/ledger/decide.ts";
import type { registerReport } from "../../feature/report/report.ts";
import { resolve } from "../../feature/settings/file.ts";
import { SettingsStore } from "../../feature/settings/settings.ts";
import { ignore } from "../../platform/error.ts";
import {
  actor,
  Host,
  optional,
  ProcessIdentity,
  str,
} from "../../platform/platform.ts";
import type { DefineTool } from "../../platform/platform.ts";
import { Records } from "../../records/records.ts";
import { coverageSummary } from "../../seal/coverage.ts";
import type { Seal } from "../../seal/record.ts";
import {
  done,
  RepoScope,
  Sessions,
  Takeover,
  ToolCall,
} from "../../seal/seal.ts";
import { TargetKindSchema } from "../../seal/target.ts";
import { AbandonRefused, resumedBy } from "./custody.ts";
import {
  createSeal,
  recheckable,
  recheckSeal,
  refreshSeal,
  ReviewConflict,
} from "./lifecycle.ts";
import {
  DEFAULT_REVIEW_SCOPE,
  InvalidRequest,
  ModeSchema,
  REVIEW_SCOPE_TARGET,
  ReviewScopeSchema,
} from "./request.ts";
import type { ReviewScope } from "./request.ts";
import { budget, BudgetMinutesSchema, restarted, Window } from "./window.ts";

/** directorate_seal options a re-check takes from the review it follows, so a caller may not pass them. */
const RECHECK_FIXED = [
  "resume",
  "ship",
  "scope",
  "target",
  "mode",
  "panel",
  "panel_models",
  "repo",
] as const;

/** What a new seal tells the Liaison: its ends, the changed files and their regions, and what to do next. */
const sealSummary = (seal: Seal) => {
  const changedFiles = seal.files.filter((f) => f.status !== "unchanged");
  const regionIds = Map.groupBy(seal.regions, (r) => r.file);

  const rows = changedFiles.slice(0, 300).map(
    (f) =>
      `| ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ""} | ${f.status} | +${f.added} −${f.removed} | ${
        regionIds
          .get(f.path)
          ?.map((r) => r.id)
          .join(" ") || "—"
      } | ${f.excluded ?? ""} |`
  );

  const unchanged = seal.files.length - changedFiles.length;

  return [
    `Containment sealed \`${seal.id}\`: ${seal.description}.`,
    `base ${seal.baseSha.slice(0, 12)} · head ${seal.postImage === "commit" ? seal.headSha.slice(0, 12) : "working tree (snapshotted)"} · ${seal.files.length} files · ${seal.regions.length} regions · budget ${seal.budgetMinutes} min.`,
    seal.lensesOff
      ? `Lenses disabled by directorate.json: ${seal.lensesOff.join(", ")}. Do not assign them; entries under them are rejected.`
      : undefined,
    seal.panel && seal.regions.length
      ? `Directorate Seats (${seal.panel.length}): ${seal.panel.map(seatName).join(", ")}. Convene ${seal.panel.length} directorate_seat subagents now, in one turn, without a model: The Directorate assigns each launch the next open seat's model.`
      : undefined,
    "",
    "| File | Status | Lines | Regions | Excluded |",
    "|---|---|---|---|---|",
    ...rows,
    changedFiles.length > rows.length
      ? `| … ${changedFiles.length - rows.length} more files | | | | |`
      : undefined,
    unchanged
      ? `\n${unchanged} unchanged files in scope (whole-file regions; directorate_ls lists them).`
      : undefined,
    "",
    seal.regions.length
      ? "Next: read every region with directorate_diff (call it with only the seal to get the next unread chunk)."
      : "Nothing to review in this target. Inform the requester, or seal a different target.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
};

/** What a re-check seal tells the Liaison: what changed, which carried findings to re-decide, and what was left open. */
const recheckSummary = (
  earlier: Seal,
  r: Effect.Success<ReturnType<typeof recheckSeal>>
) => {
  const cov = coverageSummary(r.seal);

  const carried = (ids: readonly string[]) =>
    r.ledger.entries
      .filter((e) => ids.includes(e.id))
      .map(
        (e) =>
          `- ${e.id} (${currentSeverity(e)}, ${e.carried?.id} in the earlier review) ${e.title}`
      )
      .join("\n");

  return [
    `Containment sealed \`${r.seal.id}\`, a re-check of \`${earlier.id}\` (${r.seal.mode}): ${r.seal.description}.`,
    `base ${r.seal.baseSha.slice(0, 12)} · head ${r.seal.postImage === "commit" ? r.seal.headSha.slice(0, 12) : "working tree (snapshotted)"} · ${r.seal.regions.length} regions, ${cov.read} already read in the earlier review and unchanged · ${cov.unread.length} to read · budget ${r.seal.budgetMinutes} min.`,
    earlier.panel
      ? "The earlier review had a panel; a re-check runs without Directorate Seats."
      : undefined,
    r.seal.lensesOff
      ? `Lenses disabled by directorate.json: ${r.seal.lensesOff.join(", ")}. Do not assign them; entries under them are rejected.`
      : undefined,
    "",
    r.files.length
      ? `Changed since the earlier review: ${r.files.join(", ")}`
      : "Nothing changed since the earlier review: its findings stand unless a change elsewhere fixes one.",
    r.reopened.length
      ? `\nReopened for re-decision (route to directorate_compliance):\n${carried(r.reopened)}`
      : undefined,
    r.kept.length
      ? `\nStill confirmed (nothing they rest on changed; route one to directorate_compliance only if a change elsewhere may fix it):\n${carried(r.kept)}`
      : undefined,
    r.unanswered.length
      ? `\nUnanswered in the earlier review (answer them if the change touched them, else note them again):\n${r.unanswered.map((t) => `- ${t}`).join("\n")}`
      : undefined,
    "",
    "Next: read the unread regions with directorate_diff, look for new defects only in code changed since the earlier review, and route the reopened findings to directorate_compliance: confirmed (re-anchored) if still present, resolved with the fixing lines if fixed, refuted if it never held.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
};

/** Files a review without its Liaison: abandoned for a new one, or past its deadline. */
export type AutoReporter = Effect.Success<
  ReturnType<typeof registerReport>
>["autoReport"];

type SealServices =
  | Sessions
  | Effect.Services<ReturnType<typeof createSeal>>
  | Effect.Services<ReturnType<typeof recheckSeal>>
  | Effect.Services<ReturnType<typeof refreshSeal>>
  | Effect.Services<ReturnType<AutoReporter>>;

/** directorate_seal and directorate_refresh. `sealed` hands each new seal to the ship loop, which may own it. */
export const reviewTools = Effect.fnUntraced(function* reviewTools(
  autoReport: AutoReporter,
  sealed: (
    seal: Seal,
    shipID?: string,
    scope?: ReviewScope
  ) => Effect.Effect<void, Error>
) {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const store = yield* Records;
  const settings = yield* SettingsStore;
  const { pid } = yield* ProcessIdentity;

  /** One seal start at a time per session, so two starts can't both find no active seal and each seal one. */
  const starting = new Map<string, Semaphore.Semaphore>();

  const startLock = (session: string) => {
    const lock = starting.get(session) ?? Semaphore.makeUnsafe(1);
    starting.set(session, lock);

    return lock;
  };

  return (tool: DefineTool<SealServices>) => {
    // Sealed: one review per session, started fresh, resumed from another session, or restarted by abandoning.
    tool({
      description:
        "Start a Directorate review: pin the target in containment and start the time budget. Pass scope or a specific target, not both. Omit both to use the configured default scope (branch if unset). target.kind auto = local changes plus any commits on this branch beyond the default branch. Also: local, commit, range (base may be @default), pr, paths (no paths = whole repository). Returns the seal id every other directorate_* tool needs. resume takes over an interrupted review. panel convenes independent whole-change reviews by several models (Directorate Seats), combined in one Directive.",
      *execute(input, c) {
        if (!input.resume && input.scope && input.target) {
          return yield* new InvalidRequest({
            message: "Pass either scope or target, not both.",
          });
        }

        if (
          input.recheck &&
          RECHECK_FIXED.some((key) => input[key] !== undefined)
        ) {
          return yield* new InvalidRequest({
            message:
              "A re-check reuses the earlier review's target and mode, without a panel. Pass recheck with only budget_minutes, question, or abandon.",
          });
        }

        const a = actor(c);

        return yield* startLock(a.session).withPermit(
          Effect.gen(function* start() {
            // Checked before abandoning, so a bad re-check target never files the active review.
            const earlier = input.recheck
              ? yield* store.load(input.recheck)
              : undefined;

            if (earlier) {
              yield* recheckable(earlier);
            }

            const prior = yield* sessions.active(a.session);

            const replaced =
              prior && prior.id !== input.resume ? prior : undefined;

            if (replaced) {
              if (!input.abandon) {
                return yield* new ReviewConflict({
                  message: `This session already holds an active containment seal ${replaced.id}. Close it with directorate_report, or pass abandon: true to file its partial directive and start over.`,
                });
              }

              if (replaced.ownerSession !== a.session) {
                return yield* new AbandonRefused({ seal: replaced.id });
              }
            }

            // Filed only once the new review is open, so a target that can't be sealed keeps the active review; before binding, as closing it clears this session's record.
            const abandonPrior = replaced
              ? autoReport(replaced.id, "abandoned for a new review", a.session)
              : Effect.void;

            if (earlier) {
              const r = yield* recheckSeal({
                budgetMinutes: input.budget_minutes,
                ledger: yield* store.loadLedger(earlier.id),
                owner: a,
                prior: earlier,
                question: input.question,
              });

              yield* abandonPrior;
              yield* sessions.bind(a.session, r.seal.id);
              yield* sessions.record(a.session, r.seal);
              yield* sealed(r.seal);

              return yield* done(r.seal, recheckSummary(earlier, r));
            }

            if (input.resume) {
              const { resume } = input;

              const { seal, previousOwner } = yield* sessions.mutate(
                resume,
                Takeover.make({ actor: a }),
                (review) =>
                  Effect.gen(function* openContainment() {
                    const s = review.seal;

                    if (s.reportedAt) {
                      return yield* new ReviewConflict({
                        message: `${s.id} was already reported; directorate_report with this seal shows the saved directive. To re-check it after fixes, pass recheck: "${s.id}" instead.`,
                      });
                    }

                    // A spent budget gets more time (Window.takeover), unless the caller names a budget.
                    const now = yield* DateTime.now;
                    const { window } = s;
                    const { phase } = yield* budget(window);

                    const takeover =
                      s.ownerSession === a.session || phase === "normal"
                        ? undefined
                        : window.takeover(now);

                    const restart =
                      input.budget_minutes === undefined
                        ? takeover
                        : Window.open(now, input.budget_minutes);

                    const resumed = resumedBy(s, a, pid, now);

                    const updated =
                      restart === undefined
                        ? resumed
                        : restarted(resumed, restart);

                    return {
                      out: { previousOwner: s.ownerSession, seal: updated },
                      seal: updated,
                    };
                  })
              );

              yield* abandonPrior;
              yield* sessions.takeOver(seal, previousOwner);
              const cov = coverageSummary(seal);

              return yield* done(
                seal,
                `Resumed containment \`${seal.id}\` (${seal.mode}): ${seal.description}. Observed ${cov.read}/${cov.total}; ${unresolved(yield* store.loadLedger(seal.id)).length} entries unresolved. Continue where it stopped: directorate_diff for unread regions, directorate_ledger_list for entries.`
              );
            }

            const repo =
              input.repo ||
              (yield* sessions.directory(a.session)) ||
              host.location.directory;

            yield* store.gc().pipe(ignore("old seal cleanup failed", "Warn"));
            const configured = (yield* settings.load(repo)).effective;

            const { mode, panel, budgetMinutes, lensesOff } = resolve(
              configured,
              {
                budgetMinutes: input.budget_minutes,
                mode: input.mode,
                panel: input.panel,
                panelModels: input.panel_models,
              }
            );

            const seal = yield* createSeal({
              budgetMinutes,
              lensesOff,
              mode,
              owner: a,
              panel,
              question: input.question,
              repo,
              target: input.target ?? {
                kind: REVIEW_SCOPE_TARGET[
                  input.scope ??
                    configured.default_scope ??
                    DEFAULT_REVIEW_SCOPE
                ],
              },
            });

            yield* abandonPrior;
            yield* sessions.bind(a.session, seal.id);
            yield* sessions.record(a.session, seal);

            if (input.ship) {
              yield* sealed(seal, input.ship, input.scope);
            }

            return yield* done(seal, sealSummary(seal));
          })
        );
      },
      input: Schema.Struct({
        abandon: optional(
          Schema.Boolean.annotate({
            description:
              "Close this session's unreported review (its partial report is saved) and seal a new one.",
          })
        ),
        budget_minutes: optional(BudgetMinutesSchema),
        mode: optional(
          ModeSchema.annotate({
            description:
              "Omit to use the configured default (directorate.json), else default.",
          })
        ),
        panel: optional(
          Schema.Boolean.annotate({
            description:
              "Panel review: several models (Directorate Seats) each review the whole change independently. true when the user asks for a panel or several models, false when they ask for one model; omit to use the configured default.",
          })
        ),
        panel_models: optional(
          Schema.Array(ModelRef).annotate({
            description:
              "The panel's models, only when the user names them (implies panel).",
          })
        ),
        question: optional(
          str.annotate({
            description: "The user's focus, if any; shown in the report.",
          })
        ),
        recheck: optional(
          str.annotate({
            description:
              "Seal id of a reported review to re-check after fixes: seals its target as it is now, keeps what was read in unchanged regions, and carries its findings for re-decision. Takes no target, scope, mode, or panel.",
          })
        ),
        repo: optional(
          str.annotate({
            description:
              "Repository directory; defaults to the session's directory.",
          })
        ),
        resume: optional(
          str.annotate({
            description:
              "Seal id of an unreported review to take over instead of sealing a new one.",
          })
        ),
        scope: optional(ReviewScopeSchema),
        ship: optional(
          str.annotate({
            description:
              "Only for an initial /directorate-ship review: copy the ship ID from the calling session. Omit on other reviews and re-checks.",
          })
        ),
        target: optional(
          Schema.Struct({
            base: optional(str),
            commit: optional(str),
            head: optional(str),
            kind: TargetKindSchema,
            paths: optional(
              Schema.Array(RepoScope).annotate({
                description:
                  "Literal file or directory restrictions, supported only by local and paths targets.",
              })
            ),
            pr: optional(str),
          })
        ),
      }),
      name: "directorate_seal",
    });

    // Refreshed: the code moved after the seal; the target is re-pinned once.
    tool({
      description:
        "After directorate_report's freshness gate (Containment Drift): re-pin the target once and re-capture it (diff, snapshot, regions); regions whose content is unchanged keep their read receipts, and entries whose anchor or evidence changed reopen for re-verification.",
      *execute(input, c) {
        return yield* sessions.mutate(
          input.seal,
          ToolCall.make({
            actor: actor(c),
            callers: "owner",
            tool: "directorate_refresh",
          }),
          (review) =>
            Effect.gen(function* execute() {
              const { seal } = review;

              if (seal.refreshes >= 1) {
                return yield* new ReviewConflict({
                  message:
                    "This seal was already re-contained once. Call directorate_report; it marks the directive stale if the artifact moved again.",
                });
              }

              const r = yield* refreshSeal(seal, yield* review.ledger);

              if (r.seal === seal) {
                return {
                  out: yield* done(
                    seal,
                    "No drift detected since containment."
                  ),
                };
              }

              return {
                ledger: r.ledger,
                out: yield* done(
                  r.seal,
                  `Re-contained. Changed: ${r.files.join(", ") || "none"}. Regions to read: ${r.newRegions.map((x) => x.id).join(" ") || "none"}. Reopened for re-verification: ${r.reopened.join(" ") || "none"}.`
                ),
                seal: r.seal,
              };
            })
        );
      },
      input: Schema.Struct({ seal: str }),
      name: "directorate_refresh",
    });
  };
});
