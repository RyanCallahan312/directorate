// What a review seals: the target kinds and the stored target.
import { Schema } from "effect";

const opt = Schema.optional;

export const TargetKindSchema = Schema.Literals([
  "auto",
  "local",
  "commit",
  "range",
  "pr",
  "paths",
]);

export type TargetKind = typeof TargetKindSchema.Type;

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
