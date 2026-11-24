import { Crypto, Effect, Predicate } from "effect";
import { Hex } from "effect/encoding";

/** SHA-256 in hex. The algorithm is always supported, so a digest failure is a defect. */
export const sha256 = Effect.fnUntraced(function* sha256(
  s: string | Uint8Array
) {
  const crypto = yield* Crypto.Crypto;

  return Hex.encode(
    yield* crypto.digest(
      "SHA-256",
      Predicate.isString(s) ? new TextEncoder().encode(s) : s
    )
  );
}, Effect.orDie);
