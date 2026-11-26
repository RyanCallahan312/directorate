// The host-facing surface: everything the plugin registers with OpenCode at load, in registration order. The host and
// the model see exactly this, so surface.test.ts pins it to test/stored/surface.json. Event subscriptions are listed
// apart from hooks: they start in fibers the load forks, so their place among the hooks is up to the scheduler.
// This module imports the plugin by relative path and nothing else from src/, so the same capture runs against any
// earlier tree of the package.
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Agent } from "@opencode/plugin/effect";
import type { Skill } from "@opencode/plugin/effect";
import {
  ConfigProvider,
  Effect,
  Exit,
  Function,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { Types } from "effect";

const { default: plugin } = await import("../src/index.ts");

type HostContext = Parameters<typeof plugin.effect>[0];

type RpcRegister = Parameters<HostContext["rpc"]["register"]>;

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Long model-facing text, as its hash and length: a change shows up without the fixture holding every prompt. */
const digest = (text: string) => ({
  length: text.length,
  sha256: sha256(text),
});

const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const decodeJsonObject = Schema.decodeUnknownSync(Schema.JsonObject);

const SkillJson = Schema.Struct({
  autoinvoke: Schema.optionalKey(Schema.Boolean),
  content: Schema.String,
  description: Schema.String,
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
});

interface RegisteredTool {
  description: string;
  input: Schema.Top;
  name: string;
  options?: Schema.Json;
}

interface RegisteredCommand {
  description?: string | undefined;
  name: string;
}

interface Registration {
  dispose: Effect.Effect<void>;
}

const registration: Registration = { dispose: Effect.void };

/** Loads the plugin against a host that only records what it is handed, and returns the surface as JSON. */
export const captureSurface = async () => {
  const tools: Schema.Json[] = [];
  const commands: Schema.Json[] = [];
  const agents: Schema.Json[] = [];
  const skills: Schema.Json[] = [];
  const rpcs: Schema.Json[] = [];
  const hooks: string[] = [];
  const subscriptions: Schema.Json[] = [];

  const state = realpathSync(
    mkdtempSync(path.join(tmpdir(), "directorate-surface-"))
  );

  const ctx = {
    agent: {
      transform: (register: Parameters<HostContext["agent"]["transform"]>[0]) =>
        Effect.sync(() => {
          const added = new Map<string, Types.DeepMutable<Agent.Info>>();

          register({
            default: Function.constVoid,
            get: (id) => added.get(id),
            list: () => [...added.values()],
            remove: Function.constVoid,
            update: (id, update) => {
              const agent =
                added.get(id) ?? Agent.Info.default(Agent.ID.make(id));

              update(agent);
              added.set(id, agent);
            },
          });

          for (const agent of added.values()) {
            const { system, ...fields } = decodeJsonObject(
              structuredClone(agent)
            );

            agents.push({
              ...fields,
              system: digest(Schema.decodeUnknownSync(Schema.String)(system)),
            });
          }

          return registration;
        }),
    },
    app: { version: "2.4.1" },
    command: {
      transform: (
        register: (editor: {
          add: (definition: RegisteredCommand) => void;
        }) => void
      ) =>
        Effect.sync(() => {
          register({
            add: ({ description, name }) => {
              commands.push(
                description === undefined ? { name } : { description, name }
              );
            },
          });

          return registration;
        }),
    },
    event: {
      subscribe: (input?: { types?: readonly string[] }) => {
        subscriptions.push(input?.types ? [...input.types] : "*");

        return Stream.never;
      },
    },
    location: { directory: state },
    permission: {
      hook: (name: string) =>
        Effect.sync(() => {
          hooks.push(`permission.${name}`);

          return registration;
        }),
    },
    rpc: {
      register: (def: RpcRegister[0], handlers: RpcRegister[1]) =>
        Effect.sync(() => {
          rpcs.push({
            handlers: Object.keys(handlers),
            id: def.id,
            methods: Object.keys(def.methods),
          });

          return { events: { emit: () => Effect.void } };
        }),
    },
    session: {
      hook: (name: string) =>
        Effect.sync(() => {
          hooks.push(`session.${name}`);

          return registration;
        }),
    },
    skill: {
      transform: (register: Parameters<HostContext["skill"]["transform"]>[0]) =>
        Effect.sync(() => {
          const added = new Map<string, Skill.Info>();

          register({
            add: (skill) => {
              added.set(skill.id, skill);
            },
            get: (id) => added.get(id),
            list: () => [...added.values()],
            remove: Function.constVoid,
            update: Function.constVoid,
          });

          for (const skill of added.values()) {
            const { content, ...fields } =
              Schema.decodeUnknownSync(SkillJson)(skill);

            skills.push({
              ...fields,
              content: digest(content),
              path: path.relative(packageRoot, fields.path),
            });
          }

          return registration;
        }),
    },
    storage: {
      get: () => Effect.undefined,
      remove: () => Effect.void,
      scan: () => Effect.succeed({ entries: [] }),
      set: () => Effect.void,
    },
    tool: {
      hook: (name: string) =>
        Effect.sync(() => {
          hooks.push(`tool.${name}`);

          return registration;
        }),
      transform: (
        register: (editor: { add: (tool: RegisteredTool) => void }) => void
      ) =>
        Effect.sync(() => {
          register({
            add: ({ description, input, name, options }) => {
              tools.push({
                description,
                input: decodeJson(Schema.toJsonSchemaDocument(input)),
                name,
                options: options ?? null,
              });
            },
          });

          return registration;
        }),
    },
  };

  const scope = Scope.makeUnsafe();
  // SAFETY: these are the only domains the plugin touches at load; the rest belong to tool and hook bodies.
  const host = Object.assign(Object.create(null) as HostContext, ctx);

  try {
    await Effect.runPromise(
      plugin.effect(host).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              DIRECTORATE_SETTINGS: path.join(state, "directorate.json"),
              DIRECTORATE_STATE_DIR: state,
            })
          )
        )
      )
    );

    // Event consumers subscribe from fibers the load forks into its scope: let them start before the scope closes.
    await tick();
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(state, { force: true, recursive: true });
  }

  return { agents, commands, hooks, rpcs, skills, subscriptions, tools };
};
