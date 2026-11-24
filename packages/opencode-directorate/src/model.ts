// Directorate schemas: one per stored shape, plus the values tools take in. The domain types derive from them and are read-only:
// every change builds a new seal or ledger. seal.json and ledger.json are decoded and encoded through them.
import {
  Effect,
  Option,
  Path,
  Schema,
  type SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

/**
 * The Directorate roles: the Liaison (lead reviewer), Auditors (narrow investigators), Directorate Seats (independent
 * panel reviewers, one model each), and Compliance (the adversarial verifier).
 */
export const REVIEWER = "directorate_liaison";
export const REFUTER = "directorate_compliance";
export const SCOUT = "directorate_auditor";
export const PANELIST = "directorate_seat";
/** The seats of a panel review when the caller names no models, as "providerID/modelID#variant". */
export const DEFAULT_PANEL = [
  "openai/gpt-6.2-astra#xhigh",
  "claude-agent/claude-fable-5-2#high",
  "claude-agent/opus#high",
  "openai/gpt-6.2-sol#high",
  "github-copilot/gemini-4-neon#high",
];

const list = Schema.Array;
const opt = Schema.optional;
/** Line numbers, patch offsets, and counts: whole and never negative (0 marks a region with no new lines). */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Written by every current version; older seals may omit it. */
const since = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));
/** Older seals stored `true` where current ones store a value. */
const orLegacyTrue = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  Schema.Union([
    schema,
    Schema.Literal(true).pipe(
      Schema.decodeTo(
        schema,
        SchemaTransformation.transform({
          decode: () => value,
          encode: () => true as const,
        })
      )
    ),
  ]);
/** A UTC instant, stored as an ISO string. */
const Time = Schema.DateTimeUtcFromString;

export const Mode = Schema.Literals(["default", "code-quality", "full"]);
/** The review lenses: one playbook each under the directorate_lenses skill's references/. */
export const LENSES = [
  "correctness",
  "security",
  "performance",
  "impact",
  "tests",
  "quality",
  "architecture",
  "ops",
  "docs",
  "ux",
] as const;
export const Lens = Schema.Literals(LENSES);
export type Mode = typeof Mode.Type;
/**
 * Minutes a review gets when neither the request nor directorate.json sets them. A panel's verification load grows with its
 * seats, so its default is PANEL_BUDGET_FACTOR times longer.
 */
export const DEFAULT_BUDGET: Record<Mode, number> = {
  default: 20,
  "code-quality": 30,
  full: 60,
};
export const PANEL_BUDGET_FACTOR = 1.5;
export const TargetKind = Schema.Literals([
  "auto",
  "local",
  "commit",
  "range",
  "pr",
  "paths",
]);
export type TargetKind = typeof TargetKind.Type;
export const Side = Schema.Literals(["new", "old"]);
export type Side = typeof Side.Type;
export const Disposition = Schema.Literals(["reviewed", "skimmed", "skipped"]);
export type Disposition = typeof Disposition.Type;
export const Severity = Schema.Literals(["blocking", "important", "minor"]);
export type Severity = typeof Severity.Type;
export const Kind = Schema.Literals(["defect", "test-gap", "quality"]);
export type Kind = typeof Kind.Type;
export const VerdictKind = Schema.Literals([
  "confirmed",
  "refuted",
  "duplicate",
]);
export const EntryStatus = Schema.Literals([
  "open",
  "confirmed",
  "refuted",
  "duplicate",
]);
export const NoteKind = Schema.Literals(["unanswered", "limit", "assumption"]);
const ChildStatus = Schema.Literals([
  "launching",
  "running",
  "completed",
  "failed",
]);
const FileStatus = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "binary",
  "mode",
  "unchanged",
]);

/** As stored. The directorate_seal tool input declares its own keys with optionalKey: Schema.optional renders as anyOf-null for the model. */
export const Target = Schema.Struct({
  kind: TargetKind,
  base: opt(Schema.String),
  head: opt(Schema.String),
  commit: opt(Schema.String),
  pr: opt(Schema.String),
  paths: opt(Schema.Array(Schema.String)),
});
export type Target = typeof Target.Type;

const Actor = Schema.Struct({ agent: Schema.String, session: Schema.String });
export type Actor = typeof Actor.Type;

const Region = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  newStart: Count,
  newEnd: Count,
  patchStart: Count,
  patchEnd: Count,
  readBy: since(list(Schema.String), []),
  ownerRead: opt(Schema.Boolean),
  offsets: opt(Schema.Record(Schema.String, Count)),
  disposition: opt(Disposition),
  note: opt(Schema.String),
  key: opt(Schema.String),
});
export type Region = typeof Region.Type;

const FileEntry = Schema.Struct({
  path: Schema.String,
  oldPath: opt(Schema.String),
  status: FileStatus,
  added: Count,
  removed: Count,
  excluded: opt(Schema.String),
});
export type FileEntry = typeof FileEntry.Type;

const Anchor = Schema.Struct({
  path: Schema.String,
  line: Count,
  endLine: Count,
  side: Side,
});
export type Anchor = typeof Anchor.Type;

const Verdict = Schema.Struct({
  by: Actor,
  verdict: VerdictKind,
  rationale: Schema.String,
  evidence: list(Schema.String),
  of: opt(Schema.String),
  severity: opt(Severity),
  at: Time,
});
export type Verdict = typeof Verdict.Type;

const Entry = Schema.Struct({
  id: Schema.String,
  raisedBy: Actor,
  lens: Schema.String,
  title: Schema.String,
  severity: Severity,
  kind: Kind,
  anchor: Anchor,
  quote: Schema.String,
  trigger: Schema.String,
  consequence: Schema.String,
  evidence: list(Schema.String),
  fix: opt(Schema.String),
  brief: opt(Schema.String),
  status: EntryStatus,
  staleReason: opt(Schema.String),
  verdicts: list(Verdict),
  history: opt(list(Verdict)),
  createdAt: Time,
});
export type Entry = typeof Entry.Type;

const Note = Schema.Struct({
  kind: NoteKind,
  text: Schema.String,
  by: Actor,
  at: Time,
});
export type Note = typeof Note.Type;

const Child = Schema.Struct({
  call: Schema.String,
  agent: Schema.String,
  prompt: Schema.String,
  /** The subagent call's description, which OpenCode uses as the child session's title. */
  description: opt(Schema.String),
  /** The model the launch named, which for a panelist is its seat. */
  model: opt(Schema.String),
  session: opt(Schema.String),
  status: ChildStatus,
  startedAt: Time,
  endedAt: opt(Time),
});
export type Child = typeof Child.Type;

/** Each gate remembers what it already pushed back on; it fires again only for something new. */
const Gates = Schema.Struct({
  coverage: opt(orLegacyTrue(list(Schema.String), [])),
  children: opt(orLegacyTrue(list(Schema.String), [])),
  // A legacy `true` matched no fingerprint, so it decodes to one that matches none.
  freshness: opt(orLegacyTrue(Schema.String, "")),
  open: opt(orLegacyTrue(list(Schema.String), [])),
  panel: opt(list(Schema.String)),
});
export type Gates = typeof Gates.Type;

const Seal = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  owner: Schema.String,
  ownerSession: Schema.String,
  mode: Mode,
  target: Target,
  description: Schema.String,
  baseSha: Schema.String,
  headSha: Schema.String,
  baseTip: opt(Schema.String),
  postImage: Schema.Literals(["worktree", "commit"]),
  fingerprint: Schema.String,
  sigs: opt(Schema.Record(Schema.String, Schema.String)),
  gen: since(Count, 0),
  createdAt: Time,
  deadline: Time,
  budgetMinutes: Schema.Finite,
  refreshes: since(Count, 0),
  files: since(list(FileEntry), []),
  regions: since(list(Region), []),
  deleted: since(list(Schema.String), []),
  children: since(list(Child), []),
  gates: since(Gates, {}),
  staleFiles: opt(list(Schema.String)),
  freshnessUnverified: opt(Schema.String),
  question: opt(Schema.String),
  /** A panel review's seats: one model per panelist. */
  panel: opt(list(Schema.String)),
  /** Lenses the settings turned off for this review. */
  lensesOff: opt(list(Schema.String)),
  reportedAt: opt(Time),
  autoReported: opt(Schema.Boolean),
  abandoned: opt(Schema.Boolean),
});
export type Seal = typeof Seal.Type;

const Ledger = Schema.Struct({ entries: list(Entry), notes: list(Note) });
export type Ledger = typeof Ledger.Type;

export const SealJson = Schema.fromJsonString(Seal, { space: 2 });
export const LedgerJson = Schema.fromJsonString(Ledger, { space: 2 });

// ---------- tool input values ----------
/** A stand-in repository root: paths are resolved lexically beneath it, in git's POSIX form on every host. */
const ROOT = "/repo";
export const invalid = (
  input: string,
  options: SchemaAST.ParseOptions,
  message: string
) => Effect.fail(new SchemaIssue.InvalidValue({ message }, input, options));
/** The repository-relative form of `input`, or none if it is absolute or climbs out; the root itself is "". */
const inRepo = (input: string) =>
  Effect.map(Path.Path, (path) =>
    Option.map(path.resolveWithin(ROOT, input.trim()), (abs) =>
      path.relative(ROOT, abs)
    )
  ).pipe(Effect.provide(Path.layer));
/** A directory scope in the repository, in git's form; "." (the whole repository) decodes to "". */
export const RepoScope = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (input, options) =>
        inRepo(input).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                invalid(
                  input,
                  options,
                  `Path ${input} must be relative to the repository and stay inside it.`
                ),
              onSome: Effect.succeed,
            })
          )
        ),
      encode: Effect.succeed,
    })
  )
);
/** A file in the repository, in git's form. */
export const RepoPath = RepoScope.check(
  Schema.makeFilter(
    (p: string) => p !== "" || "Expected a file path, not the repository root."
  )
);

const LINE_REF = /^(.+?):(\d+)(?:-(\d+))?$/;
/** An evidence reference other than a URL: path:line or path:start-end, decoded to its parts and encoded back. */
export const LineRef = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({ path: Schema.String, start: Schema.Int, end: Schema.Int }),
    SchemaTransformation.transformEffect({
      decode: (input, options) => {
        const m = LINE_REF.exec(input.trim());
        if (!m)
          return invalid(
            input,
            options,
            'use a bare path:line, path:start-end, or URL, with no side marker such as (old) and no prose; both sides are checked, and notes such as "none: searched …" go in trigger, brief, or rationale'
          );
        const start = Number(m[2]);
        const end = Number(m[3] ?? m[2]);
        if (start < 1 || end < start)
          return invalid(input, options, "invalid line range");
        return inRepo(m[1]).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                invalid(
                  input,
                  options,
                  `Path ${m[1]} must be relative to the repository and stay inside it.`
                ),
              onSome: (path) =>
                path
                  ? Effect.succeed({ path, start, end })
                  : invalid(
                      input,
                      options,
                      "Expected a file path, not the repository root."
                    ),
            })
          )
        );
      },
      encode: (r) =>
        Effect.succeed(
          r.start === r.end
            ? `${r.path}:${r.start}`
            : `${r.path}:${r.start}-${r.end}`
        ),
    })
  )
);
export const isUrl = (ref: string) => /^https?:\/\//.test(ref.trim());
/** A model as the subagent tool takes it; whether it is available is checked when the panelist launches. */
export const ModelRef = Schema.String.check(
  Schema.makeFilter(
    (m: string) =>
      /^[^/\s#]+\/[^\s#]+(#[^\s#]+)?$/.test(m) ||
      `Model ${m} must be "providerID/modelID" or "providerID/modelID#variant".`
  )
);

/** Which directorate.json: global (in OpenCode's global config directory, ~/.config/opencode) or the project's (<repo>/.opencode). */
export const SettingsScope = Schema.Literals(["global", "project"]);
export type SettingsScope = typeof SettingsScope.Type;
const Minutes = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(2),
  Schema.isLessThanOrEqualTo(240)
);
/** A Directorate Seat (panel seat): a chat model and its thinking level. */
const Seat = Schema.Struct({
  model: Schema.String.check(
    Schema.makeFilter(
      (m: string) =>
        /^[^/\s#]+\/[^\s#]+$/.test(m) ||
        `Model ${m} must be "providerID/modelID"; put the thinking level in variant.`
    )
  ).annotate({ description: "providerID/modelID" }),
  variant: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Thinking level: one of the model's variant ids, such as high or xhigh.",
    })
  ),
});
export type Seat = typeof Seat.Type;
/** directorate.json. Every key is optional; an absent key falls through to the global file, then to Directorate defaults. */
export const Settings = Schema.Struct({
  mode: Schema.optionalKey(
    Mode.annotate({ description: "Review mode when the request names none." })
  ),
  budget_minutes: Schema.optionalKey(
    Schema.Struct({
      default: Schema.optionalKey(Minutes),
      "code-quality": Schema.optionalKey(Minutes),
      full: Schema.optionalKey(Minutes),
    }).annotate({
      description: "Time budget per mode, used as-is (panel reviews too).",
    })
  ),
  panel: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "Run a panel review unless the request asks for a single model.",
        })
      ),
      models: Schema.optionalKey(
        Schema.Array(Seat)
          .check(Schema.isMinLength(1))
          .annotate({ description: "The panel's seats, in order." })
      ),
    })
  ),
  lenses: Schema.optionalKey(
    Schema.Struct({
      disabled: Schema.optionalKey(
        Schema.Array(Lens).annotate({
          description: "Lenses reviews skip; entries under them are rejected.",
        })
      ),
    })
  ),
});
export type Settings = typeof Settings.Type;
export const seatRef = (s: Seat) =>
  s.variant ? `${s.model}#${s.variant}` : s.model;
/** No key set: writing these settings removes the file. */
export const isUnset = (s: Settings) =>
  Object.values(s).every((v) => v === undefined);
