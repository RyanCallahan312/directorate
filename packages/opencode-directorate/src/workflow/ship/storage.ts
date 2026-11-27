// Where ship state lives: `ship:<sessionID>` in OpenCode plugin storage, read only by this location's ships.
import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Option, Schema } from "effect";

import { asSessionId } from "../../platform/host-id.ts";
import type { SessionId } from "../../platform/host-id.ts";
import { locationKey } from "../../platform/platform.ts";
import { paused, ShipStateFromStored, toStored, unqueued } from "./state.ts";
import type { ShipFields, ShipState } from "./state.ts";

const decode = Schema.decodeUnknownEffect(ShipStateFromStored);
const decodeSnapshot = Schema.decodeUnknownOption(ShipStateFromStored);
const prefix = "ship:";
const storageKey = (id: SessionId) => `${prefix}${id}`;

/** The ship store for this plugin instance, at its host's location; `foreignOwner` says whether another live server drives a ship. */
export const shipStorage = (
  host: Plugin.Context,
  foreignOwner: (owner: number) => Effect.Effect<boolean>
) => {
  const location = locationKey(host.location);

  const write = (sessionID: SessionId, state: ShipState) =>
    host.storage.set(storageKey(sessionID), toStored(state));

  const pause = Effect.fnUntraced(function* pause(
    sessionID: SessionId,
    state: ShipFields,
    reason: string
  ) {
    const next = paused(state, reason);
    yield* write(sessionID, next);

    return next;
  });

  /** Pauses for `reason` a ship whose input is no longer queued. */
  const unqueue = Effect.fnUntraced(function* unqueue(
    sessionID: SessionId,
    state: ShipFields,
    reason: string
  ) {
    const next = unqueued(state, reason);
    yield* write(sessionID, next);

    return next;
  });

  const read = Effect.fn("Ship.read")(function* read(
    sessionID: SessionId,
    command = false
  ) {
    const raw = yield* host.storage.get(storageKey(sessionID));

    if (raw === undefined) {
      return;
    }

    const state = yield* decode(raw);

    // The host shares storage and events across locations.
    if (state.location !== location) {
      return command ? state : undefined;
    }

    return !command && (yield* foreignOwner(state.pid)) ? undefined : state;
  });

  /** Removes the session's ship record. */
  const drop = (sessionID: SessionId) =>
    host.storage.remove(storageKey(sessionID));

  /** One page of every stored ship, from any location, skipping records that do not decode. */
  const scan = (after: string | undefined) =>
    host.storage.scan(after ? { after, prefix } : { prefix }).pipe(
      Effect.map((page) => ({
        next: page.next,
        ships: page.entries.flatMap(({ key, value }) =>
          Option.match(
            Option.all({
              sessionID: asSessionId(key.slice(prefix.length)),
              snapshot: decodeSnapshot(value),
            }),
            { onNone: () => [], onSome: (ship) => [ship] }
          )
        ),
      }))
    );

  return {
    drop,
    location,
    pause,
    read,
    scan,
    unqueue,
    write,
  };
};
