// The sealed diff's geometry: changed files, the regions reviewers read and mark, and the anchors entries point at.
import { Schema } from "effect";

import { Count, since } from "../platform/stored.ts";

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

export type FileStatus = typeof FileStatusSchema.Type;

const isDeletedStatus = Schema.is(FileStatusSchema.pick(["deleted"]));

/** The reader key the lead's reads are recorded under; every other reader is recorded by its session. */
export const isOwnerMark = Schema.is(Schema.Literal("owner"));

/** Who is reading regions: the key its reads are recorded under, and whether it is the lead. */
export const ReaderSchema = Schema.Struct({
  key: Schema.String,
  owner: Schema.Boolean,
});

export type Reader = typeof ReaderSchema.Type;

/** A chunk of the sealed diff (or of a whole file, for a paths target): its geometry, and who read or disposed of it. */
export class Region extends Schema.Class<
  Region,
  { readonly brand: unique symbol }
>("directorate/Region")({
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
