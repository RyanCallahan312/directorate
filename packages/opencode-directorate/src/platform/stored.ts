// Stored-schema helpers: the shared field schemas every stored record (seal.json, ledger.json) uses.
import { Effect, Schema, SchemaIssue } from "effect";
import type { SchemaAST } from "effect";

/** Line numbers, patch offsets, and counts: whole and never negative (0 marks a region with no new lines). */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A UTC instant, stored as an ISO string. */
export const Time = Schema.DateTimeUtcFromString;

/**
 * Field groups merged into one stored record, in alphabetical key order: a struct encodes its keys in field order, and
 * stored records write theirs sorted.
 */
export const sortedFields = <const Fields extends Schema.Struct.Fields>(
  fields: Fields
) =>
  // SAFETY: the entries are exactly fields' own entries, only reordered, so the object has the same keys and values.
  Object.fromEntries(
    Object.entries(fields).toSorted(([a], [b]) => (a < b ? -1 : 1))
  ) as Fields;

// ---------- tool input values ----------
export const invalid = (
  input: string,
  options: SchemaAST.ParseOptions,
  message: string
) => Effect.fail(new SchemaIssue.InvalidValue({ message }, input, options));
