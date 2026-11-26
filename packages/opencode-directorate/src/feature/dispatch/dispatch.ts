// Dispatch: each Auditor, Seat, or Compliance run the Liaison sends out in this review. The slice's entry: the subagent
// hooks, the one ordered session-event consumer, directorate_wait, and settling runs after a reload.
import { Effect } from "effect";

import { consumeSessionEvents } from "./events.ts";
import type { SessionEvent } from "./events.ts";
import { registerLaunches } from "./launch.ts";

export { settleChildren } from "./events.ts";

export type { SessionEvent } from "./events.ts";

export { waitTool } from "./wait.ts";

/** The subagent hooks, then the ordered session-event consumer; `before` hears each event ahead of the review's runs. */
export const registerDispatch = Effect.fnUntraced(function* registerDispatch(
  before: (event: SessionEvent) => Effect.Effect<void>
) {
  yield* registerLaunches();
  yield* consumeSessionEvents(before);
});
