import { Crypto, Effect } from "effect";
import { Hex } from "effect/encoding";

/** SHA-256 in hex. The algorithm is always supported, so a digest failure is a defect. */
export const sha256 = Effect.fnUntraced(function* (s: string | Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(
    yield* crypto.digest(
      "SHA-256",
      typeof s === "string" ? new TextEncoder().encode(s) : s
    )
  );
}, Effect.orDie);
