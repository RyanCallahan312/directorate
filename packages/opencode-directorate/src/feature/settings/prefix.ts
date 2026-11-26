// The Liaison's `[directorate settings]` system line: configured defaults on every turn, frozen per active seal so
// mid-review edits to directorate.json never change the prompt prefix.
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Effect } from "effect";

import { Host } from "../../platform/platform.ts";
import type { Seal } from "../../seal/record.ts";
import { Sessions } from "../../seal/seal.ts";
import { agentNamed, Liaison } from "../agents/agent.ts";
import { describe } from "./file.ts";
import { SettingsStore } from "./store.ts";

export const settingsLines = Effect.fnUntraced(function* settingsLines() {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const settings = yield* SettingsStore;

  /** Frozen `[directorate settings]` system line per active seal, so mid-review file edits never bust the KV-cache prefix. */
  const sealSettingsLine = new Map<string, string | undefined>();

  /** The configured defaults for the session's directory, frozen for its seal if it has one. */
  const read = Effect.fnUntraced(function* read(
    event: SessionContext,
    seal: Seal | undefined
  ) {
    const directory =
      seal?.repo ??
      (yield* sessions.directory(event.sessionID)) ??
      host.location.directory;

    const line = yield* settings.load(directory).pipe(
      Effect.map((s) => describe(s.effective)),
      Effect.catch((error) => Effect.succeed(`unreadable: ${error.message}`))
    );

    if (seal) {
      sealSettingsLine.set(seal.id, line);
    }

    return line;
  });

  return {
    /** A reported seal's line is never read again. */
    forget: (sealId: string) => {
      sealSettingsLine.delete(sealId);
    },
    push: Effect.fnUntraced(function* push(
      event: SessionContext,
      seal: Seal | undefined
    ) {
      if (agentNamed(event.agent) !== Liaison) {
        return;
      }

      // Emit configured defaults on every Liaison turn and freeze the line once sealed so mid-review edits to
      // directorate.json do not mutate the system prefix.
      const line =
        seal && sealSettingsLine.has(seal.id)
          ? sealSettingsLine.get(seal.id)
          : yield* read(event, seal);

      if (line) {
        event.system.push({
          text: `[directorate settings] ${line}`,
          type: "text",
        });
      }
    }),
  };
});
