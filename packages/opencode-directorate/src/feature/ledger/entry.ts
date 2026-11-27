// The Dossier as stored in ledger.json: entries, their verdicts, and the Liaison's notes. Every value is read-only: a change
// builds the next one through its constructor.
import { Schema } from "effect";

import { Time } from "../../platform/stored.ts";
import { Anchor } from "../../seal/region.ts";
import { Actor } from "../agents/agent.ts";

const list = Schema.Array;
const opt = Schema.optional;

/** The one spelling of an entry id, `F` and its 1-based filing number: anchored for a whole value, word-bounded in text. */
const ENTRY_ID = String.raw`F[1-9]\d*`;

export const EntryIdSchema = Schema.String.check(
  Schema.isPattern(new RegExp(`^${ENTRY_ID}$`, "u"))
).pipe(Schema.brand("EntryId"));

export type EntryId = typeof EntryIdSchema.Type;

export const isEntryId = Schema.is(EntryIdSchema);

/** A string as an entry id, or none when it is not one. */
export const asEntryId = Schema.decodeUnknownOption(EntryIdSchema);

/** The id of the `n`th entry filed in a ledger (1-based). */
export const nthEntryId = (n: number) => EntryIdSchema.make(`F${n}`);

const ENTRY_IDS_IN_TEXT = new RegExp(String.raw`\b${ENTRY_ID}\b`, "gu");

/** Every entry id written in `text`, in order. */
export const entryIdsIn = (text: string) =>
  (text.match(ENTRY_IDS_IN_TEXT) ?? []).filter(isEntryId);

export const SeveritySchema = Schema.Literals([
  "blocking",
  "important",
  "minor",
]);

export type Severity = typeof SeveritySchema.Type;

export const isMinor = Schema.is(SeveritySchema.pick(["minor"]));

export const KindSchema = Schema.Literals(["defect", "test-gap", "quality"]);

/** The review lenses: one playbook each under the directorate-lenses skill's references/. */
export const LensSchema = Schema.Literals([
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
]);

export type Lens = typeof LensSchema.Type;

/** `resolved`: a finding carried from the review a re-check follows no longer holds on the new code. */
export const VerdictKindSchema = Schema.Literals([
  "confirmed",
  "refuted",
  "duplicate",
  "resolved",
]);

export type VerdictKind = typeof VerdictKindSchema.Type;

export const isConfirming = Schema.is(VerdictKindSchema.pick(["confirmed"]));

export const isRefuting = Schema.is(VerdictKindSchema.pick(["refuted"]));

export const isDuplicating = Schema.is(VerdictKindSchema.pick(["duplicate"]));

export const isResolving = Schema.is(VerdictKindSchema.pick(["resolved"]));

export const EntryStatusSchema = Schema.Literals([
  "open",
  "confirmed",
  "refuted",
  "duplicate",
  "resolved",
]);

const isOpenStatus = Schema.is(EntryStatusSchema.pick(["open"]));

const isConfirmedStatus = Schema.is(EntryStatusSchema.pick(["confirmed"]));

const isRefutedStatus = Schema.is(EntryStatusSchema.pick(["refuted"]));

const isDuplicateStatus = Schema.is(EntryStatusSchema.pick(["duplicate"]));

const isResolvedStatus = Schema.is(EntryStatusSchema.pick(["resolved"]));

/** `answered`: the Liaison answered a failed Auditor's question itself; its text is that question. */
export const NoteKindSchema = Schema.Literals([
  "unanswered",
  "limit",
  "assumption",
  "answered",
]);

/** The Liaison answered a failed Auditor's question itself. */
export const isAnswered = Schema.is(NoteKindSchema.pick(["answered"]));

const isUnansweredKind = Schema.is(NoteKindSchema.pick(["unanswered"]));

const isAssumptionKind = Schema.is(NoteKindSchema.pick(["assumption"]));

/** The kinds the Directive lists under Outside Containment (Not Reviewed). */
const isNotReviewedKind = Schema.is(
  NoteKindSchema.pick(["unanswered", "limit"])
);

/** What a carried entry was when the earlier review reported: verified, or filed and never cleared. */
export const CarriedStatusSchema = Schema.Literals(["confirmed", "unverified"]);

export type CarriedStatus = typeof CarriedStatusSchema.Type;

const isVerifiedCarry = Schema.is(CarriedStatusSchema.pick(["confirmed"]));

/** Filed in the earlier review and never cleared there. */
export const isUnverifiedCarry = Schema.is(
  CarriedStatusSchema.pick(["unverified"])
);

/** A decision on an entry: who made it, on what evidence, and (confirming) at what severity or (duplicate) of what. */
export class Verdict extends Schema.Class<
  Verdict,
  { readonly brand: unique symbol }
>("directorate/Verdict")({
  at: Time,
  by: Actor,
  evidence: list(Schema.String),
  of: opt(EntryIdSchema),
  rationale: Schema.String,
  severity: opt(SeveritySchema),
  verdict: VerdictKindSchema,
}) {}

/** In a re-check: the entry an entry continues in the earlier review, and its status when that review reported. */
export class Carried extends Schema.Class<
  Carried,
  { readonly brand: unique symbol }
>("directorate/Carried")({
  id: EntryIdSchema,
  status: CarriedStatusSchema,
}) {
  /** Verified (confirmed) when the earlier review reported, rather than filed and never cleared. */
  get wasVerified() {
    return isVerifiedCarry(this.status);
  }
}

/** A candidate finding: filed open, then decided by verdicts; reopened (its verdicts moved to history) when its code moves. */
export class Entry extends Schema.Class<
  Entry,
  { readonly brand: unique symbol }
>("directorate/Entry")({
  anchor: Anchor,
  brief: opt(Schema.String),
  carried: opt(Carried),
  consequence: Schema.String,
  createdAt: Time,
  evidence: list(Schema.String),
  fix: opt(Schema.String),
  history: opt(list(Verdict)),
  id: EntryIdSchema,
  kind: KindSchema,
  lens: LensSchema,
  quote: Schema.String,
  raisedBy: Actor,
  severity: SeveritySchema,
  staleReason: opt(Schema.String),
  status: EntryStatusSchema,
  title: Schema.String,
  trigger: Schema.String,
  verdicts: list(Verdict),
}) {
  get isOpen() {
    return isOpenStatus(this.status);
  }

  get isConfirmed() {
    return isConfirmedStatus(this.status);
  }

  get isRefuted() {
    return isRefutedStatus(this.status);
  }

  get isDuplicate() {
    return isDuplicateStatus(this.status);
  }

  get isResolved() {
    return isResolvedStatus(this.status);
  }

  /** Decided by `verdict`: its status, no longer stale, and (confirming) pinned to the sealed code it was checked against. */
  decided(verdict: Verdict, anchored?: Pick<Entry, "anchor" | "quote">) {
    return new Entry({
      ...this,
      ...anchored,
      staleReason: undefined,
      status: verdict.verdict,
      verdicts: [...this.verdicts, verdict],
    });
  }

  /** This entry continued in a re-check as `id`, remembering what it was there. */
  carriedAs(id: EntryId, status: CarriedStatus) {
    return new Entry({
      ...this,
      carried: Carried.make({ id: this.id, status }),
      id,
    });
  }
}

/** A coverage limit, an unanswered or answered question, or an assumption, as the Directive reports it. */
export class Note extends Schema.Class<Note, { readonly brand: unique symbol }>(
  "directorate/Note"
)({
  at: Time,
  by: Actor,
  kind: NoteKindSchema,
  text: Schema.String,
}) {
  get isUnanswered() {
    return isUnansweredKind(this.kind);
  }

  get isAssumption() {
    return isAssumptionKind(this.kind);
  }

  /** A limit or an unanswered question: listed under Outside Containment (Not Reviewed). */
  get isNotReviewed() {
    return isNotReviewedKind(this.kind);
  }
}

/** The Dossier: ledger.json. */
export class Ledger extends Schema.Class<
  Ledger,
  { readonly brand: unique symbol }
>("directorate/Ledger")({
  entries: list(Entry),
  notes: list(Note),
}) {
  /** The id the next filed entry takes. */
  get nextEntryId() {
    return nthEntryId(this.entries.length + 1);
  }

  /** The entry with this id, if any. */
  entryById(id: EntryId | undefined) {
    return this.entries.find((e) => e.id === id);
  }

  /** With `entry` filed after the others. */
  filed(entry: Entry) {
    return new Ledger({ ...this, entries: [...this.entries, entry] });
  }

  /** With `note` recorded after the others. */
  noted(note: Note) {
    return new Ledger({ ...this, notes: [...this.notes, note] });
  }

  /** The Ledger's entries rebuilt: the ledger's transitions call it. */
  withEntries(entries: readonly Entry[]) {
    return new Ledger({ ...this, entries });
  }
}

export const LedgerJson = Schema.fromJsonString(Ledger, { space: 2 });
