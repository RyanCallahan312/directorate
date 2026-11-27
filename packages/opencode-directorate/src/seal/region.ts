// The sealed diff's geometry: changed files, the regions reviewers read and mark, and the anchors entries point at.
import { Schema } from "effect";

import { SessionIdSchema } from "../platform/host-id.ts";
import type { SessionId } from "../platform/host-id.ts";
import { Count } from "../platform/stored.ts";

const list = Schema.Array;
const opt = Schema.optional;

export const SideSchema = Schema.Literals(["new", "old"]);

export type Side = typeof SideSchema.Type;

/** The base side: the code before the change. */
export const isBaseSide = Schema.is(SideSchema.pick(["old"]));

/** The sealed side: the post-image the review pinned. */
export const isSealedSide = Schema.is(SideSchema.pick(["new"]));

/** Each side's name in messages. */
export const SIDE_NAMES = Schema.Record(SideSchema, Schema.String).make({
  new: "sealed",
  old: "base",
});

export const DispositionSchema = Schema.Literals([
  "reviewed",
  "skimmed",
  "skipped",
]);

export type Disposition = typeof DispositionSchema.Type;

export const isReviewed = Schema.is(DispositionSchema.pick(["reviewed"]));

export const FileStatusSchema = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "binary",
  "mode",
  "unchanged",
]);

const isDeletedStatus = Schema.is(FileStatusSchema.pick(["deleted"]));

const isUnchangedStatus = Schema.is(FileStatusSchema.pick(["unchanged"]));

/** The reader key the lead's reads are recorded under; every other reader is recorded by its session. */
const OwnerMarkSchema = Schema.Literal("owner");

export const isOwnerMark = Schema.is(OwnerMarkSchema);

/** The key a reader's reads are recorded under: the owner mark for the lead, its session for anyone else. */
const ReaderKeySchema = Schema.Union([OwnerMarkSchema, SessionIdSchema]);

/** Who is reading regions: the key its reads are recorded under, and whether it is the lead. */
const ReaderSchema = Schema.Struct({
  key: ReaderKeySchema,
  owner: Schema.Boolean,
});

export type Reader = typeof ReaderSchema.Type;

/** The reader a session is: the lead (the seal's owner session) under the owner mark, anyone else under its session. */
export const readerOf = (
  session: SessionId,
  ownerSession: SessionId | undefined
) =>
  ReaderSchema.make(
    session === ownerSession
      ? { key: OwnerMarkSchema.literal, owner: true }
      : { key: session, owner: false }
  );

/** A chunk of the sealed diff (or of a whole file, for a paths target): its geometry, and who read or disposed of it. */
export class Region extends Schema.Class<
  Region,
  { readonly brand: unique symbol }
>("directorate/Region")({
  disposition: opt(DispositionSchema),
  file: Schema.String,
  /** Where a hunk chunk renders from: its `@@` line, and the old- and new-side numbers at patchStart. Hunk chunks only. */
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
  readBy: list(ReaderKeySchema),
  /** The line of the chunk's `diff --git` section header. Hunk chunks only. */
  sectionStart: opt(Count),
}) {
  /** Read by the lead, or reviewed by disposition: a region that counts as observed. */
  get isRead() {
    return (
      (!this.disposition && Boolean(this.ownerRead)) ||
      isReviewed(this.disposition)
    );
  }

  /** Shown to `reader` up to `next`; read through when `complete`. */
  shown(reader: Reader, next: number, complete: boolean) {
    const offsets = { ...this.offsets, [reader.key]: next };

    if (!complete) {
      return new Region({ ...this, offsets });
    }

    return new Region({
      ...this,
      offsets,
      ownerRead: reader.owner || this.ownerRead,
      readBy: this.readBy.includes(reader.key)
        ? this.readBy
        : [...this.readBy, reader.key],
    });
  }

  /** Disposed of with a note. */
  disposed(disposition: Disposition, note: string) {
    return new Region({ ...this, disposition, note });
  }

  /** This region, carrying the receipts and disposition of an earlier region with the same content. */
  carrying(earlier: Region) {
    return new Region({
      ...this,
      disposition: earlier.disposition,
      note: earlier.note,
      ownerRead: earlier.ownerRead,
      readBy: earlier.readBy,
    });
  }
}

/** A changed (or, for a paths target, listed) file in the sealed diff. */
export class FileEntry extends Schema.Class<
  FileEntry,
  { readonly brand: unique symbol }
>("directorate/FileEntry")({
  added: Count,
  excluded: opt(Schema.String),
  oldPath: opt(Schema.String),
  path: Schema.String,
  removed: Count,
  status: FileStatusSchema,
}) {
  /** Gone from the post-image. */
  get isDeleted() {
    return isDeletedStatus(this.status);
  }

  /** Changed by the target; a whole-file target also lists files it leaves unchanged. */
  get isChanged() {
    return !isUnchangedStatus(this.status);
  }
}

/**
 * What changed between a seal and a later look at its target: the files, whether a commit pair's base moved, and why
 * nothing could be listed when the target moved out of reach.
 */
export class Changes extends Schema.Class<
  Changes,
  { readonly brand: unique symbol }
>("directorate/Changes")({
  baseMoved: Schema.Boolean,
  files: list(Schema.String),
  unfetched: opt(Schema.String),
}) {
  /** As shown: the files in order with "(base moved)" among them, or only why the target is out of reach. */
  get listed() {
    if (this.unfetched) {
      return [`(${this.unfetched})`];
    }

    return [
      ...new Set([...this.files, ...(this.baseMoved ? ["(base moved)"] : [])]),
    ].toSorted();
  }
}

/** Where an entry points: a line span on one side of the sealed code. Stored in ledger.json entries. */
export class Anchor extends Schema.Class<
  Anchor,
  { readonly brand: unique symbol }
>("directorate/Anchor")({
  endLine: Count,
  line: Count,
  path: Schema.String,
  side: SideSchema,
}) {}
