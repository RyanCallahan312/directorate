// Stored-schema helpers: the shared field schemas and evolution helpers every stored record (seal.json, ledger.json) uses.
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import type { SchemaAST } from "effect";

/** Line numbers, patch offsets, and counts: whole and never negative (0 marks a region with no new lines). */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Written by every current version; older seals may omit it. */
export const since = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

/** Older seals stored `true` where current ones store a value. */
export const orLegacyTrue = <S extends Schema.Top>(
  schema: S,
  value: S["Encoded"]
) =>
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
export const Time = Schema.DateTimeUtcFromString;

/**
 * Field groups merged into one stored record, in alphabetical key order: a struct encodes its keys in field order, and
 * stored records have always written theirs sorted.
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
