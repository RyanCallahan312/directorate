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
  Stream,
} from "effect";

import { budget, budgetLine } from "./budget.ts";
import {
  childName,
  childOutstanding,
  claimed,
  finished,
  followedUp,
  launched,
  openSeat,
  panelSeats,
  resumed,
  returned,
  seatName,
} from "./children.ts";
import { configureRpc, configureTool } from "./configure.ts";
import { coverageSummary } from "./coverage.ts";
import { failure, ignore, recover } from "./error.ts";
import { Git } from "./git.ts";
import { ledgerTools } from "./ledger-tools.ts";
import { currentSeverity, unresolved } from "./ledger.ts";
import {
  type Child,
  Mode,
  ModelRef,
  PANELIST,
  REFUTER,
  RepoScope,
  REVIEWER,
  SCOUT,
  type Seal,
  TargetKind,
} from "./model.ts";
import { platformLayer } from "./platform.ts";
import { readTools } from "./read-tools.ts";
import { finalize } from "./report.ts";
import { createSeal, refreshSeal } from "./seal.ts";
import { Host, Sessions } from "./session.ts";
import { describe, resolve, SettingsStore } from "./settings.ts";
import { Store } from "./store.ts";
import { currentFingerprint } from "./target.ts";
import {
  actor,
  adapter,
  done,
  locked,
  mutate,
  optional,
  str,
  writable,
} from "./tool.ts";

const ROLES = new Set([REVIEWER, SCOUT, PANELIST, REFUTER]);
const CHILD_ROLES = new Set([SCOUT, PANELIST, REFUTER]);
/** What each role may still call once the budget is locked. */
const LOCKED_TOOLS: Record<string, string[]> = {
  [REVIEWER]: [
    "directorate_report",
    "directorate_ledger_list",
    "directorate_note",
  ],
  [SCOUT]: ["directorate_ledger_add", "directorate_note"],
  [PANELIST]: ["directorate_ledger_add", "directorate_note"],
  [REFUTER]: ["directorate_ledger_verdict", "directorate_ledger_list"],
};
/** How long after the deadline the watchdog waits for the Liaison's own report. */
const GRACE_MS = 120_000;
/** Why another agent may not use the review harness: the Liaison runs the whole review, so callers dispatch it. */
const LIAISON_ONLY =
  "Only directorate_liaison runs a Directorate review: it seals, reads, dispatches its own Auditors, Seats, and Compliance, and returns the Directive. Dispatch directorate_liaison with the target and focus, and relay its Directive verbatim. If you already dispatched one, send the follow-up to that session instead of starting another.";

/** An Auditor, Seat, or Compliance launch, as the subagent tool's input; with a sessionID it continues an existing child. */
const decodeAssignment = Schema.decodeUnknownOption(
  Schema.Struct({
    agent: Schema.Literals([SCOUT, PANELIST, REFUTER]),
    prompt: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
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

const register = Effect.fn("Directorate.register")(function* () {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const store = yield* Store;
  const settings = yield* SettingsStore;
  const { hook, tools } = yield* adapter;
  const myRepo = yield* (yield* Git)
    .root(host.location.directory)
    .pipe(Effect.orElseSucceed(() => undefined));

  /** Reported, without the Liaison: abandoned for a new review, or past the deadline and its grace period. */
  const autoReport = Effect.fn("Directorate.autoReport")(function* (
    id: string,
    reason: string,
    abandonedBy?: string
  ) {
    const saved = yield* store.withLock(
      id,
      Effect.gen(function* () {
        const seal = yield* store.load(id);
        if (seal.reportedAt) return undefined;
        if (abandonedBy && seal.ownerSession !== abandonedBy)
          return yield* failure(`Only the owner of ${id} can abandon it.`);
        if (
          !abandonedBy &&
          (yield* Clock.currentTimeMillis) <
            DateTime.toEpochMillis(seal.deadline) + GRACE_MS
        )
          return undefined;
        return yield* finalize(
          abandonedBy ? { ...seal, abandoned: true } : seal,
          yield* store.loadLedger(id),
          { auto: true, extraReasons: [reason] }
        );
      })
    );
    if (!saved) return;
    yield* sessions.close(saved.seal);
    yield* sessions.notify(
      saved.seal,
      `The Directorate <intervened/filed> the directive for ${id} (${reason}):\n\n${saved.md}`
    );
  });

  yield* configureRpc();
  yield* host.command.transform((editor) => {
    editor.add({
      description: "Choose options and start a Directorate review",
      execute: ({ delivery, prompt, sessionID }) =>
        host.session
          .prompt({
            ...prompt,
            delivery,
            sessionID,
            text: `${prompt.text}

Start a Directorate code review. Before dispatching, use the question tool to ask for any options not already supplied above. Ask what to review (current branch with local changes, uncommitted changes only, a PR, a commit or range, or specific paths), the mode (configured default, default, code-quality, or full), and whether to use the configured panel setting, a single-model review, or a panel. Offer an optional focus or time limit. If the target needs a PR number, ref, or path, ask for it. If the user cancels, do not start a review.

Once the options are settled, dispatch directorate_liaison with the chosen target and options. Leave configured defaults unset rather than guessing them. Wait for the Liaison and relay its final Directive verbatim. Do not run the review yourself.`,
          })
          .pipe(Effect.asVoid),
      name: "directorate-review",
    });
  });
  yield* host.tool.transform((editor) => {
    const tool = tools(editor);
    readTools(tool);
    ledgerTools(tool);
    configureTool(tool);

    // Sealed: one review per session, started fresh, resumed from another session, or restarted by abandoning.
    tool({
      name: "directorate_seal",
      description:
        "Start a Directorate review: pin the target in containment and start the time budget. target.kind auto = local changes plus any commits on this branch beyond the default branch. Also: local, commit, range (base may be @default), pr, paths (no paths = whole repository). Returns the seal id every other directorate_* tool needs. resume takes over an interrupted review (mode and target not needed). panel convenes independent whole-change reviews by several models (Directorate Seats), combined in one Directive.",
      input: Schema.Struct({
        mode: optional(
          Mode.annotate({
            description:
              "Omit to use the configured default (directorate.json), else default.",
          })
        ),
        target: optional(
          Schema.Struct({
            kind: TargetKind,
            base: optional(str),
            head: optional(str),
            commit: optional(str),
            pr: optional(str),
            paths: optional(Schema.Array(RepoScope)),
          })
        ),
        budget_minutes: optional(
          Schema.Finite.check(
            Schema.isGreaterThanOrEqualTo(2),
            Schema.isLessThanOrEqualTo(240)
          )
        ),
        repo: optional(
          str.annotate({
            description:
              "Repository directory; defaults to the session's directory.",
          })
        ),
        question: optional(
          str.annotate({
            description: "The user's focus, if any; shown in the report.",
          })
        ),
        resume: optional(
          str.annotate({
            description:
              "Seal id of an unreported review to take over instead of sealing a new one.",
          })
        ),
        abandon: optional(
          Schema.Boolean.annotate({
            description:
              "Close this session's unreported review (its partial report is saved) and seal a new one.",
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
      }),
      execute: function* (input, c) {
        const a = actor(c);
        const prior = yield* sessions.active(a.session);
        if (prior && prior.id !== input.resume) {
          if (!input.abandon)
            return yield* failure(
              `This session already holds an active containment seal ${prior.id}. Close it with directorate_report, or pass abandon: true to file its partial directive and start over.`
            );
          yield* autoReport(prior.id, "abandoned for a new review", a.session);
        }
        if (input.resume) {
          const resume = input.resume;
          const { seal, previousOwner } = yield* store.withLock(
            resume,
            Effect.gen(function* () {
              const s = yield* store.load(resume);
              if (s.reportedAt)
                return yield* failure(
                  `${s.id} was already reported; directorate_report with this seal shows the saved directive.`
                );
              // A spent budget gets more time: half the original, at least 5 minutes, unless the caller names a budget.
              const now = yield* DateTime.now;
              const minutes =
                input.budget_minutes ??
                (budget(s, DateTime.toEpochMillis(now)).phase === "normal"
                  ? undefined
                  : Math.max(5, Math.round(s.budgetMinutes / 2)));
              const taken: Seal = {
                ...s,
                ownerSession: a.session,
                owner: a.agent,
                ...(minutes === undefined
                  ? {}
                  : {
                      createdAt: now,
                      deadline: DateTime.add(now, { minutes }),
                      budgetMinutes: minutes,
                    }),
              };
              yield* store.save(taken);
              return { seal: taken, previousOwner: s.ownerSession };
            })
          );
          yield* sessions.takeOver(seal, previousOwner);
          const cov = coverageSummary(seal);
          return yield* done(
            seal,
            `Resumed containment \`${seal.id}\` (${seal.mode}): ${seal.description}. Observed ${cov.read}/${cov.total}; ${unresolved(yield* store.loadLedger(seal.id)).length} entries unresolved. Continue where it stopped: directorate_diff for unread regions, directorate_ledger_list for entries.`
          );
        }
        if (!input.target)
          return yield* failure("directorate_seal needs a target (or resume).");
        const repo =
          input.repo ||
          (yield* sessions.directory(a.session)) ||
          host.location.directory;
        yield* store.gc().pipe(ignore("old seal cleanup failed", "Warn"));
        const configured = (yield* settings.load(repo)).effective;
        const { mode, panel, budgetMinutes, lensesOff } = resolve(configured, {
          mode: input.mode,
          panel: input.panel,
          panelModels: input.panel_models,
          budgetMinutes: input.budget_minutes,
        });
        const seal = yield* createSeal({
          repo,
          mode,
          target: input.target,
          budgetMinutes,
          question: input.question,
          panel,
          lensesOff,
          owner: a,
        });
        yield* sessions.bind(a.session, seal.id);
        yield* sessions.record(a.session, seal);
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
        return yield* done(
          seal,
          [
            `Containment sealed \`${seal.id}\`: ${seal.description}.`,
            `base ${seal.baseSha.slice(0, 12)} · head ${seal.postImage === "commit" ? seal.headSha.slice(0, 12) : "working tree (snapshotted)"} · ${seal.files.length} files · ${seal.regions.length} regions · budget ${seal.budgetMinutes} min.`,
            seal.lensesOff
              ? `Lenses disabled by directorate.json: ${seal.lensesOff.join(", ")}. Do not assign them; entries under them are rejected.`
              : "",
            seal.panel && seal.regions.length
              ? `Directorate Seats (${seal.panel.length}): ${seal.panel.map(seatName).join(", ")}. Convene ${seal.panel.length} directorate_seat subagents now, in one turn, without a model: The Directorate assigns each launch the next open seat's model.`
              : "",
            "",
            "| File | Status | Lines | Regions | Excluded |",
            "|---|---|---|---|---|",
            ...rows,
            changedFiles.length > rows.length
              ? `| … ${changedFiles.length - rows.length} more files | | | | |`
              : "",
            unchanged
              ? `\n${unchanged} unchanged files in scope (whole-file regions; directorate_ls lists them).`
              : "",
            "",
            seal.regions.length
              ? "Next: read every region with directorate_diff (call it with only the seal to get the next unread chunk)."
              : "Nothing to review in this target. Inform the requester, or seal a different target.",
          ].join("\n")
        );
      },
    });

    // Refreshed: the code moved after the seal; the target is re-pinned once.
    tool({
      name: "directorate_refresh",
      description:
        "After directorate_report's freshness gate (Containment Drift): re-pin the target once and re-capture it (diff, snapshot, regions); regions whose content is unchanged keep their read receipts, and entries whose anchor or evidence changed reopen for re-verification.",
      input: Schema.Struct({ seal: str }),
      execute: function* (input, c) {
        return yield* mutate(
          c,
          input.seal,
          "directorate_refresh",
          function* (seal) {
            if (seal.refreshes >= 1)
              return yield* failure(
                "This seal was already re-contained once. Call directorate_report; it marks the directive stale if the artifact moved again."
              );
            const r = yield* refreshSeal(
              seal,
              yield* store.loadLedger(seal.id)
            );
            if (r.seal === seal)
              return yield* done(seal, "No drift detected since containment.");
            return yield* done(
              r.seal,
              `Re-contained. Changed: ${r.files.join(", ") || "none"}. Regions to read: ${r.newRegions.map((x) => x.id).join(" ") || "none"}. Reopened for re-verification: ${r.reopened.join(" ") || "none"}.`
            );
          },
          true
        );
      },
    });

    // Reported: each gate pushes back once per new gap; locked budgets pass every gate.
    tool({
      name: "directorate_report",
      description:
        "Issue the final Directorate Directive. Protocol gates push back once for each new gap (unread regions, missing Seats, subagents still running, containment drift, unverified entries); calling again proceeds and records the gap. Renders the directive from the dossier: only verified entries become findings. Output the returned markdown verbatim.",
      input: Schema.Struct({
        seal: str,
        approach: optional(
          str.annotate({
            description:
              "1–3 sentences: does the overall approach fit the goal?",
          })
        ),
        synthesis: optional(
          str.annotate({
            description:
              "Optional: shared root causes, how fixes interact, order of work. No new claims.",
          })
        ),
      }),
      execute: function* (input, c) {
        const { seal, md } = yield* locked(c, input.seal, function* (seal) {
          // A reported seal shows its saved report to anyone allowed to ask.
          if (seal.reportedAt)
            return { seal: undefined, md: yield* store.readReport(seal.id) };
          yield* writable(seal, c, "directorate_report", true);
          const ledger = yield* store.loadLedger(seal.id);
          const phase = budget(seal, yield* Clock.currentTimeMillis).phase;
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
            const seen = new Set(seal.gates[key] ?? []);
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
          const missing = panelSeats(seal).filter(
            (s) => s.status === "failed" || s.status === "not launched"
          );
          yield* once(
            "panel",
            missing.map((s) => `${s.model}:${s.runs.length}`),
            `Protocol hold (Seats): ${missing.length} of ${seal.panel?.length ?? 0} Directorate Seats returned no review: ${missing.map((s) => `${seatName(s.model)} (${s.status})`).join(", ")}. Launch one directorate_seat per missing seat without a model (The Directorate assigns it); leave a seat that failed twice. Calling directorate_report again reports without them.`
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
            synthesis: input.synthesis,
            cur,
          });
        });
        if (seal) yield* sessions.close(seal);
        return { content: md };
      },
    });

    // Waiting: the Liaison stays in its turn while its subagents work. Ending the turn instead would hand a calling agent
    // an unfinished review, and leave that agent to finish it. Their handoffs arrive as messages at the next step.
    tool({
      name: "directorate_wait",
      description:
        "Wait, without ending your turn, until one of this review's Auditor, Seat, or Compliance runs finishes or the budget phase changes. Returns who finished, the entries and verdicts each recorded, and who is still running; their handoffs follow as subagent messages. Call it whenever you would otherwise end your turn while they run.",
      input: Schema.Struct({ seal: str }),
      execute: function* (input, c) {
        const start = yield* locked(c, input.seal, function* (seal) {
          yield* writable(seal, c, "directorate_wait", true);
          return seal;
        });
        const phase = budget(start, yield* Clock.currentTimeMillis).phase;
        const waiting = childOutstanding(start);
        if (!waiting.length)
          return yield* done(
            start,
            "No Auditor, Seat, or Compliance runs are running. Decide or route the open entries, then call directorate_report."
          );
        if (phase === "locked")
          return yield* done(
            start,
            "The budget is locked: call directorate_report now; it stops the runs still going."
          );
        const ended = (seal: Seal) => {
          const still = new Set(childOutstanding(seal).map((x) => x.call));
          return seal.children.filter(
            (x) => waiting.some((w) => w.call === x.call) && !still.has(x.call)
          );
        };
        /** One per child session (its latest run), since a follow-up joined to a running child shares its session. */
        const perSession = (runs: readonly Child[]) => [
          ...new Map(runs.map((x) => [x.session ?? x.call, x])).values(),
        ];
        // The session events and the deadline watchdog write the seal; poll it until something the Liaison acts on changed.
        const { seal, now } = yield* Effect.all({
          seal: store.load(start.id),
          now: Clock.currentTimeMillis,
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: ({ seal, now }) =>
              seal.reportedAt !== undefined ||
              budget(seal, now).phase !== phase ||
              ended(seal).length > 0,
          })
        );
        if (seal.reportedAt)
          return {
            content: `The deadline passed and The Directorate filed the Directive. Output it verbatim:\n\n${yield* store.readReport(seal.id)}`,
          };
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
              .filter((v) => v.by.session === x.session && since(v.at))
              .map((v) => `${e.id} ${v.verdict}`)
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
        return yield* done(
          seal,
          [
            ...perSession(ended(seal)).map(
              (x) =>
                `- ${childName(x)} ${x.status}${x.session ? ` (${x.session})` : ""}: ${recorded(x)}`
            ),
            phaseNow === "locked"
              ? "The budget is locked: call directorate_report now; it stops the runs still going."
              : phaseNow !== phase
                ? `The budget moved to ${phaseNow}; follow the budget line below.`
                : "",
            phaseNow === "locked"
              ? ""
              : still.length
                ? `Still running (${still.length}): ${still.map((x) => `${childName(x)}${x.session ? ` (${x.session})` : ""}`).join(", ")}. Decide or route what finished, then call directorate_wait again; do not end your turn while any run.`
                : "Nothing else is running. Decide or route the new entries, then call directorate_report.",
          ]
            .filter(Boolean)
            .join("\n")
        );
      },
    });
  });

  // ---------- Auditors, Seats, and Compliance ----------
  // Launching: registered before the child runs, so a fast child is never missed. A completed child calling tools again
  // is running again; check before locking, since most calls change nothing.
  yield* host.tool.hook(
    "execute.before",
    hook("executeBefore", function* (ev) {
      if (ev.tool !== "subagent") {
        const id = yield* sessions.boundTo(ev.sessionID);
        if (!id || !CHILD_ROLES.has(ev.agent)) return;
        const seal = yield* store
          .load(id)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (!seal || !resumed(seal, ev.sessionID)) return;
        yield* sessions
          .update(id, (s) => resumed(s, ev.sessionID))
          .pipe(
            ignore(`could not mark ${ev.sessionID} running in ${id}`, "Warn")
          );
        return;
      }
      const assignment = Option.getOrUndefined(decodeAssignment(ev.input));
      if (!assignment) return;
      const seal = yield* sessions.active(ev.sessionID);
      if (!seal) return;
      const startedAt = yield* DateTime.now;
      // A new Seat launched without a model takes the next open seat, chosen under the seal's lock so parallel launches
      // take different seats. The seat's name goes into its title too, which is how its session finds this launch.
      let seat: { model: string; description: string } | undefined;
      yield* sessions
        .update(seal.id, (s) => {
          // A follow-up continues a child session: a new run of it, keeping the seat it was launched for.
          const prior = assignment.sessionID
            ? s.children.findLast((c) => c.session === assignment.sessionID)
            : undefined;
          if (assignment.sessionID) {
            return followedUp(s, {
              call: ev.id,
              agent: assignment.agent,
              prompt: assignment.prompt ?? "",
              description: assignment.description ?? prior?.description,
              model: assignment.model ?? prior?.model,
              session: assignment.sessionID,
              status: "launching",
              startedAt,
            });
          }
          const model =
            assignment.agent === PANELIST && !assignment.model
              ? openSeat(s)
              : undefined;
          seat = model
            ? {
                model,
                description: `${assignment.description ?? "Directorate Seat"} · ${seatName(model)}`,
              }
            : undefined;
          return launched(s, {
            call: ev.id,
            agent: assignment.agent,
            prompt: assignment.prompt ?? "",
            description: seat?.description ?? assignment.description,
            model: seat?.model ?? assignment.model,
            status: "launching",
            startedAt,
          });
        })
        .pipe(
          ignore(`could not register ${assignment.agent} in ${seal.id}`, "Warn")
        );
      if (seat && Predicate.isObject(ev.input))
        ev.input = {
          ...ev.input,
          model: seat.model,
          description: seat.description,
        };
    })
  );
  // The subagent tool returned. Its result names the child too; that matters only if session.created was missed (a plugin
  // reload mid-launch).
  yield* host.tool.hook(
    "execute.after",
    hook("executeAfter", function* (ev) {
      if (ev.tool !== "subagent") return;
      const seal = yield* sessions.active(ev.sessionID);
      if (!seal) return;
      const result = ev.status === "completed" ? ev.result : undefined;
      const meta = Option.getOrElse(
        decodeChildMeta(result?.metadata?.metadata ?? result?.metadata),
        () => ({ sessionID: undefined, status: undefined })
      );
      const text = JSON.stringify(result?.content ?? "");
      const outcome: Child["status"] =
        ev.status === "error"
          ? "failed"
          : meta.status === "completed" || /state=\\?"completed/.test(text)
            ? "completed"
            : /state=\\?"(failed|error|interrupted)/.test(text) ||
                meta.status === "failed"
              ? "failed"
              : "running";
      const endedAt = yield* DateTime.now;
      let child: string | undefined;
      yield* sessions
        .update(seal.id, (s) => {
          const launch = s.children.find((x) => x.call === ev.id);
          if (!launch) return undefined; // Not an Auditor, Seat, or Compliance of this review.
          child = launch.session ?? meta.sessionID;
          return returned(s, ev.id, meta.sessionID, outcome, endedAt);
        })
        .pipe(ignore(`could not record subagent result in ${seal.id}`, "Warn"));
      if (child) yield* sessions.bind(child, seal.id);
    })
  );
  // Running: a child's session is created by the subagent tool before it runs; link it to its launch now, so every later
  // event for it finds the review.
  const claimChild = Effect.fn("Directorate.claimChild")(function* (
    sessionID: string,
    parentID: string,
    agent: string,
    title: string | undefined
  ) {
    if (!CHILD_ROLES.has(agent)) return;
    const seal = yield* sessions.active(parentID);
    if (!seal || seal.ownerSession !== parentID) return;
    yield* sessions
      .update(seal.id, (s) => claimed(s, sessionID, agent, title))
      .pipe(
        ignore(`could not link ${agent} ${sessionID} to ${seal.id}`, "Warn")
      );
    yield* sessions.bind(sessionID, seal.id);
  });
  // Completed or failed: the child's session went idle, or its execution failed or was interrupted.
  const finishChild = Effect.fn("Directorate.finishChild")(function* (
    sessionID: string,
    status: "completed" | "failed"
  ) {
    const id =
      (yield* sessions.boundTo(sessionID)) ??
      (yield* sessions.active(sessionID))?.id;
    if (!id) return;
    const endedAt = yield* DateTime.now;
    yield* sessions
      .update(id, (s) => finished(s, sessionID, status, endedAt))
      .pipe(ignore(`could not finish ${sessionID} in ${id}`, "Warn"));
  });
  // One consumer, in event order: a child's session.created is always handled before its terminal events.
  yield* Stream.suspend(() =>
    host.event.subscribe({
      types: [
        "session.created",
        "session.idle",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
      ],
    })
  ).pipe(
    Stream.runForEach((event) =>
      event.type === "session.created"
        ? event.data.parentID
          ? claimChild(
              event.data.sessionID,
              event.data.parentID,
              String(event.data.agent ?? ""),
              event.data.title
            )
          : Effect.void
        : finishChild(
            event.data.sessionID,
            /failed|interrupted/.test(event.type) ? "failed" : "completed"
          )
    ),
    recover("event subscription failed"),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.forkScoped
  );

  // ---------- the budget ----------
  // Past the deadline and its grace period, the watchdog reports for the Liaison. One scoped sweep at a time; reload
  // interrupts both the sweep and the event consumer.
  const sweep = Effect.gen(function* () {
    const ids = yield* sessions.boundSeals;
    const now = yield* Clock.currentTimeMillis;
    const overdue = (seal: Seal) =>
      !seal.reportedAt &&
      now >= DateTime.toEpochMillis(seal.deadline) + GRACE_MS;
    if (myRepo)
      for (const seal of yield* store.list({
        repo: myRepo,
        maxAgeMs: 2 * 86_400_000,
      }))
        if (overdue(seal)) ids.add(seal.id);
    for (const id of ids) {
      const seal = yield* store
        .load(id)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!seal || !overdue(seal)) continue;
      yield* autoReport(
        id,
        "the Liaison did not report before lockdown; filed automatically"
      ).pipe(ignore(`could not save the deadline report for ${id}`, "Warn"));
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
  for (const kind of ["context", "compaction", "generate"] as const)
    yield* host.session.hook(
      kind,
      hook(kind, function* (event) {
        const agent: string = event.agent;
        if (!ROLES.has(agent)) {
          // Other agents get the Liaison, not the harness: no review tools but the settings one.
          for (const name of Object.keys(event.tools ?? {}))
            if (
              name.startsWith("directorate_") &&
              name !== "directorate_configure"
            )
              delete event.tools[name];
          return;
        }
        const seal = yield* sessions.active(event.sessionID);
        if (!seal) {
          // Before sealing, the Liaison sees the configured defaults, which decide the target in full mode.
          if (agent !== REVIEWER) return;
          const directory =
            (yield* sessions.directory(event.sessionID)) ??
            host.location.directory;
          const line = yield* settings.load(directory).pipe(
            Effect.map((s) => describe(s.effective)),
            Effect.catch((e) => Effect.succeed(`unreadable: ${e.message}`))
          );
          if (line)
            event.system.push({
              type: "text",
              text: `[directorate settings] ${line}`,
            });
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const b = budget(seal, now);
        if (b.phase === "normal") return;
        event.system.push({ type: "text", text: budgetLine(seal, now, agent) });
        if (b.phase === "locked") {
          const keep = new Set(LOCKED_TOOLS[agent] ?? []);
          for (const name of Object.keys(event.tools ?? {}))
            if (!keep.has(name)) delete event.tools[name];
        }
      })
    );
  // Only the Liaison dispatches Auditors, Seats, and Compliance, and only Directorate agents call the review tools. No new
  // Auditors or Seats once the budget drains; Compliance stays available until lock.
  yield* host.permission.hook(
    "evaluate",
    hook("evaluate", function* (event) {
      const target = String(event.resources?.[0] ?? "");
      const covered =
        event.action === "subagent"
          ? CHILD_ROLES.has(target)
          : event.action.startsWith("directorate_") &&
            event.action !== "directorate_configure";
      // A request that names no agent is the session's agent's, as the host resolves it.
      const caller = covered
        ? (event.agent ?? (yield* sessions.agent(event.sessionID)))
        : undefined;
      if (
        caller !== undefined &&
        (event.action === "subagent" ? caller !== REVIEWER : !ROLES.has(caller))
      ) {
        event.effect = "deny";
        event.message = LIAISON_ONLY;
        return;
      }
      if (event.action !== "subagent") return;
      const seal = yield* sessions.active(event.sessionID);
      if (!seal) return;
      const b = budget(seal, yield* Clock.currentTimeMillis);
      if (b.phase === "locked" || (b.phase === "drain" && target !== REFUTER)) {
        event.effect = "deny";
        event.message = `Directorate lockdown (${b.phase}): <We/The Directorate> deny new ${target || "subagent"} dispatches. Verify what you hold and call directorate_report.`;
      }
    })
  );
});

export default Plugin.define({
  id: "directorate",
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
});
