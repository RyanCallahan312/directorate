// The session prefix, as one hook per request kind: the Liaison's frozen settings line, then the lockdown notice and
// tool stripping. One hook, so both read one active seal and the prefix is built in one pass, in this order.
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Effect } from "effect";

import { lockdown, withholdHarness } from "../../feature/agents/agents.ts";
import { adapter, Host } from "../../platform/platform.ts";
import type { ToolCatalog } from "../../platform/platform.ts";
import type { Seal } from "../../seal/record.ts";
import { Sessions } from "../../seal/seal.ts";

/** `settingsLine` pushes the Liaison's `[directorate settings]` line for its active seal, if any. */
export const sessionPrefix = Effect.fnUntraced(function* sessionPrefix(
  settingsLine: (
    event: SessionContext,
    seal: Seal | undefined
  ) => Effect.Effect<void>
) {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const { hook } = yield* adapter<ToolCatalog>();

  // Session prefix & lockdown: keep event.system and event.tools invariant across normal and drain so KV-cache prefixes
  // stay intact (tool results already append [DIRECTORATE // EVACUATION] at the tail); strip tools and push a lockdown
  // notice only once locked. Every request kind gets the same tools so compaction/generate keep the cache prefix too.
  for (const kind of ["context", "compaction", "generate"] as const) {
    yield* host.session.hook(
      kind,
      hook(kind, function* onSessionHook(event) {
        if (yield* withholdHarness(event)) {
          return;
        }

        const seal = yield* sessions.active(event.sessionID);

        yield* settingsLine(event, seal);

        if (!seal) {
          return;
        }

        yield* lockdown(event, seal);
      })
    );
  }
});
