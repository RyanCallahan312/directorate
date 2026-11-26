// The protocol gates' memory and the filed Directive: the Protocol & Directive field group of seal.json.
import { Schema } from "effect";

import { orLegacyTrue, since, Time } from "../../platform/stored.ts";

const list = Schema.Array;
const opt = Schema.optional;

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

/** The Protocol & Directive field group of seal.json. */
export const Protocol = Schema.Struct({
  autoReported: opt(Schema.Boolean),
  /** What the reported Directive stated, so a ship reads it from the seal; seals reported by older versions omit it. */
  directive: opt(
    Schema.Struct({
      reasons: list(Schema.String),
      status: DirectiveStatusSchema,
    })
  ),
  freshnessUnverified: opt(Schema.String),
  gates: since(GatesSchema, {}),
  reportedAt: opt(Time),
  staleFiles: opt(list(Schema.String)),
});
