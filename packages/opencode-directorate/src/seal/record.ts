// The seal record, seal.json: composed from the field groups each owner keeps, and decoded and encoded through SealJson.
// Domain types derive from it and are read-only: every change builds a new seal.
import { Schema } from "effect";

import { ChildSchema } from "../feature/dispatch/lifecycle.ts";
import { Protocol } from "../feature/report/directive.ts";
import { Count, since, sortedFields } from "../platform/stored.ts";
import { Custody } from "../workflow/review/custody.ts";
import { ModeSchema } from "../workflow/review/request.ts";
import { StoredWindow, windowCheck } from "../workflow/review/window.ts";
import { FileEntrySchema, RegionSchema } from "./region.ts";
import { TargetSchema } from "./target.ts";

const list = Schema.Array;
const opt = Schema.optional;

/** The Containment field group of seal.json. */
export const Containment = Schema.Struct({
  baseSha: Schema.String,
  baseTip: opt(Schema.String),
  deleted: since(list(Schema.String), []),
  description: Schema.String,
  files: since(list(FileEntrySchema), []),
  fingerprint: Schema.String,
  gen: since(Count, 0),
  headSha: Schema.String,
  id: Schema.String,
  /** Lenses the settings turned off for this review. */
  lensesOff: opt(list(Schema.String)),
  mode: ModeSchema,
  /** A panel review's Directorate Seats: one model per SeatSchema. */
  panel: opt(list(Schema.String)),
  postImage: Schema.Literals(["worktree", "commit"]),
  question: opt(Schema.String),
  /** A re-check: the reported seal it follows, whose findings it carries and re-decides. */
  recheckOf: opt(Schema.String),
  refreshes: since(Count, 0),
  regions: since(list(RegionSchema), []),
  repo: Schema.String,
  sigs: opt(Schema.Record(Schema.String, Schema.String)),
  target: TargetSchema,
});

// Keys stay in alphabetical order across the field groups: seal.json is encoded in field order.
const SealSchema = Schema.Struct(
  sortedFields({
    ...Containment.fields,
    ...StoredWindow.fields,
    ...Custody.fields,
    ...Protocol.fields,
    children: since(list(ChildSchema), []),
    /** The ship whose loop this review belongs to. Only that ship continues it, even after the ship is stopped. */
    ship: opt(Schema.String),
  })
  // Spreading StoredWindow's fields drops its check; the root re-applies it.
).check(windowCheck);

export type Seal = typeof SealSchema.Type;

export const SealJson = Schema.fromJsonString(SealSchema, { space: 2 });
