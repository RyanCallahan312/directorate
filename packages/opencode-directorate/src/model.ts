// Directorate schemas: one per stored shape, plus the values tools take in. The domain types derive from them and are read-only:
// every change builds a new seal or ledger. seal.json and ledger.json are decoded and encoded through them.
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import type { SchemaAST } from "effect";

/**
 * The Directorate roles: the Liaison (lead reviewer), Auditors (narrow investigators), Directorate Seats (independent
 * panel reviewers, one model each), and Compliance (the adversarial verifier).
 */
export const REVIEWER = "directorate_liaison";
export const REFUTER = "directorate_compliance";
export const SCOUT = "directorate_auditor";
export const PANELIST = "directorate_seat";

/** Every Directorate role, in registration order. */
export const ROLES = [REVIEWER, SCOUT, PANELIST, REFUTER] as const;

/** The roles the Liaison dispatches as child sessions. */
export const CHILD_ROLES = [SCOUT, PANELIST, REFUTER] as const;
export const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
export const CHILD_ROLE_SET: ReadonlySet<string> = new Set(CHILD_ROLES);

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

export const ModeSchema = Schema.Literals(["default", "code-quality", "full"]);

/** The review lenses: one playbook each under the directorate-lenses skill's references/. */
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

export type Mode = typeof ModeSchema.Type;

/**
 * Minutes a review gets when neither the request nor directorate.json sets them. A panel's verification load grows with its
 * seats, so its default is PANEL_BUDGET_FACTOR times longer.
 */
export const DEFAULT_BUDGET: Record<Mode, number> = {
  "code-quality": 30,
  default: 20,
  full: 60,
};

export const PANEL_BUDGET_FACTOR = 1.5;

export const TargetKindSchema = Schema.Literals([
  "auto",
  "local",
  "commit",
  "range",
  "pr",
  "paths",
]);

export type TargetKind = typeof TargetKindSchema.Type;

export const ReviewScopeSchema = Schema.Literals([
  "branch",
  "local",
  "repository",
]);

export type ReviewScope = typeof ReviewScopeSchema.Type;

export const DEFAULT_REVIEW_SCOPE: ReviewScope = "branch";

export const REVIEW_SCOPE_TARGET = {
  branch: "auto",
  local: "local",
  repository: "paths",
} as const satisfies Record<ReviewScope, TargetKind>;

export const SideSchema = Schema.Literals(["new", "old"]);

export type Side = typeof SideSchema.Type;

export const DispositionSchema = Schema.Literals([
  "reviewed",
  "skimmed",
  "skipped",
]);

export type Disposition = typeof DispositionSchema.Type;

export const SeveritySchema = Schema.Literals([
  "blocking",
  "important",
  "minor",
]);

export type Severity = typeof SeveritySchema.Type;

export const KindSchema = Schema.Literals(["defect", "test-gap", "quality"]);

export type Kind = typeof KindSchema.Type;

/** `resolved`: a finding carried from the review a re-check follows no longer holds on the new code. */
export const VerdictKind = Schema.Literals([
  "confirmed",
  "refuted",
  "duplicate",
  "resolved",
]);

export const EntryStatus = Schema.Literals([
  "open",
  "confirmed",
  "refuted",
  "duplicate",
  "resolved",
]);

/** `answered`: the Liaison answered a failed Auditor's question itself; its text is that question. */
export const NoteKind = Schema.Literals([
  "unanswered",
  "limit",
  "assumption",
  "answered",
]);

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
export const TargetSchema = Schema.Struct({
  base: opt(Schema.String),
  commit: opt(Schema.String),
  head: opt(Schema.String),
  kind: TargetKindSchema,
  paths: opt(Schema.Array(Schema.String)),
  pr: opt(Schema.String),
});

export type Target = typeof TargetSchema.Type;

const ActorSchema = Schema.Struct({
  agent: Schema.String,
  session: Schema.String,
});

export type Actor = typeof ActorSchema.Type;

const RegionSchema = Schema.Struct({
  disposition: opt(DispositionSchema),
  file: Schema.String,
  /** Where a hunk chunk renders from: its `@@` line, and the old- and new-side numbers at patchStart. Older seals omit them. */
  hunkStart: opt(Count),
  id: Schema.String,
  key: opt(Schema.String),
  newEnd: Count,
  newLine: opt(Count),
  newStart: Count,
  note: opt(Schema.String),
  offsets: opt(Schema.Record(Schema.String, Count)),
  oldLine: opt(Count),
  ownerRead: opt(Schema.Boolean),
  patchEnd: Count,
  patchStart: Count,
  readBy: since(list(Schema.String), []),
  /** The line of the chunk's `diff --git` section header. Older seals omit it. */
  sectionStart: opt(Count),
});

export type Region = typeof RegionSchema.Type;

const FileEntrySchema = Schema.Struct({
  added: Count,
  excluded: opt(Schema.String),
  oldPath: opt(Schema.String),
  path: Schema.String,
  removed: Count,
  status: FileStatus,
});

export type FileEntry = typeof FileEntrySchema.Type;

const AnchorSchema = Schema.Struct({
  endLine: Count,
  line: Count,
  path: Schema.String,
  side: SideSchema,
});

export type Anchor = typeof AnchorSchema.Type;

const VerdictSchema = Schema.Struct({
  at: Time,
  by: ActorSchema,
  evidence: list(Schema.String),
  of: opt(Schema.String),
  rationale: Schema.String,
  severity: opt(SeveritySchema),
  verdict: VerdictKind,
});

export type Verdict = typeof VerdictSchema.Type;

const EntrySchema = Schema.Struct({
  anchor: AnchorSchema,
  brief: opt(Schema.String),
  /** In a re-check: the entry this one continues in the earlier review, and its status when that review reported. */
  carried: opt(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["confirmed", "unverified"]),
    })
  ),
  consequence: Schema.String,
  createdAt: Time,
  evidence: list(Schema.String),
  fix: opt(Schema.String),
  history: opt(list(VerdictSchema)),
  id: Schema.String,
  kind: KindSchema,
  lens: Schema.String,
  quote: Schema.String,
  raisedBy: ActorSchema,
  severity: SeveritySchema,
  staleReason: opt(Schema.String),
  status: EntryStatus,
  title: Schema.String,
  trigger: Schema.String,
  verdicts: list(VerdictSchema),
});

export type Entry = typeof EntrySchema.Type;

const NoteSchema = Schema.Struct({
  at: Time,
  by: ActorSchema,
  kind: NoteKind,
  text: Schema.String,
});

export type Note = typeof NoteSchema.Type;

const ChildSchema = Schema.Struct({
  agent: Schema.String,
  call: Schema.String,
  /** The human-readable part of the OpenCode child session's title. */
  description: opt(Schema.String),
  endedAt: opt(Time),
  followUp: opt(
    Schema.Struct({
      delivered: opt(Schema.Boolean),
      inbox: opt(Schema.String),
    })
  ),
  /** The model the launch named, which for a Directorate SeatSchema is its seat. */
  model: opt(Schema.String),
  prompt: Schema.String,
  session: opt(Schema.String),
  startedAt: Time,
  status: ChildStatus,
});

export type Child = typeof ChildSchema.Type;

/** Each gate remembers what it already pushed back on; it fires again only for something new. */
const GatesSchema = Schema.Struct({
  children: opt(orLegacyTrue(list(Schema.String), [])),
  coverage: opt(orLegacyTrue(list(Schema.String), [])),
  // A legacy `true` matched no fingerprint, so it decodes to one that matches none.
  freshness: opt(orLegacyTrue(Schema.String, "")),
  open: opt(orLegacyTrue(list(Schema.String), [])),
  panel: opt(list(Schema.String)),
});

export type Gates = typeof GatesSchema.Type;

/** A Directive's status: complete, partial (something went unreviewed or undecided), or stale (the code moved). */
export const DirectiveStatusSchema = Schema.Literals([
  "complete",
  "partial",
  "stale",
]);

export type DirectiveStatus = typeof DirectiveStatusSchema.Type;

const SealSchema = Schema.Struct({
  abandoned: opt(Schema.Boolean),
  autoReported: opt(Schema.Boolean),
  baseSha: Schema.String,
  baseTip: opt(Schema.String),
  budgetMinutes: Schema.Finite,
  children: since(list(ChildSchema), []),
  createdAt: Time,
  deadline: Time,
  deleted: since(list(Schema.String), []),
  description: Schema.String,
  /** What the reported Directive stated, so a ship reads it from the seal; seals reported by older versions omit it. */
  directive: opt(
    Schema.Struct({
      reasons: list(Schema.String),
      status: DirectiveStatusSchema,
    })
  ),
  files: since(list(FileEntrySchema), []),
  fingerprint: Schema.String,
  freshnessUnverified: opt(Schema.String),
  gates: since(GatesSchema, {}),
  gen: since(Count, 0),
  /**
   * Whether the user interrupted the Liaison: true keeps automatic recovery off until a resume or takeover, which sets
   * false. A missed interruption is read from the session's history after the last resume.
   */
  halted: opt(Schema.Boolean),
  headSha: Schema.String,
  /** The directory of the OpenCode instance that sealed it, whose watchdog reports it if the Liaison does not. */
  host: opt(Schema.String),
  id: Schema.String,
  /** Lenses the settings turned off for this review. */
  lensesOff: opt(list(Schema.String)),
  mode: ModeSchema,
  owner: Schema.String,
  ownerSession: Schema.String,
  /** A panel review's Directorate Seats: one model per SeatSchema. */
  panel: opt(list(Schema.String)),
  /** The server process that sealed, took over, or recovered the review: while it lives, no other process recovers it. */
  pid: opt(Schema.Finite),
  postImage: Schema.Literals(["worktree", "commit"]),
  /** Liaison sessions that owned this seal before a takeover, for full exports. */
  previousOwnerSessions: opt(list(Schema.String)),
  question: opt(Schema.String),
  /** A re-check: the reported seal it follows, whose findings it carries and re-decides. */
  recheckOf: opt(Schema.String),
  /** The last recovery wake. Until admitted, the same ID is submitted again. */
  recovery: opt(
    Schema.Struct({
      admitted: opt(Schema.Boolean),
      admittedAt: opt(Time),
      id: Schema.String,
      ownerSession: Schema.String,
    })
  ),
  refreshes: since(Count, 0),
  regions: since(list(RegionSchema), []),
  repo: Schema.String,
  reportedAt: opt(Time),
  /** History before an explicit resume or takeover must not halt the resumed review. */
  resumedAt: opt(Time),
  /** The ship whose loop this review belongs to. Only that ship continues it, even after the ship is stopped. */
  ship: opt(Schema.String),
  sigs: opt(Schema.Record(Schema.String, Schema.String)),
  staleFiles: opt(list(Schema.String)),
  target: TargetSchema,
});

export type Seal = typeof SealSchema.Type;

const LedgerSchema = Schema.Struct({
  entries: list(EntrySchema),
  notes: list(NoteSchema),
});

export type Ledger = typeof LedgerSchema.Type;

export const SealJson = Schema.fromJsonString(SealSchema, { space: 2 });
export const LedgerJson = Schema.fromJsonString(LedgerSchema, { space: 2 });

// ---------- tool input values ----------
export const invalid = (
  input: string,
  options: SchemaAST.ParseOptions,
  message: string
) => Effect.fail(new SchemaIssue.InvalidValue({ message }, input, options));

export const isUrl = (ref: string) => /^https?:\/\//u.test(ref.trim());

/** A model as the subagent tool takes it; whether it is available is checked when the Directorate SeatSchema launches. */
export const ModelRef = Schema.String.check(
  Schema.makeFilter(
    (m: string) =>
      /^[^/\s#]+\/[^\s#]+(?<path>#[^\s#]+)?$/u.test(m) ||
      `Model ${m} must be "providerID/modelID" or "providerID/modelID#variant".`
  )
);

/** Which directorate.json: global (in OpenCode's global config directory, ~/.config/opencode) or the project's (<repo>/.opencode). */
export const SettingsScopeSchema = Schema.Literals(["global", "project"]);

export type SettingsScope = typeof SettingsScopeSchema.Type;

const Minutes = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(2),
  Schema.isLessThanOrEqualTo(240)
);

/** A Directorate Seat (panel seat): a chat model and its thinking level. */
const SeatSchema = Schema.Struct({
  model: Schema.String.check(
    Schema.makeFilter(
      (m: string) =>
        /^[^/\s#]+\/[^\s#]+$/u.test(m) ||
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

export type Seat = typeof SeatSchema.Type;

/** directorate.json. Every key is optional; an absent key falls through to the global file, then to Directorate defaults. */
export const SettingsSchema = Schema.Struct({
  budget_minutes: Schema.optionalKey(
    Schema.Struct({
      "code-quality": Schema.optionalKey(Minutes),
      default: Schema.optionalKey(Minutes),
      full: Schema.optionalKey(Minutes),
    }).annotate({
      description: "Time budget per mode, used as-is (panel reviews too).",
    })
  ),
  default_scope: Schema.optionalKey(
    ReviewScopeSchema.annotate({
      description: "Review scope when the request names no scope or target.",
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
  mode: Schema.optionalKey(
    ModeSchema.annotate({
      description: "Review mode when the request names none.",
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
        Schema.Array(SeatSchema)
          .check(Schema.isMinLength(1))
          .annotate({ description: "The panel's seats, in order." })
      ),
    })
  ),
});

export type Settings = typeof SettingsSchema.Type;

export const seatRef = (s: Seat) =>
  s.variant ? `${s.model}#${s.variant}` : s.model;

/** Drops unset fields and empty sections, but keeps an explicit empty disabled-lens list. */
export const normalizeSettings = (s: Settings): Settings => {
  const b = s.budget_minutes;

  const budgets = {
    ...(b?.["code-quality"] !== undefined && {
      "code-quality": b["code-quality"],
    }),
    ...(b?.default !== undefined && { default: b.default }),
    ...(b?.full !== undefined && { full: b.full }),
  };

  const p = s.panel;

  const panel = {
    ...(p?.enabled !== undefined && { enabled: p.enabled }),
    ...(p?.models?.length && { models: p.models }),
  };

  return {
    ...(Object.keys(budgets).length && { budget_minutes: budgets }),
    ...(s.default_scope && { default_scope: s.default_scope }),
    ...(s.lenses?.disabled !== undefined && {
      lenses: { disabled: s.lenses.disabled },
    }),
    ...(s.mode && { mode: s.mode }),
    ...(Object.keys(panel).length && { panel }),
  };
};

/** No key set: writing these settings removes the file. */
export const isUnset = (s: Settings) =>
  Object.keys(normalizeSettings(s)).length === 0;

const settingsEquivalent = Schema.toEquivalence(SettingsSchema);

export const sameSettings = (a: Settings, b: Settings) =>
  settingsEquivalent(normalizeSettings(a), normalizeSettings(b));
