import { Effect, Predicate } from "effect";
import { Digest } from "effect/crypto";

/** SHA-256 in hex. */
export const sha256 = Effect.fnUntraced(function* sha256(
  s: string | Uint8Array
) {
  const digest = yield* Digest.Digest;

  return yield* digest.digestHex(
    Digest.sha256,
    Predicate.isString(s) ? new TextEncoder().encode(s) : s
  );
});
