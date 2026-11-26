// The Ship link of seal.json: the ship whose loop a review belongs to. The field is the ship's, but the ship never writes
// the seal; review stamps it, at sealing or when its watchdog adopts an older seal, with the id the ship hands it.
import type { Seal } from "../../seal/record.ts";

/** The ship whose loop the review belongs to, stamped by review with the id the ship hands it. */
export const shipped = (seal: Seal, ship: string) => seal.withShip(ship);
