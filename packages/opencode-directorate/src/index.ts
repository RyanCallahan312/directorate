// The Directorate: the review workflow, as its state chart. A Liaison session seals a target (directorate_seal), works
// through the budget's phases (normal → drain → locked), and leaves through directorate_report's protocol gates, or
// the deadline watchdog reports for it. Auditors, Seats, and Compliance run beside it: launching → running → completed | failed.
// Tools used inside a state are in read-tools.ts and ledger-tools.ts; the state itself is the seal (store.ts).
import { Plugin } from "@opencode/plugin/effect";
import {
  Clock,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Result,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import { budget, budgetNotice } from "./budget.ts";
import { registerBundled } from "./bundled.ts";
import {
  childName,
  childOutstanding,
  claimed,
  enqueued,
  finished,
  followUpPrompt,
  inboxSettled,
  launchTitle,
  launched,
  openSeat,
  missingSeats,
  resumed,
  returned,
  seatName,
} from "./children.ts";
import { configureRpc, configureTool } from "./configure.ts";
import { coverageSummary } from "./coverage.ts";
import { failure, ignore, recover } from "./error.ts";
import { exportReview, listExportReviews } from "./export.ts";
import { Git } from "./git.ts";
import { ledgerTools } from "./ledger-tools.ts";
import { currentSeverity, unresolved } from "./ledger.ts";
import {
  CHILD_ROLE_SET,
  CHILD_ROLES,
  DEFAULT_REVIEW_SCOPE,
  ModeSchema,
  ModelRef,
  PANELIST,
  REFUTER,
  RepoScope,
  REVIEW_SCOPE_TARGET,
  REVIEWER,
  ReviewScopeSchema,
  ROLE_SET,
  TargetKindSchema,
} from "./model.ts";
import type { Child, Seal } from "./model.ts";
import { platformLayer } from "./platform.ts";
import { readTools } from "./read-tools.ts";
import { finalize } from "./report.ts";
import { createSeal, recheckable, recheckSeal, refreshSeal } from "./seal.ts";
import { Host, Sessions } from "./session.ts";
import { describe, resolve, SettingsStore } from "./settings.ts";
import { Store } from "./store.ts";
import { currentFingerprint } from "./target.ts";
import {
  actor,
  adapter,
  done,
  locked,
  LOCKED_TOOLS,
  mutate,
  optional,
  str,
  writable,
} from "./tool.ts";

/** How long after the deadline the watchdog waits for the Liaison's own report. */
const GRACE_MS = 120_000;

const GENERAL_TOOLS = new Set([
  "directorate_configure",
  "directorate_export",
  "directorate_export_list",
]);

/** Why another agent may not use the review harness: the Liaison runs the whole review, so callers dispatch it. */
const LIAISON_ONLY =
  "Only directorate_liaison runs a Directorate review: it seals, reads, dispatches its own Auditors, Seats, and Compliance, and returns the Directive. Dispatch directorate_liaison with the target and focus, and relay its Directive verbatim. If you already dispatched one, send the follow-up to that session instead of starting another. To re-check after fixes, send that session a follow-up asking for a re-check, or dispatch a new Liaison with the seal id from the Directive's Containment line.";

/** An Auditor, Seat, or Compliance launch, as the subagent tool's input; with a sessionID it continues an existing child. */
const decodeAssignment = Schema.decodeUnknownOption(
  Schema.Struct({
    agent: Schema.Literals(CHILD_ROLES),
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

/** directorate_seal options a re-check takes from the review it follows, so a caller may not pass them. */
const RECHECK_FIXED = [
  "resume",
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

/** One per child session (its latest run), since a follow-up joined to a running child shares its session. */
const perSession = (runs: readonly Child[]) => [
  ...new Map(runs.map((x) => [x.session ?? x.call, x])).values(),
];

const register = Effect.fn("Directorate.register")(function* register() {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const store = yield* Store;
  const settings = yield* SettingsStore;
  const { hook, tools } = yield* adapter;

  const myRepo = yield* (yield* Git)
    .root(host.location.directory)
    .pipe(Effect.orElseSucceed(() => null));

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

    yield* sessions.close(saved.seal);
    yield* sessions.notify(
      saved.seal,
      `The Directorate <intervened/filed> the directive for ${id} (${reason}):\n\n${saved.md}`
    );
  });

  yield* registerBundled();
  yield* configureRpc();
  yield* host.command.transform((editor) => {
    editor.add({
      description:
        "Export full, unredacted Directorate reviews [seal ID or request in plain language]",
      execute: ({ delivery, prompt, sessionID }) =>
        host.session
          .prompt({
            ...prompt,
            delivery,
            sessionID,
            text: [
              "Handle the user's Directorate export request below. If it names a seal ID, use it directly. Otherwise call directorate_export_list to find retained reviews in the current project. For a blank request, use activeSeal or the first (newest) review. For a range or other selection, use the listing's UTC clock and review metadata, following nextBefore until all applicable pages have been checked. For time ranges use reportedAt when present, otherwise createdAt; interpret 'in the last month' as the rolling last 30 days unless the user specifies a calendar month. Ask if the scope is unclear; never silently broaden it.",
              "Call directorate_export once per matching seal ID. Export existing reviews only; do not start a review. Do not open, attach, or upload the resulting unredacted ZIPs. Report their paths and any missing data or failed exports. If there are no matches, say so; pruned reviews cannot be recovered.",
              `User's request:\n${prompt.text}`,
            ].join("\n\n"),
          })
          .pipe(Effect.asVoid),
      name: "directorate-export",
    });
    editor.add({
      description:
        "Start a Directorate review [request, --scope branch|local|repository, or --recheck <seal>]",
      execute: ({ delivery, prompt, sessionID }) => {
        const again =
          /^\s*--recheck(?=\s|=|$)(?:(?:=|\s+)(?<seal>directorate-\S+))?/u.exec(
            prompt.text
          );

        if (again) {
          const seal = again.groups?.seal;
          const rest = prompt.text.slice(again[0].length).trim();

          if (rest.startsWith("=")) {
            return failure(
              "Use --recheck alone for the latest Directive, or --recheck <seal id> (directorate-…)."
            );
          }

          const which = seal ? `\`${seal}\`` : "the latest Directive";

          return host.session
            .prompt({
              ...prompt,
              delivery,
              sessionID,
              text: [
                rest,
                `Re-check ${which} after fixes${rest ? `, with the request above as its focus` : ""}. If you dispatched the directorate_liaison that issued it in this conversation, send that session a follow-up asking for the re-check. Otherwise dispatch directorate_liaison to re-check it: ${seal ? `tell it to pass recheck: "${seal}" to directorate_seal` : "it finds the latest reported seal with directorate_ledger_list and passes it as recheck to directorate_seal"}. Wait for the Liaison and relay its final Directive verbatim. Do not run the review yourself.`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            })
            .pipe(Effect.asVoid);
        }

        const flag = /^\s*--scope(?=\s|=|$)(?:(?:=|\s+)(?<value>\S+))?/u.exec(
          prompt.text
        );

        const scope = flag?.groups?.value;

        if (flag && !Schema.is(ReviewScopeSchema)(scope)) {
          return failure(
            "Use --scope branch, --scope local, or --scope repository."
          );
        }

        const hasRequest = prompt.text.trim().length > 0;

        return host.session
          .prompt({
            ...prompt,
            delivery,
            sessionID,
            text: [
              hasRequest ? prompt.text : "",
              hasRequest
                ? "Start a Directorate code review using the request above. Interpret it as natural language and carry through the requested target, scope, mode, model preferences, time limit, and any focus or constraints. Use configured defaults for details the user didn't specify. Ask only if a missing or conflicting detail prevents you from honoring the request. Do not silently drop a constraint or widen the target."
                : "Start a Directorate code review. Before dispatching, use the question tool to offer the mode (configured default, default, code-quality, or full) and panel preference (configured default, single model, or Directorate Seats). If the user cancels, do not start a review.",
              "Dispatch directorate_liaison with the user's request and any clarified options. Leave configured defaults unset rather than guessing them. Wait for the Liaison and relay its final Directive verbatim. Do not run the review yourself.",
              "Reviewing everything in named files or directories uses a whole-file target (kind: paths, with repository-relative paths), including unchanged files. A request for changes only is a diff review, not a whole-file review.",
              scope
                ? `The --scope flag selects ${scope}. Tell the Liaison to pass scope: "${scope}" to directorate_seal, without a target. If the request also names a conflicting target, ask which to use.`
                : "If no target or scope was requested, do not ask what to review: omit both target and scope so directorate_seal uses the configured default.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          })
          .pipe(Effect.asVoid);
      },
      name: "directorate-review",
    });
  });

  /** One seal start at a time per session, so two starts can't both find no active seal and each seal one. */
  const starting = new Map<string, Semaphore.Semaphore>();

  const startLock = (session: string) => {
    let lock = starting.get(session);

    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      starting.set(session, lock);
    }

    return lock;
  };

  yield* host.tool.transform((editor) => {
    const tool = tools(editor);
    readTools(tool);
    ledgerTools(tool);
    configureTool(tool);

    tool({
      description:
        "List retained Directorate reviews in this project and its registered Git worktrees, newest seal IDs first. Continue with nextBefore. Returns review metadata, not transcripts or source.",
      *execute(input, c) {
        const page = yield* listExportReviews(c.sessionID, input.before);

        return { content: JSON.stringify(page) };
      },
      input: Schema.Struct({ before: optional(str) }),
      name: "directorate_export_list",
    });

    tool({
      description:
        "Write a full, unredacted ZIP for one existing Directorate seal to the local exports directory. Use only when the user requests an export. Returns the saved path and warns of unavailable data; does not upload anything.",
      *execute(input) {
        return { content: yield* exportReview(input.seal) };
      },
      input: Schema.Struct({ seal: str }),
      name: "directorate_export",
    });

    // Sealed: one review per session, started fresh, resumed from another session, or restarted by abandoning.
    tool({
      description:
        "Start a Directorate review: pin the target in containment and start the time budget. Pass scope or a specific target, not both. Omit both to use the configured default scope (branch if unset). target.kind auto = local changes plus any commits on this branch beyond the default branch. Also: local, commit, range (base may be @default), pr, paths (no paths = whole repository). Returns the seal id every other directorate_* tool needs. resume takes over an interrupted review. panel convenes independent whole-change reviews by several models (Directorate Seats), combined in one Directive.",
      *execute(input, c) {
        if (!input.resume && input.scope && input.target) {
          return yield* failure("Pass either scope or target, not both.");
        }

        if (
          input.recheck &&
          RECHECK_FIXED.some((key) => input[key] !== undefined)
        ) {
          return yield* failure(
            "A re-check reuses the earlier review's target and mode, without a panel. Pass recheck with only budget_minutes, question, or abandon."
          );
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
                return yield* failure(
                  `This session already holds an active containment seal ${replaced.id}. Close it with directorate_report, or pass abandon: true to file its partial directive and start over.`
                );
              }

              if (replaced.ownerSession !== a.session) {
                return yield* failure(
                  `Only the owner of ${replaced.id} can abandon it.`
                );
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

              return yield* done(r.seal, recheckSummary(earlier, r));
            }

            if (input.resume) {
              const { resume } = input;

              const { seal, previousOwner } = yield* store.withLock(
                resume,
                Effect.gen(function* openContainment() {
                  const s = yield* store.load(resume);

                  if (s.reportedAt) {
                    return yield* failure(
                      `${s.id} was already reported; directorate_report with this seal shows the saved directive. To re-check it after fixes, pass recheck: "${s.id}" instead.`
                    );
                  }

                  // A spent budget gets more time: half the original, at least 5 minutes, unless the caller names a budget.
                  const now = yield* DateTime.now;

                  const minutes =
                    input.budget_minutes ??
                    (s.ownerSession === a.session ||
                    budget(s, DateTime.toEpochMillis(now)).phase === "normal"
                      ? undefined
                      : Math.max(5, Math.round(s.budgetMinutes / 2)));

                  const taken: Seal =
                    minutes === undefined
                      ? {
                          ...s,
                          owner: a.agent,
                          ownerSession: a.session,
                        }
                      : {
                          ...s,
                          budgetMinutes: minutes,
                          createdAt: now,
                          deadline: DateTime.add(now, { minutes }),
                          owner: a.agent,
                          ownerSession: a.session,
                        };

                  const updated =
                    s.ownerSession && s.ownerSession !== a.session
                      ? {
                          ...taken,
                          previousOwnerSessions: [
                            ...new Set([
                              ...(s.previousOwnerSessions ?? []),
                              s.ownerSession,
                            ]),
                          ],
                        }
                      : taken;

                  yield* store.save(updated);

                  return { previousOwner: s.ownerSession, seal: updated };
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
        budget_minutes: optional(
          Schema.Finite.check(
            Schema.isGreaterThanOrEqualTo(2),
            Schema.isLessThanOrEqualTo(240)
          )
        ),
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
        return yield* mutate(
          c,
          input.seal,
          "directorate_refresh",
          function* execute(seal) {
            if (seal.refreshes >= 1) {
              return yield* failure(
                "This seal was already re-contained once. Call directorate_report; it marks the directive stale if the artifact moved again."
              );
            }

            const r = yield* refreshSeal(
              seal,
              yield* store.loadLedger(seal.id)
            );

            if (r.seal === seal) {
              return yield* done(seal, "No drift detected since containment.");
            }

            return yield* done(
              r.seal,
              `Re-contained. Changed: ${r.files.join(", ") || "none"}. Regions to read: ${r.newRegions.map((x) => x.id).join(" ") || "none"}. Reopened for re-verification: ${r.reopened.join(" ") || "none"}.`
            );
          },
          true
        );
      },
      input: Schema.Struct({ seal: str }),
      name: "directorate_refresh",
    });

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
            const { phase } = budget(seal, yield* Clock.currentTimeMillis);

            const pushBack = (gates: Seal["gates"], message: string) =>
              store
                .save({ ...seal, gates: { ...seal.gates, ...gates } })
                .pipe(Effect.andThen(failure(message)));

            /** A gate pushes back once for each new id it has not already pushed back on. */
            const once = (
              key: "coverage" | "children" | "open" | "panel",
              ids: readonly string[],
              message: string
            ) => {
              const seen = new Set(seal.gates[key]);

              return phase === "locked" || ids.every((id) => seen.has(id))
                ? Effect.void
                : pushBack({ [key]: [...new Set([...seen, ...ids])] }, message);
            };

            const cov = coverageSummary(seal);
            yield* once(
              "coverage",
              cov.unread.map((r) => r.id),
              `Protocol hold (Coverage): ${cov.unread.length} of ${cov.total} regions unread: ${cov.unread
                .slice(0, 40)
                .map((r) => `${r.id} ${r.file}:${r.newStart}-${r.newEnd}`)
                .join(
                  ", "
                )}. Read them with directorate_diff, or record directorate_coverage dispositions. Calling directorate_report again files a <Partial/Incomplete> directive.`
            );
            const missing = missingSeats(seal);
            yield* once(
              "panel",
              missing.map((s) => `${s.model}:${s.runs.length}`),
              `Protocol hold (Seats): ${missing.length} of ${seal.panel?.length ?? 0} Directorate Seats ${missing.some((s) => s.status === "partial") ? "did not finish reading all regions" : "returned no review"}: ${missing.map((s) => `${seatName(s.model)} (${s.status === "partial" ? `${s.unread} regions unread` : s.status})`).join(", ")}. ${phase === "drain" ? "Seats can no longer be launched or continued during drain." : "Continue a partial seat in its existing session or launch a new directorate_seat without a model (The Directorate assigns it); leave a seat that failed twice."} Calling directorate_report again files a partial review.`
            );
            const running = childOutstanding(seal);
            yield* once(
              "children",
              running.map((r) => r.call),
              `Protocol hold (Active Personnel): Still running: ${running.map((r) => `${r.agent} (${r.session ?? r.call})`).join(", ")}. Call directorate_wait to wait for them without ending your turn, then verify their entries. Calling directorate_report again terminates them and marks their questions unanswered.`
            );
            const cur = yield* Effect.result(currentFingerprint(seal));

            if (
              Result.isSuccess(cur) &&
              cur.success.fingerprint !== seal.fingerprint &&
              seal.refreshes < 1 &&
              seal.gates.freshness !== cur.success.fingerprint &&
              phase !== "locked"
            ) {
              return yield* pushBack(
                { freshness: cur.success.fingerprint },
                `Protocol hold (Containment Drift): the artifact changed after sealing${cur.success.unfetched ? ` (${cur.success.unfetched})` : ""}. Call directorate_refresh to re-contain once, read the new regions, and re-verify reopened entries; then call directorate_report again.`
              );
            }

            const open = unresolved(ledger);
            yield* once(
              "open",
              open.map(
                (e) =>
                  `${e.id}:${e.status}:${e.verdicts.length}:${e.history?.length ?? 0}`
              ),
              `Protocol hold (Unverified Dossier): ${open.length} entries are unresolved: ${open.map((e) => `${e.id} (${currentSeverity(e)}, by ${e.raisedBy.agent}${e.status === "duplicate" ? ", duplicate of an unconfirmed entry" : ""})`).join(", ")}. Decide minor Auditor/Seat entries yourself; route the rest to directorate_compliance. Calling directorate_report again renders them as unverified leads.`
            );

            return yield* finalize(seal, ledger, {
              approach: input.approach,
              cur,
              synthesis: input.synthesis,
            });
          }
        );

        if (reported) {
          yield* sessions.close(reported);
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

    // Waiting: the Liaison stays in its turn while its subagents work. Ending the turn instead would hand a calling agent
    // an unfinished review, and leave that agent to finish it. Their handoffs arrive as messages at the next step.
    tool({
      description:
        "Wait, without ending your turn, until one of this review's Auditor, Seat, or Compliance runs finishes or the budget phase changes. Returns who finished, the entries and verdicts each recorded, and who is still running; their handoffs follow as subagent messages. Call it whenever you would otherwise end your turn while they run.",
      *execute(input, c) {
        const start = yield* locked(c, input.seal, function* start(seal) {
          yield* writable(seal, c, "directorate_wait", true);

          return seal;
        });

        const { phase } = budget(start, yield* Clock.currentTimeMillis);
        const waiting = childOutstanding(start);

        if (!waiting.length) {
          return yield* done(
            start,
            "No Auditor, Seat, or Compliance runs are running. Decide or route the open entries, then call directorate_report."
          );
        }

        if (phase === "locked") {
          return yield* done(
            start,
            "The budget is locked: call directorate_report now; it stops the runs still going."
          );
        }

        const ended = (seal: Seal) => {
          const still = new Set(childOutstanding(seal).map((x) => x.call));

          return seal.children.filter(
            (x) => waiting.some((w) => w.call === x.call) && !still.has(x.call)
          );
        };

        // The session events and the deadline watchdog write the seal; poll it until something the Liaison acts on changed.
        const { seal, now } = yield* Effect.all({
          now: Clock.currentTimeMillis,
          seal: store.load(start.id),
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (state) =>
              state.seal.reportedAt !== undefined ||
              budget(state.seal, state.now).phase !== phase ||
              ended(state.seal).length > 0,
          })
        );

        if (seal.reportedAt) {
          return {
            content: `The deadline passed and The Directorate filed the Directive. Output it verbatim:\n\n${yield* store.readReport(seal.id)}`,
          };
        }

        const ledger = yield* store.loadLedger(seal.id);

        /** What this run recorded: a follow-up reports its own round, not the session's earlier ones. */
        const recorded = (x: Child) => {
          const since = (at: DateTime.Utc) =>
            DateTime.toEpochMillis(at) >= DateTime.toEpochMillis(x.startedAt);

          const raised = ledger.entries
            .filter(
              (e) => e.raisedBy.session === x.session && since(e.createdAt)
            )
            .map((e) => e.id);

          const decided = ledger.entries.flatMap((e) =>
            [...(e.history ?? []), ...e.verdicts]
              .values()
              .filter((v) => v.by.session === x.session && since(v.at))
              .map((v) => `${e.id} ${v.verdict}`)
              .toArray()
          );

          return (
            [
              raised.length ? `raised ${raised.join(", ")}` : "",
              decided.length
                ? `decided ${[...new Set(decided)].join(", ")}`
                : "",
            ]
              .filter(Boolean)
              .join("; ") || "recorded nothing"
          );
        };

        const still = perSession(childOutstanding(seal));
        const phaseNow = budget(seal, now).phase;

        const lines = perSession(ended(seal)).map(
          (x) =>
            `- ${childName(x)} ${x.status}${x.session ? ` (${x.session})` : ""}: ${recorded(x)}`
        );

        if (phaseNow === "locked") {
          lines.push(
            "The budget is locked: call directorate_report now; it stops the runs still going."
          );
        } else {
          if (phaseNow !== phase) {
            lines.push(
              `The budget moved to ${phaseNow}; follow the budget line below.`
            );
          }

          lines.push(
            still.length
              ? `Still running (${still.length}): ${still.map((x) => `${childName(x)}${x.session ? ` (${x.session})` : ""}`).join(", ")}. Decide or route what finished, then call directorate_wait again; do not end your turn while any run.`
              : "Nothing else is running. Decide or route the new entries, then call directorate_report."
          );
        }

        return yield* done(seal, lines.join("\n"));
      },
      input: Schema.Struct({ seal: str }),
      name: "directorate_wait",
    });
  });

  // ---------- Auditors, Seats, and Compliance ----------
  // Launching: registered before the child runs, so a fast child is never missed. A completed child calling tools again
  // is running again; check before locking, since most calls change nothing.
  yield* host.tool.hook(
    "execute.before",
    hook("executeBefore", function* onExecuteBefore(ev) {
      if (ev.tool !== "subagent") {
        const id = yield* sessions.boundTo(ev.sessionID);

        if (!id || !CHILD_ROLE_SET.has(ev.agent)) {
          return;
        }

        const seal = yield* store
          .load(id)
          .pipe(Effect.orElseSucceed(() => null));

        if (!seal || !resumed(seal, ev.sessionID)) {
          return;
        }

        yield* sessions
          .update(id, (s) => resumed(s, ev.sessionID))
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
        .update(seal.id, (s) => {
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

            return launched(s, launch);
          }

          const model =
            assignment.agent === PANELIST && !assignment.model
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

          return launched(s, launch);
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
        .update(seal.id, (s) => {
          const launch = s.children.find((x) => x.call === ev.id);

          // Not an Auditor, Seat, or Compliance of this review.
          if (!launch) {
            return;
          }

          // Rejected before it ran: the subagent tool checks permission (drain, lockdown, rules) after this launch
          // registered, so there is no child, and no failure to report.
          if (ev.status === "error" && launch.status === "launching") {
            return {
              ...s,
              children: s.children.filter((x) => x !== launch),
            };
          }

          child = meta.sessionID ?? launch.session;

          return returned(s, ev.id, meta.sessionID, outcome, endedAt);
        })
        .pipe(ignore(`could not record subagent result in ${seal.id}`, "Warn"));

      if (child) {
        yield* sessions.bind(child, seal.id);
      }
    })
  );

  // Running: a child's session is created by the subagent tool before it runs; link it to its launch now, so every later
  // event for it finds the review.
  const claimChild = Effect.fn("Directorate.claimChild")(function* claimChild(
    sessionID: string,
    parentID: string,
    agent: string,
    title: string | undefined
  ) {
    if (!CHILD_ROLE_SET.has(agent)) {
      return;
    }

    const seal = yield* sessions.active(parentID);

    // Reported between launch and link, even if the Liaison has sealed another review since: stop the child, which no
    // review owns now.
    for (const id of yield* sessions.launchesBy(parentID)) {
      if (id === seal?.id) {
        continue;
      }

      const reported = yield* store
        .load(id)
        .pipe(Effect.orElseSucceed(() => null));

      if (reported?.reportedAt && claimed(reported, sessionID, agent, title)) {
        yield* sessions.interrupt(sessionID);

        return;
      }
    }

    if (!seal || seal.ownerSession !== parentID) {
      return;
    }

    let linked = false;
    yield* sessions
      .update(seal.id, (s) => {
        const next = claimed(s, sessionID, agent, title);
        linked =
          next !== undefined || s.children.some((c) => c.session === sessionID);

        return next;
      })
      .pipe(
        ignore(`could not link ${agent} ${sessionID} to ${seal.id}`, "Warn")
      );

    if (linked) {
      yield* sessions.bind(sessionID, seal.id);
    }
  });

  const childEvent = Effect.fn("Directorate.childEvent")(function* childEvent(
    sessionID: string,
    change: (s: Seal) => Seal | undefined
  ) {
    const id =
      (yield* sessions.boundTo(sessionID)) ??
      (yield* sessions.active(sessionID))?.id;

    if (!id) {
      return;
    }

    yield* sessions
      .update(id, change)
      .pipe(ignore(`could not update ${sessionID} in ${id}`, "Warn"));
  });

  // One consumer, in event order: a child's session.created is always handled before its terminal events.
  yield* Stream.suspend(() =>
    host.event.subscribe({
      types: [
        "session.created",
        "session.inbox.enqueued",
        "session.inbox.delivered",
        "session.inbox.cancelled",
        "session.idle",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
      ],
    })
  ).pipe(
    Stream.runForEach((event) => {
      const { sessionID } = event.data;

      if (event.type === "session.created") {
        return event.data.parentID
          ? claimChild(
              event.data.sessionID,
              event.data.parentID,
              String(event.data.agent ?? ""),
              event.data.title
            )
          : Effect.void;
      }

      if (event.type === "session.inbox.enqueued") {
        const { inboxID, item } = event.data;

        return item.type === "user" &&
          item.payload.text.includes("\n\n[Directorate follow-up: ")
          ? childEvent(sessionID, (s) =>
              enqueued(s, sessionID, inboxID, item.payload.text)
            )
          : Effect.void;
      }

      const at = DateTime.makeUnsafe(event.created);

      if (
        event.type === "session.inbox.delivered" ||
        event.type === "session.inbox.cancelled"
      ) {
        const { inboxID } = event.data;

        return childEvent(sessionID, (s) =>
          inboxSettled(
            s,
            sessionID,
            inboxID,
            event.type === "session.inbox.delivered",
            at
          )
        );
      }

      return childEvent(sessionID, (s) =>
        finished(
          s,
          sessionID,
          /failed|interrupted/u.test(event.type) ? "failed" : "completed",
          at,
          event.type !== "session.idle"
        )
      );
    }),
    recover("event subscription failed"),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.forkScoped
  );

  // ---------- the budget ----------
  // Past the deadline and its grace period, the watchdog reports for the Liaison. One scoped sweep at a time; reload
  // interrupts both the sweep and the event consumer.
  /** Seals a sweep found reported, never read again: a reported seal never reopens. */
  const reported = new Set<string>();

  const sweep = Effect.gen(function* sweep() {
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
        now < DateTime.toEpochMillis(seal.deadline) + GRACE_MS ||
        !(
          bound.has(seal.id) ||
          seal.host === host.location.directory ||
          (myRepo !== null && seal.repo === myRepo)
        )
      ) {
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

  // Drain and locked: tell bound Directorate sessions where they stand, and strip tools once locked. Every request kind
  // gets the same tools, so a compaction or generate request keeps the session's prompt-cache prefix.
  for (const kind of ["context", "compaction", "generate"] as const) {
    yield* host.session.hook(
      kind,
      hook(kind, function* onSessionHook(event) {
        const agent: string = event.agent;

        if (!ROLE_SET.has(agent)) {
          // Other agents can configure and export without getting the review harness.
          for (const name of Object.keys(event.tools ?? {})) {
            if (name.startsWith("directorate_") && !GENERAL_TOOLS.has(name)) {
              Reflect.deleteProperty(event.tools, name);
            }
          }

          return;
        }

        const seal = yield* sessions.active(event.sessionID);

        if (agent === REVIEWER) {
          // Emit configured defaults on every Liaison turn so the system prefix stays stable across sealing.
          const directory =
            seal?.repo ??
            (yield* sessions.directory(event.sessionID)) ??
            host.location.directory;

          const line = yield* settings.load(directory).pipe(
            Effect.map((s) => describe(s.effective)),
            Effect.catch((error) =>
              Effect.succeed(`unreadable: ${error.message}`)
            )
          );

          if (line) {
            event.system.push({
              text: `[directorate settings] ${line}`,
              type: "text",
            });
          }
        }

        if (!seal) {
          return;
        }

        const now = yield* Clock.currentTimeMillis;
        const b = budget(seal, now);

        if (b.phase === "normal") {
          return;
        }

        // Static phase notice (no ticking minutesLeft) avoids busting the KV-cache prefix every 6s during drain.
        event.system.push({ text: budgetNotice(b.phase, agent), type: "text" });

        if (b.phase === "locked") {
          const keep = LOCKED_TOOLS.get(agent);

          for (const name of Object.keys(event.tools ?? {})) {
            if (!keep?.has(name)) {
              Reflect.deleteProperty(event.tools, name);
            }
          }
        }
      })
    );
  }

  // Only the Liaison dispatches Auditors, Seats, and Compliance, and only Directorate agents call the review tools. No new
  // Auditors or Seats once the budget drains; Compliance stays available until lock.
  yield* host.permission.hook(
    "evaluate",
    hook("evaluate", function* onEvaluate(event) {
      const target = String(event.resources?.[0] ?? "");

      const covered =
        event.action === "subagent"
          ? CHILD_ROLE_SET.has(target)
          : event.action.startsWith("directorate_") &&
            !GENERAL_TOOLS.has(event.action);

      // A request that names no agent is the session's agent's, as the host resolves it.
      const caller = covered
        ? (event.agent ?? (yield* sessions.agent(event.sessionID)))
        : undefined;

      if (
        caller !== undefined &&
        (event.action === "subagent"
          ? caller !== REVIEWER
          : !ROLE_SET.has(caller))
      ) {
        event.effect = "deny";
        event.message = LIAISON_ONLY;

        return;
      }

      if (event.action !== "subagent") {
        return;
      }

      const seal = yield* sessions.active(event.sessionID);

      if (!seal) {
        return;
      }

      const b = budget(seal, yield* Clock.currentTimeMillis);

      if (b.phase === "locked" || (b.phase === "drain" && target !== REFUTER)) {
        const stage = b.phase === "locked" ? "lockdown" : "evacuation";
        event.effect = "deny";
        event.message = `Directorate ${stage} (${b.phase}): <We/The Directorate> deny new ${target || "subagent"} dispatches. Verify what you hold and call directorate_report.`;
      }
    })
  );
});

export default Plugin.define({
  // Layer.build ties the services' resources to the plugin's scope; tools and hooks receive exactly these services,
  // never the host's request context.
  effect: (ctx) =>
    Layer.build(
      Sessions.layer.pipe(
        Layer.provideMerge(Layer.succeed(Host, ctx)),
        Layer.provideMerge(platformLayer)
      )
    ).pipe(
      Effect.flatMap((services) =>
        register().pipe(Effect.provideContext(services))
      )
    ),
  id: "directorate",
});
