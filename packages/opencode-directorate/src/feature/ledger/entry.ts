// The Dossier as stored in ledger.json: entries, their verdicts, and the Liaison's notes.
import { Schema } from "effect";

import { Time } from "../../platform/stored.ts";
import { Anchor } from "../../seal/region.ts";
import { ActorSchema } from "../agents/agent.ts";

const list = Schema.Array;
const opt = Schema.optional;

export const SeveritySchema = Schema.Literals([
  "blocking",
  "important",
  "minor",
]);

export type Severity = typeof SeveritySchema.Type;

export const KindSchema = Schema.Literals(["defect", "test-gap", "quality"]);

export type Kind = typeof KindSchema.Type;

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
  anchor: Anchor,
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

const LedgerSchema = Schema.Struct({
  entries: list(EntrySchema),
  notes: list(NoteSchema),
});

export type Ledger = typeof LedgerSchema.Type;

export const LedgerJson = Schema.fromJsonString(LedgerSchema, { space: 2 });
