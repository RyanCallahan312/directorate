// The sealed diff's geometry: changed files, the regions reviewers read and mark, and the anchors entries point at.
import { Schema } from "effect";

import { Count, since } from "../platform/stored.ts";

const list = Schema.Array;
const opt = Schema.optional;

export const SideSchema = Schema.Literals(["new", "old"]);

export type Side = typeof SideSchema.Type;

export const DispositionSchema = Schema.Literals([
  "reviewed",
  "skimmed",
  "skipped",
]);

export type Disposition = typeof DispositionSchema.Type;

const FileStatus = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "binary",
  "mode",
  "unchanged",
]);

export const RegionSchema = Schema.Struct({
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

export const FileEntrySchema = Schema.Struct({
  added: Count,
  excluded: opt(Schema.String),
  oldPath: opt(Schema.String),
  path: Schema.String,
  removed: Count,
  status: FileStatus,
});

export type FileEntry = typeof FileEntrySchema.Type;

export const AnchorSchema = Schema.Struct({
  endLine: Count,
  line: Count,
  path: Schema.String,
  side: SideSchema,
});

export type Anchor = typeof AnchorSchema.Type;
