// The Ship link of seal.json: the ship whose loop a review belongs to. The field is the ship's, but the ship never writes
// the seal; review stamps it at sealing, with the id the ship hands it.
import { Schema } from "effect";

import type { Seal } from "../../seal/record.ts";

/** A ship's id: the UUID it was started with, which the Liaison hands back to `directorate_seal` as `ship`. */
export const ShipIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("ShipId")
);

export type ShipId = typeof ShipIdSchema.Type;

/** A string as a ship id, or none when it is not one. */
export const asShipId = Schema.decodeUnknownOption(ShipIdSchema);

/** The ship whose loop the review belongs to, stamped by review with the id the ship hands it. */
export const shipped = (seal: Seal, ship: ShipId) => seal.withShip(ship);
