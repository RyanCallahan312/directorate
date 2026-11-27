// A seal's id: `directorate-<UTC yyyymmddhhmmss>-<6 hex>`, the name of its directory under the state root. Its own
// module so any slice can take or check one without importing the seal record.
import { Option, Schema } from "effect";

/** The one spelling of a seal id: anchored for a whole value, word-bounded to find one in text. */
const SEAL_ID = String.raw`directorate-\d{14}-[0-9a-f]{6}`;

export const SealIdSchema = Schema.String.check(
  Schema.isPattern(new RegExp(`^${SEAL_ID}$`, "u"))
).pipe(Schema.brand("SealId"));

export type SealId = typeof SealIdSchema.Type;

export const isSealId = Schema.is(SealIdSchema);

/** A string as a seal id, or none when it is not one. */
export const asSealId = Schema.decodeUnknownOption(SealIdSchema);

const SEAL_ID_IN_TEXT = new RegExp(String.raw`\b${SEAL_ID}\b`, "u");

/** The first seal id written in `text`, if any. */
export const sealIdIn = (text: string) =>
  Option.getOrUndefined(asSealId(SEAL_ID_IN_TEXT.exec(text)?.[0]));
