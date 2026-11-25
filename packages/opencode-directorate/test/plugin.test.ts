import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInThisContext } from "node:vm";

import { Agent, Skill } from "@opencode/plugin/effect";
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import { Session } from "@opencode/schema/session";
import {
  Cause,
  ConfigProvider,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { Types } from "effect";
import { Yaml, Zip } from "effect/encoding";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import { PAGE_SIZE as EXPORT_PAGE_SIZE } from "../src/export.ts";
import {
  DEFAULT_BUDGET,
  LENSES,
  PANEL_BUDGET_FACTOR,
  SealJson,
} from "../src/model.ts";
import type { SettingsView, WriteResult } from "../src/rpc.ts";
import { commandFixture } from "./fixtures.ts";

const present = <T>(value: T | null | undefined): T => {
  assert.ok(value !== undefined && value !== null, "expected a value");

  return value;
};

const runEach = <T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>
): Promise<void> =>
  Effect.runPromise(
    Effect.forEach(items, (item) => Effect.promise(() => fn(item)), {
      discard: true,
    })
  );

const state = mkdtempSync(path.join(tmpdir(), "directorate-state-"));

// A global file inside a project's .opencode (as with OPENCODE_CONFIG_DIR=~/.opencode): <state>/home has no project file.
const home = path.join(state, "home");
const globalSettings = path.join(home, ".opencode", "directorate.json");

const stateConfig = ConfigProvider.layer(
  ConfigProvider.fromEnvRecord({
    DIRECTORATE_SETTINGS: globalSettings,
    DIRECTORATE_STATE_DIR: state,
  })
);

const { default: plugin } = await import("../src/index.ts");

type HostContext = Parameters<typeof plugin.effect>[0];

type CommandEditor = Parameters<
  Parameters<HostContext["command"]["transform"]>[0]
>[0];

type CommandDefinition = Parameters<CommandEditor["add"]>[0];

type SubmittedPrompt = Parameters<HostContext["session"]["prompt"]>[0];

const { default: tuiPlugin } = await import("../src/tui.ts");
const { DirectorateRpc } = await import("../src/rpc.ts");

const dirs: string[] = [state];
const scopes: Scope.Closeable[] = [];

// Each test closes its plugins, so no earlier watchdog or event consumer runs into a later test's seals.
afterEach(() =>
  Effect.runPromise(
    Effect.forEach(scopes.splice(0), (scope) => Scope.close(scope, Exit.void), {
      discard: true,
    })
  )
);

// Global settings apply to every repository: no test leaves them for the next.
afterEach(() => rmSync(home, { force: true, recursive: true }));

after(() => {
  for (const d of dirs) {
    rmSync(d, { force: true, recursive: true });
  }
});

const repo = (): string => {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "directorate-repo-"))
  );

  dirs.push(dir);

  const g = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });

  g("init", "-q", "-b", "main");
  g("config", "core.autocrlf", "false");
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1\n");
  writeFileSync(path.join(dir, "src/b.ts"), "export const b = 1\n");
  g("add", ".");
  g("commit", "-qm", "init");
  writeFileSync(
    path.join(dir, "src/a.ts"),
    "export const a = 2\nexport const div = (x: number, y: number) => x / y\n"
  );
  writeFileSync(path.join(dir, "src/b.ts"), "export const b = 2\n");

  return dir;
};

interface BusEvent {
  created?: number;
  data: object;
  type: string;
}

/** Serves one event per pull, so the plugin asking for the next event means it finished the previous one. */
const eventBus = () => {
  const queue = Effect.runSync(
    Queue.unbounded<{
      event: BusEvent & { created: number };
      handled: Deferred.Deferred<true>;
    }>()
  );

  let current: Deferred.Deferred<true> | undefined;

  return {
    /** Resolves once the plugin has handled the event. */
    emit: (event: BusEvent) =>
      Effect.runPromise(
        Effect.gen(function* emit() {
          const handled = yield* Deferred.make<true>();
          yield* Queue.offer(queue, {
            event: { created: Date.now(), ...event },
            handled,
          });
          yield* Deferred.await(handled);
        })
      ),
    subscribe: () =>
      Stream.fromEffectRepeat(
        Effect.gen(function* subscribe() {
          if (current) {
            yield* Deferred.succeed(current, true);
          }

          const next = yield* Queue.take(queue);
          current = next.handled;

          return next.event;
        })
      ),
  };
};

let uid = 0;

/** A permission rule's denial, as the host reports it. */
class Denied extends Data.TaggedError("Denied")<{ message: string }> {}

/** Host state that outlives a plugin reload: instruction entries per session, and each child session's parent. */
const entries = new Map<string, Map<string, string>>();
const parents = new Map<string, string>();

/** Each session's agent, which the host records when the session is created. */
const sessionAgents = new Map<string, string>();

type JsonPrimitive = string | number | boolean | null | undefined;

interface ToolInput {
  [key: string]:
    | JsonPrimitive
    | ToolInput
    | readonly (JsonPrimitive | ToolInput)[];
}

interface ToolContext {
  agent: string;
  id: string;
  messageID: string;
  sessionID: string;
}

interface RegisteredTool {
  execute: (
    input: ToolInput,
    context: ToolContext
  ) => Effect.Effect<{ content: string }, Error>;
  input: Schema.Codec<ToolInput, ToolInput>;
  name: string;
}

interface SessionHookEvent {
  agent?: string;
  sessionID: string;
  system: { text: string }[];
  tools: Record<string, Record<string, never>>;
}

interface PermissionHookEvent {
  action: string;
  agent?: string | undefined;
  effect?: string;
  message?: string;
  resources: string[] | null;
  sessionID: string;
}

interface ToolBeforeEvent {
  agent: string;
  id: string;
  input: {
    agent?: string;
    description?: string | undefined;
    model?: string;
    prompt?: string;
    sessionID?: string;
  } | null;
  messageID?: string;
  sessionID: string;
  tool: string;
}

interface ToolAfterEvent {
  error?: { message: string };
  id: string;
  /** Absent when the tool failed (status "error"). */
  result?: {
    content?: string;
    metadata:
      | { metadata: { sessionID: string; status: string } }
      | { sessionID: string; status: string };
  };
  sessionID: string;
  status: string;
  tool: string;
}

interface Hooks {
  "permission.evaluate"?: (event: PermissionHookEvent) => Promise<void>;
  "session.compaction"?: (event: SessionHookEvent) => Promise<void>;
  "session.context"?: (event: SessionHookEvent) => Promise<void>;
  "session.generate"?: (event: SessionHookEvent) => Promise<void>;
  "tool.execute.after"?: (event: ToolAfterEvent) => Promise<void>;
  "tool.execute.before"?: (event: ToolBeforeEvent) => Promise<void>;
}

type RpcMethodInput =
  | { previous?: ToolInput; scope: string; settings: ToolInput }
  | undefined;

type RpcMethodOutput = SettingsView | WriteResult;

interface RpcError {
  message: string;
  type: string;
}

interface RpcHandlerContext {
  error: (type: string, message: string) => RpcError;
}

type RpcHandler = (
  input: RpcMethodInput,
  context: RpcHandlerContext
) => Effect.Effect<RpcMethodOutput, RpcError>;

type RpcHandlerMap = Record<string, RpcHandler>;

interface TestRpcClient {
  rpc: (
    def: typeof DirectorateRpc
  ) => Record<string, (input: RpcMethodInput) => Promise<RpcMethodOutput>>;
}

const sealOf = (out: string): string => {
  const seal =
    /(?:Containment sealed|Resumed containment) `(?<seal>directorate-[^`]+)`/u.exec(
      out
    )?.groups?.seal;

  assert.ok(seal, out);

  return seal;
};

const permissionEvent = (
  agent: string | undefined,
  action: string,
  resource: string
): PermissionHookEvent => ({
  action,
  agent,
  effect: "allow",
  resources: [resource],
  sessionID: "ses_primary",
});

/** One plugin instance. Session ids are unique per harness (real ones are), unless `ids` shares them across a reload. */
const harness = async (
  dir: string,
  ids?: string,
  run = Effect.runPromise,
  deny: (request: { action: string; resources: string[] }) => boolean = () =>
    false,
  existing?: { agent: Types.DeepMutable<Agent.Info>; skill: Skill.Info },
  commandsLayer:
    | Layer.Layer<ChildProcessSpawner>
    | Layer.Layer<never> = Layer.empty
) => {
  const tag = ids ?? `h${(uid += 1)}`;
  const S = (name: string) => `ses_${name}-${tag}`;
  const tools = new Map<string, RegisteredTool>();
  const hooks: Hooks = {};
  const asserted: string[] = [];
  const requests: { action: string; resources: string[] }[] = [];
  const interrupted: string[] = [];
  const notices: string[] = [];
  const notified = Deferred.makeUnsafe<string>();
  const rpcs = new Map<string, RpcHandlerMap>();
  const commands = new Map<string, CommandDefinition>();
  const agents = new Map<string, Types.DeepMutable<Agent.Info>>();
  const skills = new Map<string, Skill.Info>();

  if (existing) {
    agents.set(existing.agent.id, structuredClone(existing.agent));
    skills.set(existing.skill.id, structuredClone(existing.skill));
  }

  const prompts: SubmittedPrompt[] = [];
  const bus = eventBus();

  const ctx = {
    agent: {
      transform: (register: Parameters<HostContext["agent"]["transform"]>[0]) =>
        Effect.sync(() =>
          register({
            default: () => {},
            get: (id) => agents.get(id),
            list: () => [...agents.values()],
            remove: () => {},
            update: (id, update) => {
              const agent =
                agents.get(id) ?? Agent.Info.default(Agent.ID.make(id));

              update(agent);
              agents.set(id, agent);
            },
          })
        ),
    },
    app: { version: "2.2.3" },
    command: {
      transform: (register: (editor: CommandEditor) => void) =>
        Effect.sync(() => {
          register({
            add: (definition) => {
              commands.set(definition.name, definition);
            },
          });
        }),
    },
    event: { subscribe: bus.subscribe },
    location: { directory: dir },
    model: {
      list: () =>
        Effect.succeed({
          data: [
            {
              enabled: true,
              id: "alpha",
              name: "Alpha",
              providerID: "prov",
              variants: [{ id: "high" }, { id: "xhigh" }],
            },
            {
              enabled: true,
              id: "beta",
              name: "Beta",
              providerID: "prov",
              variants: [],
            },
            {
              enabled: false,
              id: "off",
              name: "Off",
              providerID: "prov",
              variants: [],
            },
          ],
        }),
    },
    permission: {
      assert: (request: {
        action: string;
        agent: string;
        resources: string[];
      }) => {
        asserted.push(`${request.agent}:${request.action}`);
        requests.push({
          action: request.action,
          resources: request.resources,
        });

        return deny(request)
          ? Effect.fail(
              new Denied({
                message: `${request.action} denied by a permission rule`,
              })
            )
          : Effect.void;
      },
      hook: (
        name: "evaluate",
        handler: (event: PermissionHookEvent) => Effect.Effect<void>
      ) =>
        Effect.sync(() => {
          hooks[`permission.${name}`] = (event: PermissionHookEvent) =>
            run(handler(event));
        }),
    },
    rpc: {
      register: (def: { id: string }, handlers: RpcHandlerMap) =>
        Effect.sync(() => {
          rpcs.set(def.id, handlers);

          return { events: { emit: () => Effect.void } };
        }),
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          agent: sessionAgents.get(sessionID),
          location: { directory: dir },
          parentID: parents.get(sessionID),
        }),
      hook: (
        name: "compaction" | "context" | "generate",
        handler: (event: SessionHookEvent) => Effect.Effect<void>
      ) =>
        Effect.sync(() => {
          hooks[`session.${name}`] = (event: SessionHookEvent) =>
            run(handler(event));
        }),
      instructions: {
        entry: {
          list: ({ sessionID }: { sessionID: string }) =>
            Effect.sync(() =>
              [...(entries.get(sessionID) ?? [])].map(([key, value]) => ({
                key,
                value,
              }))
            ),
          put: ({
            sessionID,
            key,
            value,
          }: {
            key: string;
            sessionID: string;
            value: string;
          }) =>
            Effect.sync(() => {
              const map = entries.get(sessionID) ?? new Map<string, string>();
              entries.set(sessionID, map);
              map.set(key, value);
            }),
          remove: ({ sessionID, key }: { key: string; sessionID: string }) =>
            Effect.sync(() => {
              entries.get(sessionID)?.delete(key);
            }),
        },
      },
      interrupt: ({ sessionID }: { sessionID: string }) =>
        Effect.sync(() => {
          interrupted.push(sessionID);
        }),
      prompt: (input: SubmittedPrompt) =>
        Effect.sync(() => {
          prompts.push(input);
        }),
      synthetic: ({ text }: { text: string }) =>
        Effect.sync(() => {
          notices.push(text);
        }).pipe(
          Effect.andThen(Deferred.succeed(notified, text)),
          Effect.asVoid
        ),
    },
    skill: {
      transform: (register: Parameters<HostContext["skill"]["transform"]>[0]) =>
        Effect.sync(() =>
          register({
            add: (skill) => {
              skills.set(skill.id, skill);
            },
            get: (id) => skills.get(id),
            list: () => [...skills.values()],
            remove: () => {},
            update: () => {},
          })
        ),
    },
    tool: {
      hook: (
        name: "execute.after" | "execute.before",
        handler: (
          event: ToolBeforeEvent | ToolAfterEvent
        ) => Effect.Effect<void>
      ) =>
        Effect.sync(() => {
          if (name === "execute.before") {
            hooks["tool.execute.before"] = (event: ToolBeforeEvent) =>
              run(handler(event));
          } else {
            hooks["tool.execute.after"] = (event: ToolAfterEvent) =>
              run(handler(event));
          }
        }),
      transform: (
        register: (editor: { add: (tool: RegisteredTool) => void }) => void
      ) =>
        Effect.sync(() =>
          register({
            add: (tool) => {
              tools.set(tool.name, tool);
            },
          })
        ),
    },
  };

  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  // SAFETY: test harness provides every HostContext domain that the plugin touches.
  const hostContext = Object.assign(Object.create(null) as HostContext, ctx);
  await run(
    plugin
      .effect(hostContext)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(Layer.merge(stateConfig, commandsLayer))
      )
  );

  const call = (
    name: string,
    input: ToolInput,
    agent = "directorate_liaison",
    session = "lead"
  ) => {
    const tool = present(tools.get(name));

    return run(
      Schema.decodeEffect(tool.input)(input).pipe(
        Effect.flatMap((decoded) =>
          tool.execute(decoded, {
            agent,
            id: "c",
            messageID: "m",
            sessionID: S(session),
          })
        )
      )
    );
  };

  /** As the subagent tool does: the before-hook, then the child session's creation (titled by the description); returns the after-hook. */
  const launch = async (
    callId: string,
    agent: string,
    prompt: string,
    child: string,
    st: "running" | "completed" | "failed",
    description?: string
  ) => {
    const event: ToolBeforeEvent = {
      agent: "directorate_liaison",
      id: callId,
      input: { agent, description, prompt },
      sessionID: S("lead"),
      tool: "subagent",
    };

    await present(hooks["tool.execute.before"])(event);
    parents.set(S(child), S("lead"));
    sessionAgents.set(S(child), agent);
    await bus.emit({
      data: {
        agent,
        parentID: S("lead"),
        sessionID: S(child),
        title: event.input?.description,
      },
      type: "session.created",
    });

    return () =>
      present(hooks["tool.execute.after"])({
        id: callId,
        result: {
          content: `<subagent sessionID="${S(child)}" state="${st}">`,
          metadata: { metadata: { sessionID: S(child), status: st } },
        },
        sessionID: S("lead"),
        status: "completed",
        tool: "subagent",
      });
  };

  const followUp = async (
    id: string,
    agent: string,
    child: string,
    prompt: string
  ) => {
    const sessionID = S(child);

    const event: ToolBeforeEvent = {
      agent: "directorate_liaison",
      id,
      input: { agent, description: "again", prompt, sessionID },
      sessionID: S("lead"),
      tool: "subagent",
    };

    await present(hooks["tool.execute.before"])(event);
    const data = { inboxID: `inbox-${id}`, sessionID };

    return {
      deliver: () => bus.emit({ data, type: "session.inbox.delivered" }),
      enqueue: () =>
        bus.emit({
          data: {
            ...data,
            item: { payload: { text: event.input?.prompt }, type: "user" },
          },
          type: "session.inbox.enqueued",
        }),
      returned: () =>
        present(hooks["tool.execute.after"])({
          id,
          result: { metadata: { sessionID, status: "running" } },
          sessionID: S("lead"),
          status: "completed",
          tool: "subagent",
        }),
    };
  };

  /** As the TUI's promise client: input decoded by the method's schema, JSON back, a failure thrown as { type, message }. */
  const client: TestRpcClient = {
    rpc: (def) =>
      Object.fromEntries(
        Object.entries(def.methods).map(([name, method]) => [
          name,
          async (input: RpcMethodInput) => {
            const validated = await method.input["~standard"].validate(input);

            if (validated.issues) {
              throw new Error(
                validated.issues.map((issue) => issue.message).join("; ")
              );
            }

            const handlers = present(rpcs.get(def.id));
            const handler = present(handlers[name]);

            const exit = await Effect.runPromiseExit(
              handler(validated.value, {
                error: (type, message) => ({
                  message,
                  type,
                }),
              })
            );

            if (Exit.isFailure(exit)) {
              throw Cause.squash(exit.cause);
            }

            return structuredClone(exit.value);
          },
        ])
      ),
  };

  return {
    S,
    agents,
    asserted,
    bus,
    call,
    client,
    commands,
    followUp,
    hooks,
    interrupted,
    launch,
    notices,
    notified,
    prompts,
    requests,
    rpcs,
    scope,
    sealOf,
    skills,
    tools,
  };
};

const decodeSeal = Schema.decodeUnknownSync(SealJson);

const sealJson = (id: string) =>
  decodeSeal(readFileSync(path.join(state, id, "seal.json"), "utf-8"));

const shiftClock = (id: string, minutesAgo: number, minutes = 10) => {
  const file = path.join(state, id, "seal.json");
  const s = JSON.parse(readFileSync(file, "utf-8"));
  const start = Date.now() - minutesAgo * 60_000;
  writeFileSync(
    file,
    JSON.stringify({
      ...s,
      budgetMinutes: minutes,
      createdAt: new Date(start).toISOString(),
      deadline: new Date(start + minutes * 60_000).toISOString(),
    })
  );
};

interface AddFindingOverrides {
  brief?: string;
  consequence?: string;
  evidence?: string[];
  kind?: string;
  lens?: string;
  line?: number;
  path?: string;
  quote?: string;
  severity?: string;
  title?: string;
  trigger?: string;
}

const add = (seal: string, o: AddFindingOverrides = {}) => ({
  consequence: "Infinity",
  evidence: ["src/a.ts:2"],
  kind: "defect",
  lens: "correctness",
  line: 2,
  path: "src/a.ts",
  quote: "export const div = (x: number, y: number) => x / y",
  seal,
  severity: "important",
  title: "Division by zero",
  trigger: "y=0",
  ...o,
});

test("registers review, export, and settings tools, four hooks, and the settings RPC; tools assert permission; auto target", async () => {
  const { tools, hooks, call, asserted, rpcs } = await harness(repo());
  assert.deepEqual([...rpcs.keys()], ["directorate"]);
  assert.deepEqual([...tools.keys()].toSorted(), [
    "directorate_configure",
    "directorate_coverage",
    "directorate_diff",
    "directorate_export",
    "directorate_export_list",
    "directorate_grep",
    "directorate_history",
    "directorate_ledger_add",
    "directorate_ledger_list",
    "directorate_ledger_verdict",
    "directorate_ls",
    "directorate_note",
    "directorate_read",
    "directorate_refresh",
    "directorate_report",
    "directorate_seal",
    "directorate_wait",
  ]);
  assert.ok(
    hooks["session.context"] &&
      hooks["permission.evaluate"] &&
      hooks["tool.execute.before"] &&
      hooks["tool.execute.after"]
  );

  for (const [name, tool] of tools) {
    assert.doesNotMatch(
      JSON.stringify(Schema.toJsonSchemaDocument(tool.input)),
      /"null"/u,
      `${name}: optional inputs are absent keys, not anyOf-null`
    );
  }

  const contentResult = await call("directorate_seal", {
    mode: "default",
    target: { kind: "auto" },
  });

  const out = contentResult.content;

  assert.match(out, /local changes .* 2 files · 2 regions/su);
  assert.doesNotMatch(out, /\n{3,}/u);
  assert.ok(sealOf(out));
  assert.deepEqual(asserted, ["directorate_liaison:directorate_seal"]);
});

test("review scope falls back from explicit input to project, global, and branch defaults", async () => {
  const dir = repo();
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("switch", "-qc", "feature");
  git("add", "src/a.ts");
  git("commit", "-qm", "branch change");
  const { call } = await harness(dir);

  const seal = async (session: string, input = {}) => {
    const result = await call(
      "directorate_seal",
      { mode: "full", ...input },
      "directorate_liaison",
      session
    );

    return sealJson(sealOf(result.content));
  };

  const branch = await seal("branch");
  assert.match(
    branch.description,
    /branch 1 commit ahead of main plus local changes/u
  );
  assert.deepEqual(
    branch.files.map((file: { path: string }) => file.path),
    ["src/a.ts", "src/b.ts"]
  );

  mkdirSync(path.join(home, ".opencode"), { recursive: true });
  writeFileSync(globalSettings, JSON.stringify({ default_scope: "local" }));
  const local = await seal("global");
  assert.deepEqual(
    local.files.map((file: { path: string }) => file.path),
    ["src/b.ts"]
  );

  await call(
    "directorate_configure",
    {
      action: "write",
      scope: "project",
      settings: { default_scope: "repository" },
    },
    "build"
  );
  const targetResult = await seal("project");
  assert.equal(targetResult.target.kind, "paths");
  const baseShaResult = await seal("explicit", { scope: "local" });
  assert.equal(baseShaResult.baseSha, local.baseSha);
  const targetResult2 = await seal("target", { target: { kind: "commit" } });
  assert.equal(targetResult2.target.kind, "commit");
  await assert.rejects(
    seal("ambiguous", { scope: "branch", target: { kind: "local" } }),
    /Pass either scope or target/u
  );
});

test("the plugin registers bundled review agents and skill without discovery files", async () => {
  const { agents, skills } = await harness(repo());
  assert.deepEqual(
    [...agents.values()].map(({ id, mode, hidden }) => [id, mode, hidden]),
    [
      ["directorate_liaison", "all", false],
      ["directorate_auditor", "subagent", true],
      ["directorate_seat", "subagent", true],
      ["directorate_compliance", "subagent", true],
    ]
  );

  for (const agent of agents.values()) {
    assert.ok(agent.system?.startsWith("# "));
  }

  const skill = skills.get("directorate-lenses");
  assert.ok(skill);
  assert.equal(skill.autoinvoke, false);
  assert.match(skill.content, /^# Directorate lenses/u);
  assert.ok(
    statSync(path.join(skill.path, "../references/triage.md")).isFile()
  );

  // Verify bundled skill conforms to agentskills.io constraints and stays in sync with LENSES.
  const rawSkill = readFileSync(skill.path, "utf-8");
  const lines = rawSkill.split(/\r?\n/u);
  assert.ok(lines.length < 500, `SKILL.md is ${lines.length} lines (<500)`);
  const fmMatch = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n/u.exec(rawSkill);
  assert.ok(fmMatch?.groups?.yaml, "SKILL.md has YAML frontmatter");

  const PortableFrontmatter = Schema.Struct({
    "allowed-tools": Schema.optionalKey(Schema.String),
    compatibility: Schema.optionalKey(Schema.String),
    description: Schema.String,
    license: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Boolean])
      )
    ),
    name: Schema.String,
  });

  const fm = Schema.decodeUnknownSync(PortableFrontmatter)(
    Yaml.parse(fmMatch.groups.yaml),
    { onExcessProperty: "error" }
  );

  assert.equal(fm.name, path.basename(path.dirname(skill.path)));
  assert.ok(fm.description.length >= 1 && fm.description.length <= 1024);
  assert.doesNotMatch(fm.description, /[<>]/u);

  const refDir = path.join(path.dirname(skill.path), "references");

  const refFiles = readdirSync(refDir)
    .filter((f) => f.endsWith(".md"))
    .toSorted();

  const expectedRefs = [...LENSES, "triage"].map((n) => `${n}.md`).toSorted();
  assert.deepEqual(refFiles, expectedRefs, "references match LENSES + triage");

  for (const file of refFiles) {
    assert.ok(
      skill.content.includes(`references/${file}`),
      `SKILL.md links references/${file}`
    );
  }
});

test("bundled registration preserves existing agent and skill overrides", async () => {
  const dir = repo();

  const agent: Types.DeepMutable<Agent.Info> = {
    ...Agent.Info.default(Agent.ID.make("directorate_liaison")),
    system: "Custom review instructions",
  };

  const skill = Skill.Info.make({
    autoinvoke: true,
    content: "Custom lens instructions",
    id: Skill.ID.make("directorate-lenses"),
    name: Skill.Name.make("Custom lenses"),
    path: Skill.Info.fields.path.make(path.join(dir, "SKILL.md")),
  });

  const { agents, skills } = await harness(
    dir,
    undefined,
    undefined,
    undefined,
    {
      agent,
      skill,
    }
  );

  assert.deepEqual(agents.get(agent.id), agent);
  assert.deepEqual(skills.get(skill.id), skill);
  assert.deepEqual([...agents.keys()].toSorted(), [
    "directorate_auditor",
    "directorate_compliance",
    "directorate_liaison",
    "directorate_seat",
  ]);
});

const openCodeFixture = commandFixture(
  "opencode",
  `
const [command, action, value] = process.argv.slice(1);
if (/^ses_missing-/u.test(value) || value.includes("/ses_missing-")) {
  process.exit(1);
}
if (command === "session" && action === "export" && value.startsWith("ses")) {
  process.stdout.write(JSON.stringify({
    info: { id: value },
    messages: [{ text: "private transcript" }],
  }) + "\\n");
} else if (command === "api" && action === "get" &&
  /^\\/api\\/experimental\\/session\\/ses[\\w-]+\\/log\\?follow=false$/u.test(value)) {
  process.stdout.write('data: {"type":"session.created"}\\n\\n');
} else {
  process.exit(2);
}
`
);

const exportHarness = (dir: string) =>
  harness(dir, undefined, undefined, undefined, undefined, openCodeFixture);

const readArchive = (archive: string) =>
  Effect.runPromise(
    Stream.make(readFileSync(archive)).pipe(
      Stream.pipeThroughChannel(Zip.decode()),
      Stream.filter((entry) => entry.header.type === "File"),
      Stream.mapEffect((entry) =>
        Stream.mkString(Stream.decodeText(entry.body)).pipe(
          Effect.map((content) => [entry.header.path, content] as const)
        )
      ),
      Stream.runCollect,
      Effect.map((files) => new Map(files))
    )
  );

test("directorate_export archives every generation and available session trace for one seal", async () => {
  const dir = repo();
  const { call, prompts, requests, S } = await exportHarness(dir);

  const { content } = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const id = sealOf(content);
  const reviewDir = path.join(state, id);
  const oldOwner = S("lead");
  await call(
    "directorate_seal",
    { resume: id },
    "directorate_liaison",
    "new-lead"
  );
  assert.deepEqual(sealJson(id).previousOwnerSessions, [oldOwner]);

  writeFileSync(path.join(dir, "src/a.ts"), "export const a = 3\n");
  await call(
    "directorate_refresh",
    { seal: id },
    "directorate_liaison",
    "new-lead"
  );
  const child = S("seat");
  const absent = S("missing");
  const s = sealJson(id);

  const run = {
    agent: "directorate_seat",
    call: "call-1",
    prompt: "private prompt",
    startedAt: s.createdAt,
    status: "completed",
  } as const;

  writeFileSync(
    path.join(reviewDir, "seal.json"),
    Schema.encodeSync(SealJson)({
      ...s,
      children: [
        { ...run, session: child },
        { ...run, call: "call-2", session: child },
        { ...run, call: "call-3", session: absent },
      ],
      reportedAt: s.createdAt,
    })
  );
  writeFileSync(path.join(reviewDir, "report.md"), "# Saved Directive\n");
  writeFileSync(
    path.join(reviewDir, ".directorate-write-orphan"),
    "not a review artifact"
  );

  const invoke = (seal: string) =>
    call("directorate_export", { seal }, "build", "requester");

  await assert.rejects(invoke("directorate-../outside"), /Unknown seal id/u);
  const exported = await invoke(id);
  assert.deepEqual(requests.at(-1), {
    action: "directorate_export",
    resources: [id],
  });

  const output = path.join(state, "exports");
  const archives = readdirSync(output);
  assert.equal(archives.length, 1, "staging directory is cleaned up");
  const archive = path.join(output, present(archives[0]));

  const files = await readArchive(archive);
  const unzip = (name: string) => present(files.get(name));

  if (process.platform !== "win32") {
    assert.equal(statSync(archive).mode % 0o1000, 0o600);
  }

  const manifest = JSON.parse(unzip("manifest.json"));
  assert.equal(manifest.seal, id);
  assert.deepEqual(manifest.missingArtifacts, []);
  assert.deepEqual(
    manifest.sessions.map((session: { id: string }) => session.id),
    [S("new-lead"), oldOwner, child, absent]
  );
  assert.match(
    manifest.sessions.at(-1).error,
    /Could not export transcript or event log/u
  );
  assert.deepEqual(manifest.artifacts, [
    "seal/diff.g1.patch",
    "seal/diff.patch",
    "seal/ledger.json",
    "seal/report.md",
    "seal/seal.json",
    "seal/snapshot",
    "seal/snapshot.g1",
  ]);
  assert.equal(unzip("seal/report.md"), "# Saved Directive\n");
  assert.match(unzip("seal/snapshot/src/a.ts"), /a = 2/u);
  assert.match(unzip("seal/snapshot.g1/src/a.ts"), /a = 3/u);
  assert.match(unzip(`sessions/${child}.json`), /private transcript/u);
  assert.match(unzip(`sessions/${child}.sse`), /session\.created/u);
  assert.match(exported.content, /unredacted.*Nothing was uploaded/u);
  assert.equal(prompts.length, 0);
});

test("/directorate-export forwards the request and the agent can list review dates across linked worktrees", async () => {
  const dir = repo();
  const linked = path.join(dir, "linked workspace");
  execFileSync("git", ["-C", dir, "worktree", "add", "-q", "--detach", linked]);

  const { call, commands, prompts, S } = await harness(dir);

  const { content } = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const first = sealOf(content);
  const template = sealJson(first);

  const seed = (suffix: string, location: string, daysAgo: number) => {
    const id = `directorate-20261025000000-${suffix}`;
    const directory = path.join(state, id);

    const createdAt = DateTime.subtract(DateTime.nowUnsafe(), {
      days: daysAgo,
    });

    mkdirSync(directory);
    writeFileSync(
      path.join(directory, "seal.json"),
      Schema.encodeSync(SealJson)({
        ...template,
        createdAt,
        id,
        ownerSession: "",
        repo: execFileSync(
          "git",
          ["-C", location, "rev-parse", "--show-toplevel"],
          { encoding: "utf-8" }
        ).trim(),
      })
    );
    writeFileSync(path.join(directory, "diff.patch"), `patch for ${id}`);

    return id;
  };

  const recent = seed("000001", dir, 24);
  const worktree = seed("000002", linked, 5);
  const old = seed("000003", dir, 40);
  const unrelated = seed("000004", repo(), 5);
  writeFileSync(
    path.join(state, first, "seal.json"),
    Schema.encodeSync(SealJson)({ ...template, ownerSession: "" })
  );

  const exportCommand = present(commands.get("directorate-export"));

  const invoke = (text: string) =>
    Effect.runPromise(
      exportCommand.execute({
        delivery: "queue",
        prompt: { text },
        sessionID: Session.ID.make(S("requester")),
      })
    );

  const request = "everything in this project in the last month";
  await invoke(request);
  assert.equal(prompts.length, 1);
  const submitted = present(prompts[0]);
  assert.ok(
    submitted.text.endsWith(`<user_request>\n${request}\n</user_request>`)
  );
  assert.match(submitted.text, /more than 3 reviews.*confirm/u);
  assert.match(submitted.text, /directorate_export once per matching seal ID/u);
  assert.match(submitted.text, /Do not open, attach, or upload/u);

  const list = async (before?: string) => {
    const result = await call(
      "directorate_export_list",
      before ? { before } : {},
      "build",
      "requester"
    );

    return JSON.parse(result.content);
  };

  const page = await list();
  const ids = page.reviews.map((review: { seal: string }) => review.seal);
  assert.deepEqual(new Set(ids), new Set([first, recent, worktree, old]));
  assert.ok(!ids.includes(unrelated));
  assert.ok(
    page.reviews.every((review: { createdAt: string }) =>
      Number.isFinite(Date.parse(review.createdAt))
    )
  );
  const earlier = await list(worktree);

  assert.deepEqual(
    earlier.reviews.map((review: { seal: string }) => review.seal),
    [recent]
  );
});

test("directorate_export lists the owner's reads under its session, not as a missing session", async () => {
  const dir = repo();
  const { call, S } = await exportHarness(dir);

  const { content } = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const id = sealOf(content);
  await call("directorate_diff", { seal: id });
  assert.ok(sealJson(id).regions.some((r) => r.readBy.includes("owner")));

  const exported = await call(
    "directorate_export",
    { seal: id },
    "build",
    "requester"
  );

  const output = path.join(state, "exports");

  const archive = path.join(
    output,
    present(readdirSync(output).find((name) => name.startsWith(`${id}-`)))
  );

  const files = await readArchive(archive);
  const manifest = JSON.parse(present(files.get("manifest.json")));

  assert.deepEqual(manifest.sessions, [
    {
      id: S("lead"),
      log: `sessions/${S("lead")}.sse`,
      transcript: `sessions/${S("lead")}.json`,
    },
  ]);
  assert.doesNotMatch(exported.content, /unavailable/u);
});

test("directorate_export_list pages by nextBefore through every review once, newest first", async () => {
  const dir = repo();
  const { call } = await harness(dir);

  const { content } = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const first = sealOf(content);
  const template = sealJson(first);

  const seeded = Array.from({ length: EXPORT_PAGE_SIZE + 2 }, (_, n) => {
    const id = `directorate-20261026000000-e${n.toString(16).padStart(5, "0")}`;
    mkdirSync(path.join(state, id));
    writeFileSync(
      path.join(state, id, "seal.json"),
      Schema.encodeSync(SealJson)({ ...template, id, ownerSession: "" })
    );

    return id;
  });

  // Each page needs the previous page's cursor, so walk them one at a time.
  const walk = async (before?: string): Promise<string[][]> => {
    const result = await call(
      "directorate_export_list",
      before ? { before } : {},
      "build",
      "requester"
    );

    const page = JSON.parse(result.content);
    const ids = page.reviews.map((review: { seal: string }) => review.seal);

    return page.nextBefore === undefined
      ? [ids]
      : [ids, ...(await walk(page.nextBefore))];
  };

  const pages = await walk();

  assert.equal(pages.length, 2);
  assert.deepEqual(pages.flat(), [first, ...seeded].toSorted().toReversed());
});

test("/directorate-review forwards free-form requests and only offers setup questions for a bare command", async () => {
  const { commands, prompts, S } = await harness(repo());
  const review = commands.get("directorate-review");
  assert.ok(review);

  const sessionID = Session.ID.make(S("lead"));

  const text =
    "Review PR #123 with one model.\nFocus on migrations; skip generated files.\n\n ";

  const files = [{ uri: "file:///tmp/context.md" }];
  await Effect.runPromise(
    review.execute({
      delivery: "queue",
      prompt: { files, text },
      sessionID,
    })
  );

  assert.equal(prompts.length, 1);
  const [submitted] = prompts;
  assert.ok(submitted);
  assert.equal(submitted.sessionID, sessionID);
  assert.equal(submitted.delivery, "queue");
  assert.deepEqual(submitted.files, files);
  assert.ok(
    submitted.text.startsWith(
      `<user_request>\n${text}\n</user_request>\n\nStart a Directorate code review using the <user_request> above.`
    )
  );
  assert.match(
    submitted.text,
    /Use configured defaults for details the user didn't specify\. Ask only if a missing or conflicting detail/u
  );
  assert.doesNotMatch(
    submitted.text,
    /use the question tool to offer the mode/u
  );
  assert.match(
    submitted.text,
    /Dispatch directorate_liaison with the user's request/u
  );

  await runEach(["", " \n\t"], async (blank) => {
    await Effect.runPromise(
      review.execute({ delivery: "queue", prompt: { text: blank }, sessionID })
    );
    assert.match(
      prompts.at(-1)?.text ?? "",
      /^Start a Directorate code review\./u
    );
    assert.match(prompts.at(-1)?.text ?? "", /omit both target and scope/u);
    assert.match(
      prompts.at(-1)?.text ?? "",
      /use the question tool to offer the mode/u
    );
  });

  await Effect.runPromise(
    review.execute({
      delivery: "queue",
      prompt: { text: "--scope local focus on tests" },
      sessionID,
    })
  );
  const scopedWithFocus = prompts.at(-1)?.text ?? "";
  assert.ok(
    scopedWithFocus.startsWith(
      "<user_request>\nfocus on tests\n</user_request>\n\nStart a Directorate code review using the <user_request> above."
    )
  );
  assert.match(scopedWithFocus, /pass scope: "local"/u);

  await Effect.runPromise(
    review.execute({
      delivery: "queue",
      prompt: { text: "--scope local" },
      sessionID,
    })
  );
  const scopedBare = prompts.at(-1)?.text ?? "";
  assert.match(scopedBare, /^Start a Directorate code review\./u);
  assert.doesNotMatch(scopedBare, /<user_request>/u);
  assert.doesNotMatch(scopedBare, /use the question tool to offer the mode/u);
  assert.match(scopedBare, /pass scope: "local"/u);

  const count = prompts.length;
  await assert.rejects(
    Effect.runPromise(
      review.execute({
        delivery: "queue",
        prompt: { text: "--scope nonsense" },
        sessionID,
      })
    ),
    /Use --scope branch/u
  );
  assert.equal(prompts.length, count);

  await Effect.runPromise(
    review.execute({
      delivery: "queue",
      prompt: {
        text: "--recheck directorate-20260101000000-abcdef focus on the lock",
      },
      sessionID,
    })
  );
  const recheck = prompts.at(-1)?.text ?? "";
  assert.ok(
    recheck.startsWith(
      "<user_request>\nfocus on the lock\n</user_request>\n\nRe-check `directorate-20260101000000-abcdef` after fixes"
    )
  );
  assert.match(recheck, /send that session a follow-up/u);
  assert.match(recheck, /pass recheck: "directorate-20260101000000-abcdef"/u);
  await Effect.runPromise(
    review.execute({
      delivery: "queue",
      prompt: { text: "--recheck" },
      sessionID,
    })
  );
  assert.match(
    prompts.at(-1)?.text ?? "",
    /^Re-check the latest Directive after fixes\./u
  );
  assert.match(
    prompts.at(-1)?.text ?? "",
    /latest reported seal with directorate_ledger_list/u
  );
  await assert.rejects(
    Effect.runPromise(
      review.execute({
        delivery: "queue",
        prompt: { text: "--recheck=oops" },
        sessionID,
      })
    ),
    /Use --recheck alone/u
  );
});

test("a whole-file directory target includes unchanged files but excludes files outside it", async () => {
  const dir = repo();
  mkdirSync(path.join(dir, "packages/nested"), { recursive: true });
  writeFileSync(
    path.join(dir, "packages/nested/keep.ts"),
    "export const keep = 1\n"
  );
  execFileSync("git", ["-C", dir, "add", "packages"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "add package"]);
  writeFileSync(
    path.join(dir, "packages/draft.ts"),
    "export const draft = 1\n"
  );

  const { call } = await harness(dir);
  const target = { kind: "paths", paths: ["packages/"] };
  const { content } = await call("directorate_seal", { target });
  const seal = sealJson(sealOf(content));
  assert.deepEqual(
    seal.files.map((file: { path: string; status: string }) => [
      file.path,
      file.status,
    ]),
    [
      ["packages/draft.ts", "modified"],
      ["packages/nested/keep.ts", "unchanged"],
    ]
  );
  const diff = await call("directorate_diff", { seal: seal.id });
  assert.match(diff.content, /export const keep = 1/u);
});

test("registered agents receive their role-specific tool permissions", async () => {
  const { agents } = await harness(repo());

  const allowed = (agent: string) => {
    const rules = agents.get(agent)?.permissions;
    assert.ok(rules, `${agent} is registered`);
    assert.deepEqual(
      rules[0],
      { action: "*", effect: "deny", resource: "*" },
      `${agent} denies everything first`
    );
    assert.ok(
      rules.some(
        ({ action, effect, resource }) =>
          action === "skill" &&
          effect === "allow" &&
          resource === "directorate-lenses"
      ),
      `${agent} can load the lens skill`
    );

    // Direct file access reaches only the lens references; code is read through the sealed directorate_* tools.
    for (const { action, resource, effect } of rules) {
      if (
        effect === "allow" &&
        (action === "read" || action === "external_directory")
      ) {
        assert.ok(
          (action === "read" &&
            resource === "*/skills/directorate-lenses/references/*.md") ||
            (action === "external_directory" &&
              resource === "*/skills/directorate-lenses/*"),
          `${agent}: ${action} is limited to the lens skill`
        );
      }
    }

    for (const action of ["webfetch", "websearch"]) {
      assert.deepEqual(
        rules.findLast((rule) => rule.action === action),
        { action, effect: "allow", resource: "*" },
        `${agent}: ${action} is available without per-action approval`
      );
    }

    assert.ok(rules.every((rule) => rule.effect !== "ask"));

    return rules
      .filter(
        ({ action, effect }) =>
          action.startsWith("directorate_") && effect === "allow"
      )
      .map(({ action }) => action)
      .toSorted();
  };

  const read = [
    "directorate_diff",
    "directorate_grep",
    "directorate_history",
    "directorate_ledger_list",
    "directorate_ls",
    "directorate_read",
  ];

  assert.deepEqual(
    allowed("directorate_auditor"),
    [
      ...read.filter((t) => t !== "directorate_ledger_list"),
      "directorate_ledger_add",
      "directorate_note",
    ].toSorted()
  );
  assert.deepEqual(
    allowed("directorate_compliance"),
    [...read, "directorate_ledger_verdict"].toSorted()
  );
  // Seats review independently: they file, but never list the other seats' entries.
  assert.deepEqual(
    allowed("directorate_seat"),
    [
      ...read.filter((t) => t !== "directorate_ledger_list"),
      "directorate_ledger_add",
      "directorate_note",
    ].toSorted()
  );
  assert.deepEqual(allowed("directorate_liaison"), ["directorate_*"]);
});

test("ownership: only the sealing session may cover, refresh, or report", async () => {
  const { call } = await harness(repo());

  const contentResult2 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult2.content);

  await assert.rejects(
    call("directorate_report", { seal }, "directorate_liaison", "other-lead"),
    /Only the session that sealed/u
  );
  await assert.rejects(
    call(
      "directorate_coverage",
      { disposition: "skipped", note: "x", regions: ["R1"], seal },
      "directorate_liaison",
      "other-lead"
    ),
    /Only the session that sealed/u
  );
  await call(
    "directorate_ledger_add",
    add(seal),
    "directorate_auditor",
    "scout"
  );
  await assert.rejects(
    call(
      "directorate_ledger_verdict",
      {
        evidence: ["src/a.ts:1"],
        id: "F1",
        rationale: "r",
        seal,
        verdict: "refuted",
      },
      "build",
      "build"
    ),
    /Only directorate_liaison or directorate_compliance/u
  );
  await assert.rejects(
    call("directorate_ledger_verdict", {
      evidence: ["src/a.ts:1"],
      id: "F1",
      rationale: "r",
      seal,
      verdict: "refuted",
    }),
    /needs directorate_compliance/u
  );
});

test("full flow: children registered at launch, gates, compliance confirms, report stops running children", async () => {
  const { S, call, launch, interrupted } = await harness(repo());

  const contentResult3 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult3.content);

  const contentResult4 = await call("directorate_diff", { seal });
  const d1 = contentResult4.content;
  assert.match(d1, /columns: old line, new line/u);
  assert.match(d1, /^\s+2 \+export const div/mu);

  const finish = await launch(
    "call-1",
    "directorate_auditor",
    "seal: x\nquestion: Is y ever zero?",
    "child1",
    "running"
  );

  assert.deepEqual(
    [
      present(sealJson(seal).children[0]).status,
      present(sealJson(seal).children[0]).session,
    ],
    ["running", S("child1")],
    "linked when its session was created"
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Still running: directorate_auditor/u
  );
  await finish();
  assert.equal(present(sealJson(seal).children[0]).session, S("child1"));
  await assert.rejects(
    call(
      "directorate_ledger_add",
      add(seal, { quote: "export const div = (x, y) => x % y" }),
      "directorate_auditor",
      "child1"
    ),
    /quote not found/u
  );
  await call(
    "directorate_ledger_add",
    add(seal),
    "directorate_auditor",
    "child1"
  );
  await call(
    "directorate_ledger_add",
    add(seal, {
      evidence: ["src/b.ts:1"],
      line: 1,
      path: "src/b.ts",
      quote: "export const b = 2",
      severity: "minor",
      title: "Speculative",
    }),
    "directorate_auditor",
    "child1"
  );
  await call(
    "directorate_ledger_verdict",
    {
      evidence: ["./src/a.ts:2"],
      id: "F1",
      rationale: "retraced",
      seal,
      verdict: "confirmed",
    },
    "directorate_compliance",
    "ref"
  );

  const contentResult5 = await call(
    "directorate_ledger_list",
    { ids: ["F1"], seal },
    "directorate_compliance",
    "ref"
  );

  assert.match(
    contentResult5.content,
    /confirmed \(important\) by directorate_compliance: retraced \[src\/a.ts:2\]/u
  );

  const contentResult6 = await call(
    "directorate_ledger_list",
    { brief: true, seal },
    "directorate_compliance",
    "ref"
  );

  assert.match(
    contentResult6.content,
    /- F2 \[open\] minor · Speculative — src\/b.ts:1/u
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Unverified Dossier\): 1 entries/u
  );

  const contentResult7 = await call("directorate_report", {
    approach: "ok",
    seal,
  });

  const md = contentResult7.content;

  assert.match(md, /status: \*\*partial\*\*/u);
  assert.match(md, /\[Important\] Division by zero/u);
  assert.match(md, /### Unverified Leads[\s\S]*Speculative/u);
  assert.match(md, /directorate_auditor did not finish: Is y ever zero\?/u);
  assert.deepEqual(interrupted, [S("child1")]);
  await assert.rejects(
    call("directorate_ledger_add", add(seal), "directorate_auditor", "child1"),
    /already reported/u
  );
  const contentResult8 = await call("directorate_report", { seal });
  assert.equal(contentResult8.content, md);
});

test("panel: seats assigned at launch, separate reads, credit across seats, a gate for missing seats, one combined report", async () => {
  const { S, call, hooks, bus } = await harness(repo());
  const models = ["prov/alpha#high", "prov/beta", "other/gamma#xhigh"];
  await assert.rejects(
    call("directorate_seal", {
      mode: "default",
      panel_models: ["no-provider"],
      target: { kind: "local" },
    }),
    /providerID\/modelID/u
  );

  const contentResult9 = await call("directorate_seal", {
    mode: "default",
    panel_models: models,
    target: { kind: "local" },
  });

  const out = contentResult9.content;

  assert.match(
    out,
    /budget 30 min/u,
    "a panel gets half again the mode's budget"
  );
  assert.match(out, /Directorate Seats \(3\): alpha#high, beta, gamma#xhigh/u);
  const seal = sealOf(out);

  // Launched without a model, each Seat takes the next open seat; its title names the seat, and its session claims it.
  const launch = async (callId: string, child: string) => {
    const event: ToolBeforeEvent = {
      agent: "directorate_liaison",
      id: callId,
      input: {
        agent: "directorate_seat",
        description: "Directorate Seat",
        prompt: `seal: ${seal}`,
      },
      sessionID: S("lead"),
      tool: "subagent",
    };

    await present(hooks["tool.execute.before"])(event);
    parents.set(S(child), S("lead"));
    await bus.emit({
      data: {
        agent: "directorate_seat",
        parentID: S("lead"),
        sessionID: S(child),
        title: event.input?.description,
      },
      type: "session.created",
    });

    return present(event.input);
  };

  const inputs = [
    await launch("p1", "pa"),
    await launch("p2", "pb"),
    await launch("p3", "pc"),
  ];

  assert.deepEqual(
    inputs.map((i) => [i.model, i.description]),
    models.map((m, i) => [
      m,
      `Directorate Seat · ${m.slice(m.indexOf("/") + 1)} · p${i + 1}`,
    ])
  );
  assert.deepEqual(
    sealJson(seal).children.map((c) => [c.model, c.session]),
    models.map((m, i) => [m, S(`p${String.fromCodePoint(97 + i)}`)])
  );

  // Every seat reads every region, apart from the Liaison and from each other.
  await runEach(["pa", "pb"], async (p) => {
    const contentResult10 = await call(
      "directorate_diff",
      { seal },
      "directorate_seat",
      p
    );

    assert.match(contentResult10.content, /export const div/u);

    const contentResult11 = await call(
      "directorate_diff",
      { seal },
      "directorate_seat",
      p
    );

    assert.match(contentResult11.content, /All regions have been read/u);
  });

  const contentResult12 = await call("directorate_diff", { seal });
  assert.match(
    contentResult12.content,
    /export const div/u,
    "Seat reads do not cover the Liaison"
  );
  await call(
    "directorate_ledger_add",
    add(seal, { brief: "none: searched guard in src/" }),
    "directorate_seat",
    "pa"
  );

  const contentResult13 = await call(
    "directorate_ledger_add",
    add(seal, { title: "Divide by zero" }),
    "directorate_seat",
    "pb"
  );

  const pbAdd = contentResult13.content;

  assert.doesNotMatch(
    pbAdd,
    /Nearby entries/u,
    "Seats stay blind to other entries under memetic isolation"
  );

  const contentResult14 = await call(
    "directorate_ledger_list",
    { ids: ["F1"], seal },
    "directorate_compliance",
    "ref"
  );

  assert.match(
    contentResult14.content,
    /brief: none: searched guard in src\//u,
    "directorate_ledger_list exposes brief to Compliance"
  );

  const contentResult15 = await call(
    "directorate_ledger_list",
    { brief: true, seal },
    "directorate_compliance",
    "ref"
  );

  assert.match(
    contentResult15.content,
    /F1 .* by alpha#high\n.*F2 .* by beta/u
  );
  await call(
    "directorate_ledger_verdict",
    {
      evidence: ["src/a.ts:2"],
      id: "F1",
      rationale: "retraced",
      seal,
      verdict: "confirmed",
    },
    "directorate_compliance",
    "ref"
  );
  await call(
    "directorate_ledger_verdict",
    {
      evidence: ["src/a.ts:2"],
      id: "F2",
      of: "F1",
      rationale: "same",
      seal,
      verdict: "duplicate",
    },
    "directorate_compliance",
    "ref"
  );

  await runEach(["pa", "pb"], (p) =>
    bus.emit({ data: { sessionID: S(p) }, type: "session.idle" })
  );

  await bus.emit({
    data: { sessionID: S("pc") },
    type: "session.execution.failed",
  });
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Seats\): 1 of 3 Directorate Seats returned no review: gamma#xhigh \(failed\)/u
  );
  // A relaunch takes the failed seat again; when that run fails too, the report goes out without it.
  const modelResult = await launch("p4", "pd");
  assert.equal(modelResult.model, "other/gamma#xhigh");
  await bus.emit({
    data: { sessionID: S("pd") },
    type: "session.execution.failed",
  });
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Seats\)/u,
    "a new failed run is a new gap"
  );
  const contentResult16 = await call("directorate_report", { seal });
  const md = contentResult16.content;
  assert.match(md, /status: \*\*partial\*\*/u);
  assert.match(md, /1 of 3 Directorate Seats did not review/u);
  assert.match(
    md,
    /Directorate Seats: alpha#high, beta, gamma#xhigh \(memetic isolation intact\)/u
  );
  assert.match(
    md,
    /\[Important\] Division by zero\*\* — `src\/a.ts:2` · defect · correctness · seats 2\/3/u
  );
  assert.match(
    md,
    /raised by alpha#high, confirmed by directorate_compliance · also raised by beta/u
  );
  assert.match(
    md,
    /### Directorate Seats\n\| Seat \| Review \| Raised \| Confirmed \| Only this seat \|\n.*\n\| alpha#high \| completed \| 1 \| 1 \| — \|\n\| beta \| completed \| 1 \| 1 \| — \|\n\| gamma#xhigh \| failed \| 0 \| 0 \| — \|/u
  );
  assert.match(md, /Directorate Seat gamma#xhigh: its review failed/u);
  assert.doesNotMatch(
    md,
    /directorate_seat did not complete/u,
    "a failed seat is reported once, as its seat"
  );
});

test("panel: true seats the default models; a seat named a model by the Liaison keeps it", async () => {
  const { S, call, hooks } = await harness(repo());

  const contentResult17 = await call("directorate_seal", {
    mode: "default",
    panel: true,
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult17.content);

  assert.equal(sealJson(seal).panel?.length, 5);

  const event: ToolBeforeEvent = {
    agent: "directorate_liaison",
    id: "p1",
    input: {
      agent: "directorate_seat",
      model: "prov/chosen",
      prompt: "x",
    },
    sessionID: S("lead"),
    tool: "subagent",
  };

  await present(hooks["tool.execute.before"])(event);
  assert.equal(event.input?.model, "prov/chosen");
  assert.equal(present(sealJson(seal).children[0]).model, "prov/chosen");

  const contentResult18 = await call("directorate_seal", {
    abandon: true,
    mode: "default",
    target: { kind: "local" },
  });

  assert.match(
    contentResult18.content,
    /^(?![\s\S]*Directorate Seats \()/u,
    "no panel unless asked"
  );
});

interface DialogOption {
  category?: string;
  description?: string;
  disabled?: boolean;
  group?: string;
  title: string;
  value: string | number | boolean | ToolInput;
}

interface DialogPrompt {
  description?: string;
  message?: string;
  options?: DialogOption[];
  title: string;
}

type DialogStepResult = DialogOption["value"] | undefined;

type DialogStep = (dialog: DialogPrompt) => DialogStepResult;

interface SeenDialog extends DialogPrompt {
  kind: string;
}

interface ToastMessage {
  description?: string;
  message?: string;
  title?: string;
  variant?: string;
}

interface AlertMessage {
  description?: string;
  message?: string;
  title: string;
}

interface TuiCommand {
  id: string;
  palette?: boolean;
  run: () => Promise<void>;
  slash?: { name: string };
}

interface TuiLayer {
  commands: TuiCommand[];
  mode?: string;
}

interface DesktopCommand {
  id: string;
  run: () => Promise<void>;
  slash?: { name: string };
}

interface DesktopRegistry {
  readonly id?: string;
}

interface DesktopContext {
  add: (_registry: DesktopRegistry, item: () => DesktopCommand) => void;
  client: string;
  dialogs: {
    alert: (a: AlertMessage) => Promise<void>;
    confirm: (dialog: DialogPrompt) => Promise<DialogStepResult>;
    prompt: (dialog: DialogPrompt) => Promise<DialogStepResult>;
    select: (dialog: DialogPrompt) => Promise<DialogStepResult>;
  };
  sessions: {
    current: () =>
      | ({ location?: { directory: string } } & {
          server: { client: TestRpcClient };
        })
      | undefined;
  };
  signal: AbortSignal;
  toast: { show: (t: ToastMessage) => void };
}

interface DesktopModule {
  exports: {
    default?: {
      setup: (context: DesktopContext) => void;
    };
  };
}

/**
 * The TUI part against a scripted user: each select, prompt, and confirm takes the next step, which answers from the
 * dialog's options. /directorate-configure is run as the TUI runs it, through the command the plugin's keymap layer registers.
 */
const tui = (client: TestRpcClient, dir: string, steps: DialogStep[]) => {
  const seen: SeenDialog[] = [];
  const toasts: ToastMessage[] = [];
  const alerts: AlertMessage[] = [];
  const layers: TuiLayer[] = [];

  const answer = (kind: string) => (dialog: DialogPrompt) => {
    seen.push({ kind, ...dialog });
    const step = steps.shift();
    assert.ok(step, `no step left for ${kind} "${dialog.title}"`);

    return Promise.resolve(step(dialog));
  };

  const context = {
    client,
    data: { location: { default: () => ({ directory: dir }) } },
    keymap: {
      layer: (factory: () => TuiLayer) => {
        layers.push(factory());
      },
    },
    location: { directory: dir },
    ui: {
      dialog: {
        alert: (a: AlertMessage) => {
          alerts.push(a);

          return Promise.resolve();
        },
        confirm: answer("confirm"),
        prompt: answer("prompt"),
        select: answer("select"),
      },
      format: { path: (p: string) => p },
      toast: {
        show: (t: ToastMessage) => {
          toasts.push(t);
        },
      },
    },
  };

  // SAFETY: test double provides every TUI Plugin.Context surface that tui.ts uses.
  tuiPlugin.setup(
    Object.assign(Object.create(null) as TuiPlugin.Context, context)
  );
  const [layer] = layers;
  assert.ok(layer);
  const [command] = layer.commands;
  assert.ok(command);

  return {
    alerts,
    command,
    layer,
    left: () => steps.length,
    run: () => command.run(),
    seen,
    toasts,
  };
};

/**
 * The GUI part as OpenCode Desktop loads it: the built dist/gui-experimental.cjs (npm test builds it first), evaluated
 * as CommonJS text with the modules the app provides. Each dialog takes the next step, as in tui().
 */
const desktop = async (
  client: TestRpcClient,
  session: { location?: { directory: string } } | undefined,
  steps: DialogStep[],
  signal = new AbortController().signal
) => {
  const guiModule = await import("@opencode/plugin/gui");
  const rpcModule = await import("@opencode/plugin/rpc");
  const effectModule = await import("effect");

  const module: DesktopModule = { exports: {} };

  const require = (id: string) => {
    if (id === "@opencode/plugin/gui") {
      return guiModule;
    }

    if (id === "@opencode/plugin/rpc") {
      return rpcModule;
    }

    if (id === "effect") {
      return effectModule;
    }

    return assert.fail(
      `the GUI bundle requires ${id}, which the app does not provide`
    );
  };

  const bundleSource = readFileSync(
    new URL("../dist/gui-experimental.cjs", import.meta.url),
    "utf-8"
  );

  const evaluateBundle: (
    exports: DesktopModule["exports"],
    requireFn: typeof require,
    mod: DesktopModule
  ) => void = runInThisContext(
    `(function(exports, require, module) {\n${bundleSource}\n})`
  );

  evaluateBundle(module.exports, require, module);
  const seen: SeenDialog[] = [];
  const toasts: ToastMessage[] = [];
  const alerts: AlertMessage[] = [];
  const commands: DesktopCommand[] = [];

  const ask = (kind: string) => (dialog: DialogPrompt) => {
    seen.push({ kind, ...dialog });
    const step = steps.shift();
    assert.ok(step, `no step left for ${kind} "${dialog.title}"`);

    return Promise.resolve(step(dialog));
  };

  const ctx: DesktopContext = {
    add: (_registry, item) => {
      commands.push(item());
    },
    client: "the app's own server: used only with no session",
    dialogs: {
      alert: (a) => {
        alerts.push(a);

        return Promise.resolve();
      },
      confirm: ask("confirm"),
      prompt: ask("prompt"),
      select: ask("select"),
    },
    sessions: { current: () => session && { ...session, server: { client } } },
    signal,
    toast: {
      show: (t) => {
        toasts.push(t);
      },
    },
  };

  present(module.exports.default).setup(ctx);
  const [command] = commands;
  assert.ok(command);

  return {
    alerts,
    command,
    left: () => steps.length,
    seen,
    toasts,
  };
};

/** Picks the option with this title; it must be offered and enabled. */
const pick = (title: string) => (d: DialogPrompt) => {
  const options = d.options ?? [];
  const o = options.find((x) => x.title === title);
  assert.ok(
    o && !o.disabled,
    `"${title}" not offered in "${d.title}": ${options.map((x) => x.title).join(", ")}`
  );

  return o.value;
};

const esc = (): undefined => undefined;

test("Desktop configuration stops when its plugin is unloaded during a dialog", async () => {
  const dir = repo();
  const { client } = await harness(dir);
  const controller = new AbortController();

  const d = await desktop(
    client,
    { location: { directory: dir } },
    [
      (dialog) => {
        controller.abort();

        return pick("Global Charter")(dialog);
      },
    ],
    controller.signal
  );

  await d.command.run();
  assert.deepEqual(
    d.seen.map((dialog) => dialog.title),
    ["The Directorate // Settings"]
  );
  assert.deepEqual(d.alerts, []);
  assert.deepEqual(d.toasts, []);
});

test("/directorate-configure in the TUI: a slash and palette command whose dialogs write directorate.json through the RPC", async () => {
  const dir = repo();
  const { client } = await harness(dir);

  const t = tui(client, dir, [
    pick("Global Charter"),
    pick("Default review scope"),
    pick("local"),
    pick("Default mode"),
    pick("full"),
    pick("Panel by default"),
    pick("On"),
    pick("Directorate Seats (panel models)"),
    pick("Add a Seat…"),
    (d) => {
      assert.deepEqual(
        (d.options ?? []).map((o) => o.title),
        ["prov/alpha", "prov/beta"],
        "disabled models are not offered"
      );

      return pick("prov/alpha")(d);
    },
    pick("xhigh"),
    pick("Add a Seat…"),
    pick("prov/beta"),
    pick("prov/beta"),
    pick("Move up"),
    esc,
    pick("Time budgets"),
    pick("full"),
    () => "500",
    pick("full"),
    () => "45",
    esc,
    pick("Disabled lenses"),
    pick("ux"),
    pick("docs"),
    pick("ux"),
    esc,
    (d) => {
      assert.match(d.title, /Global Charter \(unsaved\)/u);

      return pick("Save")(d);
    },
  ]);

  assert.equal(t.command.id, "directorate.configure");
  assert.equal(
    t.layer.mode,
    "global",
    "a base-mode layer's slash command never completes in the prompt"
  );
  assert.deepEqual(t.command.slash, { name: "directorate-configure" });
  assert.equal(t.command.palette, true);
  await t.run();
  assert.equal(t.left(), 0);
  assert.deepEqual(t.alerts, []);
  assert.match(present(t.toasts[0]?.message), /"500" is not 2–240 minutes/u);
  assert.deepEqual(JSON.parse(readFileSync(globalSettings, "utf-8")), {
    budget_minutes: { full: 45 },
    default_scope: "local",
    lenses: { disabled: ["docs"] },
    mode: "full",
    panel: {
      enabled: true,
      models: [
        { model: "prov/beta" },
        { model: "prov/alpha", variant: "xhigh" },
      ],
    },
  });
  assert.equal(t.toasts[1]?.variant, "success");
  assert.equal(
    present(t.toasts[1]?.message),
    `<Filed/Saved> ${globalSettings}. Effective: mode full · scope local · panel on · panel models prov/beta, prov/alpha#xhigh · budgets full 45 min · lenses off docs.`
  );
});

test("/directorate-configure in OpenCode Desktop: the built GUI bundle runs the same walk through the session's server", async () => {
  const dir = repo();
  const { client } = await harness(dir);

  const d = await desktop(client, { location: { directory: dir } }, [
    (x) => {
      assert.deepEqual(
        (x.options ?? []).map((o) => o.title),
        ["Global Charter", "Local Jurisdiction (This project)"]
      );

      return pick("Local Jurisdiction (This project)")(x);
    },
    pick("Default mode"),
    pick("full"),
    pick("Time budgets"),
    pick("full"),
    (x) => {
      assert.match(
        present(x.description),
        /Type "unset" to fall back to 60, ×1\.5 for panels min/u
      );

      return "30";
    },
    pick("default"),
    () => "unset",
    esc,
    (x) => {
      assert.equal(
        (x.options ?? []).find((o) => o.title === "Save")?.group,
        "File"
      );

      return pick("Save")(x);
    },
  ]);

  assert.equal(d.command.id, "configure");
  assert.deepEqual(d.command.slash, { name: "directorate-configure" });
  await d.command.run();
  assert.equal(d.left(), 0);
  assert.deepEqual(d.alerts, []);
  assert.deepEqual(
    JSON.parse(
      readFileSync(path.join(dir, ".opencode", "directorate.json"), "utf-8")
    ),
    { budget_minutes: { full: 30 }, mode: "full" }
  );
  assert.equal(d.toasts[0]?.variant, "success");
  assert.equal(
    present(d.toasts[0]?.description),
    `<Filed/Saved> ${path.join(dir, ".opencode", "directorate.json")}. Effective: mode full · budgets full 30 min.`
  );

  // The app's select has no disabled options: in the home directory, "Local Jurisdiction (This project)" is left out.
  mkdirSync(home, { recursive: true });
  const h = await harness(home);

  const x = await desktop(h.client, { location: { directory: home } }, [
    (s) => {
      assert.deepEqual(
        (s.options ?? []).map((o) => o.title),
        ["Global Charter"]
      );

      return esc();
    },
  ]);

  await x.command.run();
  assert.equal(x.left(), 0);
});

test("/directorate-configure in the TUI: project over global, a rejected save is shown and fixable, unsaved changes need confirming", async () => {
  const dir = repo();
  const { client } = await harness(dir);
  mkdirSync(path.join(home, ".opencode"), { recursive: true });
  writeFileSync(
    globalSettings,
    JSON.stringify({ lenses: { disabled: ["ux"] }, mode: "code-quality" })
  );
  mkdirSync(path.join(dir, ".opencode"), { recursive: true });
  writeFileSync(
    path.join(dir, ".opencode", "directorate.json"),
    JSON.stringify({ panel: { models: [{ model: "prov/off" }] } })
  );

  const t = tui(client, dir, [
    pick("Local Jurisdiction (This project)"),
    (d) => {
      const by = Object.fromEntries(
        (d.options ?? []).map((o) => [o.title, o.description])
      );

      assert.equal(
        by["Default mode"],
        "unset: code-quality",
        "an unset key shows what it falls back to"
      );
      assert.equal(by["Disabled lenses"], "ux");
      assert.equal(by["Directorate Seats (panel models)"], "prov/off");

      return pick("Disabled lenses")(d);
    },
    (d) => {
      assert.equal(
        (d.options ?? []).find((o) => o.title === "ux")?.description,
        "off"
      );

      return pick("ux")(d);
    },
    esc,
    pick("Save"),
    pick("Directorate Seats (panel models)"),
    pick("prov/off"),
    pick("Remove"),
    esc,
    pick("Save"),
  ]);

  await t.run();
  assert.equal(t.left(), 0);
  assert.match(present(t.alerts[0]?.title), /not saved/u);
  assert.match(
    present(t.alerts[0]?.message),
    /prov\/off is not an available chat model/u
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(path.join(dir, ".opencode", "directorate.json"), "utf-8")
    ),
    { lenses: { disabled: [] } },
    "an empty list still overrides the global one"
  );
  assert.match(
    present(t.toasts[0]?.message),
    /Effective: mode code-quality\.$/u
  );

  // Escape with unsaved changes asks first; keeping them returns to the menu.
  const before = readFileSync(globalSettings, "utf-8");

  const u = tui(client, dir, [
    pick("Global Charter"),
    pick("Default mode"),
    pick("full"),
    esc,
    () => false,
    esc,
    () => true,
  ]);

  await u.run();
  assert.equal(u.left(), 0);
  assert.equal(u.seen.filter((d) => d.kind === "confirm").length, 2);
  assert.equal(
    readFileSync(globalSettings, "utf-8"),
    before,
    "discarded changes are not written"
  );

  // In the home directory the project file would be the global one: there is no project scope.
  mkdirSync(home, { recursive: true });
  const h = await harness(home);

  const x = tui(h.client, home, [
    (d) => {
      assert.equal(
        (d.options ?? []).find(
          (o) => o.title === "Local Jurisdiction (This project)"
        )?.disabled,
        true
      );

      return esc();
    },
  ]);

  await x.run();
  assert.equal(x.left(), 0);
  const { write } = h.client.rpc(DirectorateRpc);
  assert.ok(write);
  await assert.rejects(
    write({ scope: "project", settings: { mode: "full" } }),
    { message: /^No project settings here/u, type: "rejected" }
  );
  assert.equal(
    readFileSync(globalSettings, "utf-8"),
    before,
    "the global file is untouched"
  );

  // A settings file the server cannot read is reported, not edited over.
  writeFileSync(globalSettings, `{ "mode": "fast" }`);
  const b = tui(client, dir, []);
  await b.run();
  assert.match(
    present(b.alerts[0]?.message),
    /directorate\.json is not valid Directorate settings/u
  );
});

test("directorate_configure rejects an invalid other scope before changing global settings", async () => {
  const dir = repo();
  const { call } = await harness(dir);
  mkdirSync(path.join(dir, ".opencode"));
  writeFileSync(path.join(dir, ".opencode/directorate.json"), "{invalid");
  mkdirSync(path.join(home, ".opencode"), { recursive: true });
  writeFileSync(globalSettings, '{"mode":"full"}\n');

  await runEach([{ mode: "default" }, {}], async (settings) => {
    await assert.rejects(
      call(
        "directorate_configure",
        { action: "write", scope: "global", settings },
        "build",
        "cfg"
      ),
      /is not valid Directorate settings/u
    );
    assert.equal(readFileSync(globalSettings, "utf-8"), '{"mode":"full"}\n');
  });
});

test("settings dialogs do not save unchanged drafts or overwrite changes saved by another client", async () => {
  const dir = repo();
  const first = await harness(dir);
  const second = await harness(dir);
  const write = present(first.client.rpc(DirectorateRpc).write);
  const staleWrite = present(second.client.rpc(DirectorateRpc).write);

  await write({
    previous: {},
    scope: "global",
    settings: { default_scope: "local" },
  });
  await assert.rejects(
    staleWrite({
      previous: {},
      scope: "global",
      settings: { budget_minutes: { full: 80 } },
    }),
    { message: /changed since this dialog opened/u, type: "rejected" }
  );
  assert.deepEqual(JSON.parse(readFileSync(globalSettings, "utf-8")), {
    default_scope: "local",
  });

  const noChanges = tui(second.client, dir, [
    pick("Global Charter"),
    (d) => {
      writeFileSync(globalSettings, '{"default_scope":"repository"}\n');

      return pick("Save (no changes)")(d);
    },
  ]);

  await noChanges.run();
  assert.equal(noChanges.left(), 0);
  assert.deepEqual(noChanges.alerts, []);
  assert.equal(
    readFileSync(globalSettings, "utf-8"),
    '{"default_scope":"repository"}\n'
  );
});

test("settings show keeps an explicit empty lens override but not empty sections", async () => {
  const dir = repo();
  const { call } = await harness(dir);

  const cfg = (input: ToolInput) =>
    call("directorate_configure", input, "build", "cfg");

  await cfg({
    action: "write",
    scope: "global",
    settings: { lenses: { disabled: ["ux"] } },
  });
  await cfg({
    action: "write",
    scope: "project",
    settings: { budget_minutes: {}, lenses: { disabled: [] }, panel: {} },
  });
  const project = path.join(dir, ".opencode", "directorate.json");
  assert.deepEqual(JSON.parse(readFileSync(project, "utf-8")), {
    lenses: { disabled: [] },
  });
  const { content } = await cfg({ action: "show" });
  assert.match(
    content,
    /^Project .*:\s+```json\n\{\n\s+"lenses": \{\n\s+"disabled": \[\]/mu
  );
  assert.match(content, /^Effective: Directorate defaults\.$/mu);
});

test("the example settings use the built-in full panel budget", async () => {
  const { call } = await harness(repo());
  mkdirSync(path.dirname(globalSettings), { recursive: true });
  writeFileSync(
    globalSettings,
    readFileSync(new URL("../directorate.example.json", import.meta.url))
  );

  const { content } = await call("directorate_seal", {
    target: { kind: "local" },
  });

  assert.match(
    content,
    new RegExp(`budget ${DEFAULT_BUDGET.full * PANEL_BUDGET_FACTOR} min`, "u")
  );
});

test("directorate_configure: validated writes per scope; the project overrides global key by key; seals use the result", async () => {
  const dir = repo();
  const { call, hooks, S } = await harness(dir);

  const cfg = (input: ToolInput) =>
    call("directorate_configure", input, "build", "cfg");

  await assert.rejects(
    call("directorate_configure", { action: "show" }),
    /review agents cannot modify Directorate settings/u
  );
  await assert.rejects(
    cfg({
      action: "write",
      scope: "global",
      settings: { lenses: { disabled: ["auth"] } },
    }),
    /auth|Expected/u,
    "the domain lenses are gone"
  );
  await assert.rejects(
    cfg({
      action: "write",
      scope: "global",
      settings: { panel: { models: [{ model: "prov/off" }] } },
    }),
    /prov\/off is not an available chat model/u
  );
  await assert.rejects(
    cfg({
      action: "write",
      scope: "global",
      settings: {
        panel: { models: [{ model: "prov/alpha", variant: "max" }] },
      },
    }),
    /no thinking level "max" \(it has: high, xhigh\)/u
  );
  await assert.rejects(
    cfg({
      action: "write",
      scope: "global",
      settings: { panel: { models: [{ model: "prov/alpha#high" }] } },
    }),
    /put the thinking level in variant/u
  );

  const contentResult19 = await cfg({
    action: "write",
    scope: "global",
    settings: {
      budget_minutes: { "code-quality": 12 },
      mode: "code-quality",
      panel: {
        enabled: true,
        models: [
          { model: "prov/alpha", variant: "xhigh" },
          { model: "prov/beta" },
        ],
      },
    },
  });

  const g = contentResult19.content;

  assert.ok(g.includes(`Wrote ${globalSettings}`));
  assert.deepEqual(
    JSON.parse(readFileSync(globalSettings, "utf-8")).panel.models[0],
    { model: "prov/alpha", variant: "xhigh" }
  );

  const contentResult20 = await cfg({
    action: "write",
    scope: "project",
    settings: {
      lenses: { disabled: ["ux", "docs"] },
      panel: { enabled: false },
    },
  });

  const p = contentResult20.content;

  assert.ok(
    p.startsWith(`Wrote ${path.join(dir, ".opencode", "directorate.json")}:`)
  );
  assert.match(
    p,
    /"disabled": \[\n\s+"ux"[\s\S]*\nEffective settings: mode code-quality · panel off · panel models prov\/alpha#xhigh, prov\/beta · budgets code-quality 12 min · lenses off ux, docs/u
  );
  const contentResult21 = await cfg({ action: "show", find: "ALP" });
  const shown = contentResult21.content;
  assert.match(shown, /- prov\/alpha \(Alpha\) \[high, xhigh\]/u);
  assert.doesNotMatch(shown, /prov\/beta \(/u);

  // The Liaison sees the settings before it seals.
  const ctx: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: {},
  };

  await present(hooks["session.context"])(ctx);
  assert.match(
    present(ctx.system[0]?.text),
    /^\[directorate settings\] mode code-quality · panel off/u
  );

  // Configured mode, budget, and lenses; the project turned the panel off, and a request turns it back on.
  const contentResult22 = await call("directorate_seal", {
    panel: true,
    target: { kind: "local" },
  });

  const out = contentResult22.content;

  assert.match(out, /budget 12 min/u, "a configured budget is used as-is");
  assert.match(out, /Lenses disabled by directorate.json: ux, docs/u);
  assert.match(out, /Directorate Seats \(2\): alpha#xhigh, beta/u);
  const seal = sealOf(out);
  assert.equal(sealJson(seal).mode, "code-quality");

  // The settings system line stays identical after sealing—even if directorate.json changes mid-review—so the KV-cache prefix holds.
  const ctxAfter: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: {},
  };

  await present(hooks["session.context"])(ctxAfter);
  assert.equal(ctxAfter.system[0]?.text, ctx.system[0]?.text);
  await cfg({
    action: "write",
    scope: "project",
    settings: { mode: "full" },
  });

  const ctxAfterEdit: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: {},
  };

  await present(hooks["session.context"])(ctxAfterEdit);
  assert.equal(ctxAfterEdit.system[0]?.text, ctx.system[0]?.text);
  await cfg({
    action: "write",
    scope: "project",
    settings: {
      lenses: { disabled: ["ux", "docs"] },
      panel: { enabled: false },
    },
  });
  await assert.rejects(
    call(
      "directorate_ledger_add",
      add(seal, { lens: "ux" }),
      "directorate_auditor",
      "scout"
    ),
    /ux lens is disabled/u
  );
  await assert.rejects(
    call(
      "directorate_ledger_add",
      add(seal, { lens: "billing" }),
      "directorate_auditor",
      "scout"
    ),
    /Expected "correctness" | "security"/u,
    "only the ten lenses are accepted"
  );
  await call(
    "directorate_ledger_add",
    add(seal),
    "directorate_auditor",
    "scout"
  );

  const contentResult23 = await call("directorate_seal", {
    abandon: true,
    mode: "default",
    target: { kind: "local" },
  });

  const off = contentResult23.content;

  assert.doesNotMatch(
    off,
    /Directorate Seats \(/u,
    "the project's panel off wins over the global on"
  );
  assert.match(off, /budget 20 min/u);

  // {} removes a scope's file; a broken file is an error the tool names.
  const contentResult24 = await cfg({
    action: "write",
    scope: "global",
    settings: {},
  });

  assert.match(contentResult24.content, /Removed/u);
  writeFileSync(
    path.join(dir, ".opencode", "directorate.json"),
    `{ "mode": "fast" }`
  );
  await assert.rejects(
    cfg({ action: "show" }),
    /directorate\.json is not valid Directorate settings/u
  );
  writeFileSync(
    path.join(dir, ".opencode", "directorate.json"),
    `{ "lense": { "disabled": ["ux"] } }`
  );
  await assert.rejects(
    cfg({ action: "show" }),
    /not valid Directorate settings.*lense/su,
    "a misspelled key in a file is an error, not ignored"
  );
});

test("gates fire again for new gaps: a new entry after an acknowledged open gate pushes back once more", async () => {
  const { call } = await harness(repo());

  const contentResult25 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult25.content);

  await call("directorate_diff", { seal });
  await call(
    "directorate_ledger_add",
    add(seal, { severity: "minor" }),
    "directorate_auditor",
    "scout"
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Unverified Dossier\): 1 entries/u
  );
  await call(
    "directorate_ledger_add",
    add(seal, {
      evidence: ["src/b.ts:1"],
      line: 1,
      path: "src/b.ts",
      quote: "export const b = 2",
      severity: "minor",
      title: "Another",
    }),
    "directorate_auditor",
    "scout"
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Unverified Dossier\): 2 entries/u,
    "F2 is new"
  );
  const contentResult26 = await call("directorate_report", { seal });
  const md = contentResult26.content;
  assert.match(md, /2 leads unverified/u);
});

test("a completed report closes the ledger", async () => {
  const { call } = await harness(repo());

  const contentResult27 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult27.content);

  await call("directorate_diff", { seal });
  await call("directorate_report", { seal });
  await assert.rejects(
    call("directorate_ledger_add", add(seal), "directorate_auditor", "scout"),
    /already reported/u
  );
});

test("child events: early completion is reconciled; failure overrides idle", async () => {
  const { S, call, launch, bus } = await harness(repo());

  const contentResult28 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult28.content);

  await call("directorate_diff", { seal });

  const fin1 = await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "running"
  );

  await bus.emit({ data: { sessionID: S("a") }, type: "session.idle" });
  await fin1();
  assert.equal(present(sealJson(seal).children[0]).status, "completed");

  const fin2 = await launch(
    "c2",
    "directorate_auditor",
    "seal: x\nquestion: q2",
    "b",
    "running"
  );

  await fin2();
  await bus.emit({
    data: { sessionID: S("b") },
    type: "session.execution.failed",
  });
  await bus.emit({ data: { sessionID: S("b") }, type: "session.idle" });
  assert.equal(present(sealJson(seal).children[1]).status, "failed");
  const contentResult29 = await call("directorate_report", { seal });
  assert.match(
    contentResult29.content,
    /directorate_auditor did not complete: q2/u
  );
});

test("directorate_note answered: only the Liaison settles a failed Auditor's exact question", async () => {
  const { S, call, launch, bus } = await harness(repo());

  const contentResult = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult.content);

  await call("directorate_diff", { seal });

  const fin = await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q2",
    "b",
    "running"
  );

  await fin();
  await bus.emit({
    data: { sessionID: S("b") },
    type: "session.execution.failed",
  });
  await bus.emit({ data: { sessionID: S("b") }, type: "session.idle" });

  await assert.rejects(
    call(
      "directorate_note",
      { kind: "answered", seal, text: "q2" },
      "directorate_auditor",
      "scout"
    ),
    /Only directorate_liaison/u
  );
  await assert.rejects(
    call("directorate_note", { kind: "answered", seal, text: "q3" }),
    /verbatim: "q2"/u
  );
  await call("directorate_note", {
    kind: "answered",
    seal,
    text: "question: q2",
  });

  const reported = await call("directorate_report", { seal });
  const md = reported.content;
  assert.match(md, /status: \*\*complete\*\*/u);
  assert.doesNotMatch(md, /did not complete|unanswered/iu);
});

test("directorate_wait: the Liaison waits in its turn until a run finishes, and hears what it recorded", async () => {
  const { S, call, launch, bus } = await harness(repo());

  const contentResult30 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult30.content);

  const contentResult31 = await call("directorate_wait", { seal });
  assert.match(
    contentResult31.content,
    /No Auditor, Seat, or Compliance runs are running/u
  );
  await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "running"
  );
  await launch(
    "c2",
    "directorate_compliance",
    "seal: x\nentries: [F1]",
    "b",
    "running"
  );
  await assert.rejects(
    call("directorate_wait", { seal }, "directorate_liaison", "other-lead"),
    /Only the session that sealed/u
  );
  let returned = false;

  const waiting = call("directorate_wait", { seal }).then((result) => {
    returned = true;

    return result.content;
  });

  await delay(1200);
  assert.equal(returned, false, "nothing finished: still waiting");
  await call("directorate_ledger_add", add(seal), "directorate_auditor", "a");
  await bus.emit({ data: { sessionID: S("a") }, type: "session.idle" });
  const out = await waiting;
  assert.match(
    out,
    /^- directorate_auditor completed \(ses_a-[^)]+\): raised F1$/mu
  );
  assert.match(
    out,
    /Still running \(1\): directorate_compliance \(ses_b-[^)]+\)\. .*call directorate_wait again/u
  );
  await bus.emit({ data: { sessionID: S("b") }, type: "session.idle" });
  const contentResult32 = await call("directorate_wait", { seal });
  assert.match(
    contentResult32.content,
    /No Auditor, Seat, or Compliance runs are running/u
  );
});

test("a Seat that returns normally after reading only one region cannot make a complete panel review", async () => {
  const { S, call, launch, bus } = await harness(repo());
  const model = "prov/alpha";

  const contentResult33 = await call("directorate_seal", {
    panel_models: [model],
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult33.content);

  assert.ok(seal);
  await call("directorate_diff", { seal });

  const returned = await launch(
    "seat",
    "directorate_seat",
    "Read the target",
    "seat",
    "running"
  );

  await returned();
  await call(
    "directorate_diff",
    { regions: ["R1"], seal },
    "directorate_seat",
    "seat"
  );
  await bus.emit({
    data: { sessionID: S("seat") },
    type: "session.execution.succeeded",
  });
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Seats\).*1 regions unread/u
  );
  const contentResult34 = await call("directorate_report", { seal });
  const md = contentResult34.content;
  assert.match(md, /status: \*\*partial\*\*/u);
  assert.match(md, /Directorate Seat alpha: 1 of 2 regions unread/u);
});

test("a panel with nothing to review misses no Seat", async () => {
  const dir = repo();
  execFileSync("git", ["-C", dir, "commit", "-qam", "clean"], {
    stdio: "pipe",
  });
  const { call } = await harness(dir);

  const sealed = await call("directorate_seal", {
    panel_models: ["prov/alpha"],
    target: { kind: "local" },
  });

  const seal = sealOf(sealed.content);
  const { content } = await call("directorate_report", { seal });
  assert.match(content, /status: \*\*complete\*\*/u);
  assert.doesNotMatch(content, /Directorate Seat alpha/u);
});

test("follow-ups to a subagent are new runs of its session: earlier runs keep their outcome, and directorate_wait reports the new run once", async () => {
  const { S, call, launch, bus, hooks, followUp } = await harness(repo());

  const contentResult35 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult35.content);

  await call(
    "directorate_ledger_add",
    add(seal),
    "directorate_auditor",
    "scout"
  );
  await call(
    "directorate_ledger_add",
    add(seal, {
      evidence: ["src/b.ts:1"],
      line: 1,
      path: "src/b.ts",
      quote: "export const b = 2",
      severity: "minor",
      title: "Second",
    }),
    "directorate_auditor",
    "scout"
  );

  const runs = () =>
    sealJson(seal).children.map((k) => [k.call, k.session, k.status]);

  await launch(
    "c1",
    "directorate_compliance",
    "seal: x\nentries: [F1]",
    "b",
    "running"
  );
  await call(
    "directorate_ledger_verdict",
    {
      evidence: ["src/a.ts:2"],
      id: "F1",
      rationale: "retraced",
      seal,
      verdict: "confirmed",
    },
    "directorate_compliance",
    "b"
  );
  await bus.emit({ data: { sessionID: S("b") }, type: "session.idle" });

  const f2 = await followUp(
    "c2",
    "directorate_compliance",
    "b",
    "seal: x\nentries: [F2]"
  );

  assert.deepEqual(runs(), [
    ["c1", S("b"), "completed"],
    ["c2", S("b"), "launching"],
  ]);
  await f2.enqueue();
  await f2.deliver();
  // The child working again belongs to the follow-up, not the earlier run.
  await present(hooks["tool.execute.before"])({
    agent: "directorate_compliance",
    id: "r1",
    input: {},
    sessionID: S("b"),
    tool: "directorate_read",
  });
  assert.equal(runs()[0]?.[2], "completed");
  const waiting = call("directorate_wait", { seal });
  await call(
    "directorate_ledger_verdict",
    {
      evidence: ["src/b.ts:1"],
      id: "F2",
      rationale: "guarded",
      seal,
      verdict: "refuted",
    },
    "directorate_compliance",
    "b"
  );
  await bus.emit({
    data: { sessionID: S("b") },
    type: "session.execution.succeeded",
  });
  const contentResult36 = await waiting;
  const out = contentResult36.content;
  assert.equal(out.match(/^- /gmu)?.length, 1, out);
  assert.match(
    out,
    /^- directorate_compliance completed \(ses_b-[^)]+\): decided F2 refuted$/mu,
    "only what this run recorded"
  );

  // A failed follow-up fails only itself.
  const f3 = await followUp(
    "c3",
    "directorate_compliance",
    "b",
    "seal: x\nentries: [F2]"
  );

  await f3.enqueue();
  await f3.deliver();
  await bus.emit({
    data: { sessionID: S("b") },
    type: "session.execution.failed",
  });
  assert.deepEqual(
    runs().map((r) => r[2]),
    ["completed", "completed", "failed"]
  );
  // Both calls can settle in the same busy period if it drains both prompts.
  await launch(
    "c4",
    "directorate_auditor",
    "seal: x\nquestion: q",
    "a",
    "running"
  );
  const f5 = await followUp("c5", "directorate_auditor", "a", "also check q2");
  await f5.enqueue();
  await f5.deliver();
  await bus.emit({
    data: { sessionID: S("a") },
    type: "session.execution.succeeded",
  });
  assert.deepEqual(runs().slice(-2), [
    ["c4", S("a"), "completed"],
    ["c5", S("a"), "completed"],
  ]);
});

test("a queued terminal event from a background run cannot finish an undelivered follow-up, even in the same millisecond", async () => {
  const { S, call, launch, bus, followUp } = await harness(repo());

  const contentResult37 = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult37.content);

  assert.ok(seal);
  const agent = "directorate_auditor";
  const sessionID = S("a");
  const first = await launch("first", agent, "question: first", "a", "running");
  await first();
  const next = await followUp("next", agent, "a", "question: next");

  const oldEvent = {
    created: DateTime.toEpochMillis(
      present(sealJson(seal).children[1]).startedAt
    ),
    data: { sessionID },
  };

  await next.enqueue();
  await bus.emit({ ...oldEvent, type: "session.execution.succeeded" });
  assert.equal(present(sealJson(seal).children[0]).status, "completed");
  await next.returned();
  assert.equal(present(sealJson(seal).children[1]).status, "running");
  await next.deliver();
  await bus.emit({ data: { sessionID }, type: "session.execution.succeeded" });
  assert.equal(present(sealJson(seal).children[1]).status, "completed");
});

test("directorate_wait: a budget that locks while it waits says to report, not to wait again", async () => {
  const { call, launch } = await harness(repo());

  const contentResult38 = await call("directorate_seal", {
    budget_minutes: 10,
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult38.content);

  await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "running"
  );
  shiftClock(seal, 10 - 1.5 / 60);
  const contentResult39 = await call("directorate_wait", { seal });
  const out = contentResult39.content;
  assert.match(out, /^The budget is locked: call directorate_report now/mu);
  assert.doesNotMatch(out, /directorate_wait again/u);
});

test("only the Liaison runs a review: other agents cannot dispatch its subagents or call its tools, and do not see them", async () => {
  const { hooks } = await harness(repo());

  const decide = async (
    e: PermissionHookEvent
  ): Promise<[string | undefined, string | undefined]> => {
    await present(hooks["permission.evaluate"])(e);

    return [e.effect, e.message];
  };

  await runEach(
    ["directorate_auditor", "directorate_seat", "directorate_compliance"],
    async (target) => {
      const [effect, message] = await decide(
        permissionEvent("build", "subagent", target)
      );

      assert.equal(effect, "deny", `build may not dispatch ${target}`);
      assert.match(present(message), /Dispatch directorate_liaison/u);

      const resultResult = await decide(
        permissionEvent("directorate_liaison", "subagent", target)
      );

      assert.equal(resultResult[0], "allow");
    }
  );

  const resultResult2 = await decide(
    permissionEvent("build", "subagent", "directorate_liaison")
  );

  assert.equal(resultResult2[0], "allow");

  const resultResult3 = await decide(
    permissionEvent("build", "subagent", "explore")
  );

  assert.equal(resultResult3[0], "allow");

  const resultResult4 = await decide(
    permissionEvent("build", "directorate_ledger_list", "*")
  );

  assert.equal(resultResult4[0], "deny");

  const resultResult5 = await decide(
    permissionEvent("build", "directorate_seal", "*")
  );

  assert.equal(resultResult5[0], "deny");

  const resultResult6 = await decide(
    permissionEvent("build", "directorate_configure", "*")
  );

  assert.equal(resultResult6[0], "allow");

  await runEach(
    [
      "directorate_liaison",
      "directorate_auditor",
      "directorate_compliance",
      "directorate_seat",
    ],
    async (agent) => {
      const resultResult7 = await decide(
        permissionEvent(agent, "directorate_ledger_list", "*")
      );

      assert.equal(resultResult7[0], "allow");
    }
  );

  // A request that names no agent is the session's agent's, as the host resolves it; with neither, the rules decide.
  sessionAgents.set("ses_primary", "build");

  const resultResult8 = await decide(
    permissionEvent(undefined, "subagent", "directorate_compliance")
  );

  assert.equal(resultResult8[0], "deny");

  const resultResult9 = await decide(
    permissionEvent(undefined, "directorate_seal", "*")
  );

  assert.equal(resultResult9[0], "deny");
  sessionAgents.set("ses_primary", "directorate_liaison");

  const resultResult10 = await decide(
    permissionEvent(undefined, "subagent", "directorate_compliance")
  );

  assert.equal(resultResult10[0], "allow");
  sessionAgents.delete("ses_primary");

  const resultResult11 = await decide(
    permissionEvent(undefined, "subagent", "directorate_compliance")
  );

  assert.equal(
    resultResult11[0],
    "allow",
    "an unknown caller is left to the agents' rules"
  );

  const [, message] = await decide(
    permissionEvent("build", "subagent", "directorate_compliance")
  );

  assert.match(
    present(message),
    /verbatim.*If you already dispatched one, send the follow-up to that session/u
  );

  const tools: SessionHookEvent["tools"] = {
    directorate_configure: {},
    directorate_ledger_list: {},
    directorate_report: {},
    directorate_seal: {},
    read: {},
    subagent: {},
  };

  // Every request kind gets the same tools, so compaction and generate keep the session's prompt-cache prefix.
  await runEach(
    ["context", "compaction", "generate"] as const,
    async (kind) => {
      const primary: SessionHookEvent = {
        agent: "build",
        sessionID: "ses_primary",
        system: [],
        tools: { ...tools },
      };

      await present(hooks[`session.${kind}`])(primary);
      assert.deepEqual(
        Object.keys(primary.tools).toSorted(),
        ["directorate_configure", "read", "subagent"],
        kind
      );
    }
  );

  const liaison: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: "ses_liaison",
    system: [],
    tools: { ...tools },
  };

  await present(hooks["session.context"])(liaison);
  assert.deepEqual(Object.keys(liaison.tools), Object.keys(tools));

  for (const agent of [
    "directorate_auditor",
    "directorate_seat",
    "directorate_compliance",
  ]) {
    assert.match(
      readFileSync(new URL(`../agents/${agent}.md`, import.meta.url), "utf-8"),
      /^hidden: true$/mu,
      `${agent} is not offered to other agents`
    );
  }
});

test("child events: a failure reported by the subagent tool beats an earlier idle event", async () => {
  const { S, call, launch, bus } = await harness(repo());

  const contentResult40 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult40.content);

  const fin = await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "failed"
  );

  await bus.emit({ data: { sessionID: S("a") }, type: "session.idle" });
  await fin();
  assert.equal(present(sealJson(seal).children[0]).status, "failed");
});

test("parallel launches with the same description link even when the second launch creates and returns first", async () => {
  const { S, call, hooks, bus } = await harness(repo());

  const contentResult41 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult41.content);

  const before = async (id: string) => {
    const event: ToolBeforeEvent = {
      agent: "directorate_liaison",
      id,
      input: {
        agent: "directorate_auditor",
        description: "Check correctness",
        prompt: `question: ${id}`,
      },
      sessionID: S("lead"),
      tool: "subagent",
    };

    await present(hooks["tool.execute.before"])(event);

    return present(event.input?.description);
  };

  const titleA = await before("c1");
  const titleB = await before("c2");
  assert.notEqual(titleA, titleB);

  const create = async (child: string, title: string) => {
    parents.set(S(child), S("lead"));
    await bus.emit({
      data: {
        agent: "directorate_auditor",
        parentID: S("lead"),
        sessionID: S(child),
        title,
      },
      type: "session.created",
    });
  };

  const returned = (id: string, child: string) =>
    present(hooks["tool.execute.after"])({
      id,
      result: {
        metadata: { metadata: { sessionID: S(child), status: "running" } },
      },
      sessionID: S("lead"),
      status: "completed",
      tool: "subagent",
    });

  await create("b", titleB);
  await returned("c2", "b");
  await create("a", titleA);
  assert.deepEqual(
    sealJson(seal).children.map((c) => [c.call, c.session, c.status]),
    [
      ["c1", S("a"), "running"],
      ["c2", S("b"), "running"],
    ]
  );
  // The child finishes before the subagent tool returns; a background "running" result does not undo it.
  await bus.emit({ data: { sessionID: S("a") }, type: "session.idle" });
  await returned("c1", "a");
  await bus.emit({ data: { sessionID: S("b") }, type: "session.idle" });
  assert.deepEqual(
    sealJson(seal).children.map((c) => c.status),
    ["completed", "completed"]
  );
});

test("after a plugin reload, a child's events reach its review through the parent session's record", async () => {
  const dir = repo();
  const h1 = await harness(dir, "kids");

  const contentResult42 = await h1.call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = h1.sealOf(contentResult42.content);

  await h1.launch("c1", "directorate_auditor", "question: q1", "a", "running");
  const h2 = await harness(dir, "kids");
  await h2.bus.emit({
    data: { sessionID: h2.S("a") },
    type: "session.execution.failed",
  });
  assert.equal(present(sealJson(seal).children[0]).status, "failed");
});

test("a child still reports completion after a Liaison takeover and plugin reload", async () => {
  const dir = repo();
  const first = await harness(dir, "takeover");

  const { content } = await first.call("directorate_seal", {
    target: { kind: "local" },
  });

  const seal = sealOf(content);

  const returned = await first.launch(
    "c1",
    "directorate_auditor",
    "question: q1",
    "a",
    "running"
  );

  await returned();
  await first.call(
    "directorate_seal",
    { resume: seal },
    "directorate_liaison",
    "next"
  );
  assert.equal(entries.get(first.S("lead"))?.has("directorate-seal"), false);
  assert.equal(present(sealJson(seal).children[0]).status, "running");
  await Effect.runPromise(Scope.close(first.scope, Exit.void));

  const reloaded = await harness(dir, "takeover");
  await reloaded.bus.emit({
    data: { sessionID: first.S("a") },
    type: "session.execution.succeeded",
  });
  assert.equal(present(sealJson(seal).children[0]).status, "completed");
});

test("a launch the Directive was filed before it linked is stopped when its child appears", async () => {
  const { S, bus, call, hooks, interrupted } = await harness(repo());

  const { content } = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const seal = sealOf(content);

  const event: ToolBeforeEvent = {
    agent: "directorate_liaison",
    id: "late",
    input: { agent: "directorate_auditor", description: "late", prompt: "q" },
    sessionID: S("lead"),
    tool: "subagent",
  };

  await present(hooks["tool.execute.before"])(event);

  // Each gate pushes back once; the Directive is filed with the launch still unlinked.
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Coverage\)/u
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Active Personnel\)/u
  );
  await call("directorate_report", { seal });
  assert.ok(sealJson(seal).reportedAt);
  assert.deepEqual(interrupted, []);
  await bus.emit({
    data: {
      agent: "directorate_auditor",
      parentID: S("lead"),
      sessionID: S("late"),
      title: event.input?.description,
    },
    type: "session.created",
  });
  assert.deepEqual(interrupted, [S("late")]);
});

test("a launch the Directive was filed before it linked is stopped, not adopted, after the Liaison seals a new review", async () => {
  const { S, bus, call, hooks, interrupted } = await harness(repo());

  const { content } = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const seal = sealOf(content);

  const launch = (id: string): ToolBeforeEvent => ({
    agent: "directorate_liaison",
    id,
    input: { agent: "directorate_auditor", description: id, prompt: "q" },
    sessionID: S("lead"),
    tool: "subagent",
  });

  const late = launch("late");
  await present(hooks["tool.execute.before"])(late);
  await present(hooks["tool.execute.before"])(launch("missed"));

  // Each gate pushes back once; the Directive is filed with both launches still unlinked.
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Coverage\)/u
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Active Personnel\)/u
  );
  await call("directorate_report", { seal });

  const replacement = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const next = sealOf(replacement.content);

  await bus.emit({
    data: {
      agent: "directorate_auditor",
      parentID: S("lead"),
      sessionID: S("late"),
      title: late.input?.description,
    },
    type: "session.created",
  });
  // A child whose session.created was missed: only the subagent tool's result names it.
  await present(hooks["tool.execute.after"])({
    id: "missed",
    result: {
      content: `<subagent sessionID="${S("missed")}" state="running">`,
      metadata: { metadata: { sessionID: S("missed"), status: "running" } },
    },
    sessionID: S("lead"),
    status: "completed",
    tool: "subagent",
  });
  assert.deepEqual(interrupted, [S("late"), S("missed")]);
  assert.deepEqual(sealJson(next).children, []);
});

test("a subagent launch rejected before it runs (a drain denial) leaves no failed child", async () => {
  const { S, call, hooks } = await harness(repo());

  const { content } = await call("directorate_seal", {
    budget_minutes: 10,
    target: { kind: "local" },
  });

  const seal = sealOf(content);
  shiftClock(seal, 7);

  // OpenCode runs execute.before, then the subagent tool, which asks permission (and is denied during drain).
  await present(hooks["tool.execute.before"])({
    agent: "directorate_liaison",
    id: "denied",
    input: { agent: "directorate_auditor", description: "late", prompt: "q" },
    sessionID: S("lead"),
    tool: "subagent",
  });
  assert.equal(present(sealJson(seal).children[0]).status, "launching");
  await present(hooks["tool.execute.after"])({
    error: { message: "Subagent denied: directorate_auditor" },
    id: "denied",
    sessionID: S("lead"),
    status: "error",
    tool: "subagent",
  });
  assert.deepEqual(sealJson(seal).children, []);
});

test(
  "the watchdog reads a reported seal once and still files an overdue one",
  { timeout: 10_000 },
  async () => {
    const dir = repo();
    const start = Date.now();

    /** Moves a seal's deadline back to the start; `reopen` drops its report too, as no reported seal could. */
    const overdue = (id: string, reopen = false) => {
      const file = path.join(state, id, "seal.json");
      const s = JSON.parse(readFileSync(file, "utf-8"));

      if (reopen) {
        Reflect.deleteProperty(s, "reportedAt");
      }

      writeFileSync(
        file,
        JSON.stringify({ ...s, deadline: new Date(start).toISOString() })
      );
    };

    await Effect.runPromise(
      Effect.gen(function* watchdogTest() {
        yield* TestClock.setTime(start);
        const run = Effect.runPromiseWith(yield* Effect.context());
        const h = yield* Effect.tryPromise(() => harness(dir, "reread", run));

        // A second apart, so the newest-first sweep meets them in reverse.
        const sealIn = (session: string, minutes: number) =>
          Effect.tryPromise(() =>
            h.call(
              "directorate_seal",
              { budget_minutes: minutes, target: { kind: "local" } },
              "directorate_liaison",
              session
            )
          ).pipe(
            Effect.map((r) => h.sealOf(r.content)),
            Effect.tap(() => TestClock.adjust("1 second"))
          );

        const first = yield* sealIn("first", 2);
        const second = yield* sealIn("second", 60);
        const done = yield* sealIn("lead", 60);

        // Each gate pushes back once.
        for (let i = 0; i < 3; i += 1) {
          yield* Effect.tryPromise(() =>
            h.call("directorate_report", { seal: done })
          ).pipe(Effect.ignore);
        }

        assert.ok(sealJson(done).reportedAt);
        yield* Scope.close(h.scope, Exit.void);
        yield* TestClock.adjust("5 minutes");

        const reloaded = yield* Effect.tryPromise(() =>
          harness(dir, "reread", run)
        );

        // The sweep's file IO runs in real time, which the TestClock does not advance.
        const until = (count: number, tries = 500): Promise<string[]> =>
          reloaded.notices.length >= count || tries === 0
            ? Promise.resolve(reloaded.notices)
            : delay(10).then(() => until(count, tries - 1));

        const notices = (count: number) => Effect.promise(() => until(count));

        yield* TestClock.adjust("30 seconds");
        assert.match(
          (yield* notices(1)).join("\n"),
          new RegExp(`the directive for ${first}`, "u")
        );

        // A sweep that read the reported seal again would now file it, before the second.
        overdue(done, true);
        overdue(second);
        yield* TestClock.adjust("30 seconds");

        const seen = yield* notices(2);
        assert.equal(seen.length, 2);
        assert.match(
          present(seen[1]),
          new RegExp(`the directive for ${second}`, "u")
        );
        assert.equal(sealJson(done).reportedAt, undefined);
        yield* Scope.close(reloaded.scope, Exit.void);
      }).pipe(Effect.provide(TestClock.layer()))
    );
  }
);

test("hooks write the seal only for changes: unrelated subagents and running auditors' tool calls leave it alone", async () => {
  const { S, call, launch, hooks, bus } = await harness(repo());

  const contentResult43 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult43.content);

  const fin = await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "running"
  );

  await fin();
  const inode = () => statSync(path.join(state, seal, "seal.json")).ino;
  const before = inode();
  await bus.emit({ data: { sessionID: S("lead") }, type: "session.idle" });
  await present(hooks["tool.execute.before"])({
    agent: "directorate_liaison",
    id: "e1",
    input: { agent: "explore", prompt: "look around" },
    sessionID: S("lead"),
    tool: "subagent",
  });
  await present(hooks["tool.execute.after"])({
    id: "e1",
    result: {
      content: `<subagent sessionID="${S("x")}" state="completed">`,
      metadata: { metadata: { sessionID: S("x"), status: "completed" } },
    },
    sessionID: S("lead"),
    status: "completed",
    tool: "subagent",
  });
  await present(hooks["tool.execute.before"])({
    agent: "directorate_auditor",
    id: "r1",
    input: {},
    messageID: "m",
    sessionID: S("a"),
    tool: "directorate_read",
  });
  assert.equal(inode(), before, "seal.json was not rewritten");
  assert.deepEqual(
    sealJson(seal).children.map((c) => c.call),
    ["c1"]
  );
});

test("one review per session; abandon saves and notifies; resume checks the session's own review and extends a spent budget", async () => {
  const { call, notices } = await harness(repo());

  const contentResult44 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const first = sealOf(contentResult44.content);

  await assert.rejects(
    call("directorate_seal", { mode: "default", target: { kind: "local" } }),
    /already holds an active containment seal/u
  );

  const contentResult45 = await call("directorate_seal", {
    abandon: true,
    mode: "default",
    target: { kind: "local" },
  });

  const second = sealOf(contentResult45.content);

  assert.ok(
    sealJson(first).reportedAt &&
      sealJson(first).autoReported &&
      sealJson(first).abandoned
  );
  const [notice] = notices;
  assert.ok(notice);
  assert.match(notice, /abandoned for a new review/u);
  assert.doesNotMatch(notice, /time budget ran out/u);

  const contentResult46 = await call(
    "directorate_seal",
    { mode: "default", target: { kind: "local" } },
    "directorate_liaison",
    "lead2"
  );

  const third = sealOf(contentResult46.content);

  await assert.rejects(
    call(
      "directorate_seal",
      { resume: second },
      "directorate_liaison",
      "lead2"
    ),
    new RegExp(`already holds an active containment seal ${third}`, "u")
  );
  assert.ok(second);
  shiftClock(second, 19, 20);
  const before = sealJson(second);
  await call("directorate_seal", { resume: second });
  const afterResume = sealJson(second);
  assert.deepEqual(afterResume.createdAt, before.createdAt);
  assert.deepEqual(afterResume.deadline, before.deadline);
  shiftClock(second, 30, 20);

  const contentResult47 = await call(
    "directorate_seal",
    { resume: second },
    "directorate_liaison",
    "lead3"
  );

  const resumed = contentResult47.content;

  assert.match(resumed, /Resumed containment `directorate-/u);
  const s = sealJson(second);
  assert.equal(s.ownerSession.startsWith("ses_lead3"), true);
  assert.ok(
    DateTime.toEpochMillis(s.deadline) > Date.now() + 4 * 60_000,
    "a spent budget gets more time on resume"
  );
  await assert.rejects(
    call("directorate_report", { seal: second }),
    /Only the session that sealed/u
  );
});

test("simultaneous starts in one session seal one review; abandon keeps the active review when the new target fails", async () => {
  const { call } = await harness(repo());

  const start = () =>
    call(
      "directorate_seal",
      { target: { kind: "local" } },
      "directorate_liaison",
      "racer"
    );

  const results = await Promise.allSettled([start(), start()]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  const winner = present(sealOf(present(won[0]).value.content));
  assert.match(
    String(lost[0]?.reason),
    new RegExp(`already holds an active containment seal ${winner}`, "u")
  );

  const open = readdirSync(state)
    .filter((id) => /^directorate-\d{14}-[0-9a-f]{6}$/u.test(id))
    .map(sealJson)
    .filter((s) => !s.reportedAt && s.ownerSession.startsWith("ses_racer"));

  assert.deepEqual(
    open.map((s) => s.id),
    [winner]
  );

  // The new target is resolved before abandon files the active review.
  await assert.rejects(
    call(
      "directorate_seal",
      { abandon: true, target: { base: "no-such-ref", kind: "range" } },
      "directorate_liaison",
      "racer"
    ),
    /no-such-ref/u
  );
  assert.equal(sealJson(winner).reportedAt, undefined);
});

test("freshness: gate, refresh, reopened entries need re-anchoring, a second edit is stale", async () => {
  const dir = repo();
  const { call } = await harness(dir);

  const contentResult48 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult48.content);

  await call("directorate_diff", { seal });
  await call(
    "directorate_ledger_add",
    add(seal, { severity: "minor" }),
    "directorate_auditor",
    "scout"
  );
  await call("directorate_ledger_verdict", {
    evidence: ["src/a.ts:2"],
    id: "F1",
    rationale: "r",
    seal,
    verdict: "confirmed",
  });
  writeFileSync(
    path.join(dir, "src/a.ts"),
    "export const a = 2\n// guard added\nexport const div = (x: number, y: number) => (y ? x / y : 0)\n"
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Containment Drift\)/u
  );
  const contentResult49 = await call("directorate_refresh", { seal });
  const r = contentResult49.content;
  assert.match(r, /Changed: src\/a.ts/u);
  assert.match(r, /Reopened for re-verification: F1/u);
  await assert.rejects(
    call(
      "directorate_ledger_verdict",
      {
        evidence: ["src/a.ts:3"],
        id: "F1",
        rationale: "r",
        seal,
        verdict: "confirmed",
      },
      "directorate_compliance",
      "ref"
    ),
    /anchor does not match/u
  );
  await call(
    "directorate_ledger_verdict",
    {
      evidence: ["src/a.ts:3"],
      id: "F1",
      rationale: "guarded now",
      seal,
      verdict: "refuted",
    },
    "directorate_compliance",
    "ref"
  );
  await call("directorate_diff", { seal });
  writeFileSync(path.join(dir, "src/b.ts"), "export const b = 3\n");
  const contentResult50 = await call("directorate_report", { seal });
  const md = contentResult50.content;
  assert.match(md, /status: \*\*stale\*\*/u);
  assert.match(
    md,
    /Containment drift \(changed after sealing and not re-verified\): `src\/b.ts`/u
  );
  assert.doesNotMatch(md, /### Verified Findings/u);
});

test("coverage: 'reviewed' needs a real reader; auditors keep their own read offsets", async () => {
  const dir = repo();
  writeFileSync(
    path.join(dir, "src/wide.ts"),
    `${Array.from(
      { length: 300 },
      (_, i) => `export const v${i} = "${"x".repeat(400)}"`
    ).join("\n")}\n`
  );
  const { call } = await harness(dir);

  const contentResult51 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult51.content);

  const wide = present(
    sealJson(seal).regions.find((r) => r.file === "src/wide.ts")
  ).id;

  const contentResult52 = await call(
    "directorate_diff",
    { regions: [wide], seal },
    "directorate_auditor",
    "scoutA"
  );

  const a1 = contentResult52.content;

  assert.match(a1, /\(partial; call again\)/u);

  const contentResult53 = await call(
    "directorate_diff",
    { regions: [wide], seal },
    "directorate_auditor",
    "scoutB"
  );

  const b1 = contentResult53.content;

  assert.doesNotMatch(
    b1,
    /continued from body line/u,
    "auditor B starts at the top, not where auditor A stopped"
  );

  const contentResult54 = await call(
    "directorate_diff",
    { regions: [wide], seal },
    "directorate_auditor",
    "scoutA"
  );

  const a2 = contentResult54.content;

  assert.match(a2, /continued from body line/u);

  const contentResult55 = await call("directorate_coverage", {
    disposition: "reviewed",
    note: "looked fine",
    regions: ["R1"],
    seal,
  });

  const out = contentResult55.content;

  assert.match(out, /R1 recorded as skimmed/u);
});

test("budget: drain denies auditors not compliance; lock strips tools; role-specific budget text; release after report", async () => {
  const { S, call, hooks } = await harness(repo());

  const contentResult56 = await call("directorate_seal", {
    budget_minutes: 10,
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult56.content);

  const ev = (agent: string): PermissionHookEvent => ({
    action: "subagent",
    effect: "allow",
    resources: [agent],
    sessionID: S("lead"),
  });

  shiftClock(seal, 7);
  const e1 = ev("directorate_auditor");
  await present(hooks["permission.evaluate"])(e1);
  assert.equal(e1.effect, "deny");
  assert.match(present(e1.message), /Directorate evacuation \(drain\)/u);
  const e2 = ev("directorate_compliance");
  await present(hooks["permission.evaluate"])(e2);
  assert.equal(e2.effect, "allow");
  await call(
    "directorate_ledger_add",
    add(seal),
    "directorate_auditor",
    "scout"
  );

  const contentResult57 = await call(
    "directorate_note",
    { kind: "limit", seal, text: "stopped at drain" },
    "directorate_auditor",
    "scout"
  );

  const scoutOut = contentResult57.content;

  assert.match(
    scoutOut,
    /min left.*file surviving candidates now and hand off/u
  );

  // Drain keeps event.system unchanged so the KV-cache prefix holds across normal → drain (tool results carry EVACUATION).
  const drainAt7: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: {},
  };

  await present(hooks["session.context"])(drainAt7);
  shiftClock(seal, 8);

  const drainAt8: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: {},
  };

  await present(hooks["session.context"])(drainAt8);
  assert.deepEqual(
    drainAt7.system,
    drainAt8.system,
    "drain system prompt stays unchanged between turns"
  );
  assert.doesNotMatch(
    drainAt7.system.map((s) => s.text).join("\n"),
    /DIRECTORATE \/\/ EVACUATION|min left/u
  );
  shiftClock(seal, 11);

  const lockCtx: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: {
      directorate_note: {},
      directorate_report: {},
      directorate_seal: {},
      read: {},
      subagent: {},
    },
  };

  await present(hooks["session.context"])(lockCtx);
  assert.match(lockCtx.system.at(-1)?.text ?? "", /DIRECTORATE \/\/ LOCKDOWN/u);
  assert.deepEqual(Object.keys(lockCtx.tools).toSorted(), [
    "directorate_note",
    "directorate_report",
  ]);
  const contentResult58 = await call("directorate_report", { seal });
  const md = contentResult58.content;
  assert.match(md, /time budget ran out/u);

  const afterReport: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: { read: {}, subagent: {} },
  };

  await present(hooks["session.context"])(afterReport);
  assert.deepEqual(Object.keys(afterReport.tools).toSorted(), [
    "read",
    "subagent",
  ]);
  const e3 = ev("directorate_auditor");
  await present(hooks["permission.evaluate"])(e3);
  assert.equal(e3.effect, "allow");
});

test("a refresh from a model step that began before lockdown does not run after it", async () => {
  const dir = repo();
  const { S, call, hooks } = await harness(dir);

  const { content } = await call("directorate_seal", {
    budget_minutes: 10,
    target: { kind: "local" },
  });

  const seal = sealOf(content);
  shiftClock(seal, 7);

  const drain: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: { directorate_refresh: {}, directorate_report: {} },
  };

  await present(hooks["session.context"])(drain);
  assert.ok("directorate_refresh" in drain.tools, "offered during drain");

  // The step's call runs against that request's tools, after the budget locked.
  writeFileSync(path.join(dir, "src/b.ts"), "export const b = 3\n");
  shiftClock(seal, 11);
  await assert.rejects(
    call("directorate_refresh", { seal }),
    /Directorate lockdown: .* directorate_refresh no longer runs\. Call directorate_report now/u
  );
  assert.equal(sealJson(seal).gen, 0);
  assert.equal(sealJson(seal).refreshes, 0);
});

test("a diff read from a model step that began before lockdown records no coverage after it", async () => {
  const { S, call, hooks } = await harness(repo());

  const { content } = await call("directorate_seal", {
    budget_minutes: 10,
    target: { kind: "local" },
  });

  const seal = sealOf(content);
  shiftClock(seal, 7);

  const drain: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: { directorate_diff: {}, directorate_report: {} },
  };

  await present(hooks["session.context"])(drain);
  assert.ok("directorate_diff" in drain.tools, "offered during drain");

  // The steps' calls run against those requests' tools, after the budget locked.
  shiftClock(seal, 11);
  await assert.rejects(
    call("directorate_diff", { seal }),
    /Directorate lockdown: .* directorate_diff no longer runs\. Call directorate_report now/u
  );
  await assert.rejects(
    call("directorate_diff", { seal }, "directorate_auditor", "scout"),
    /Directorate lockdown: .* directorate_diff no longer runs\. Hand off what you hold now/u
  );
  assert.ok(
    sealJson(seal).regions.every((r) => !r.ownerRead && !r.readBy.length),
    "no read receipts after lockdown"
  );

  const report = await call("directorate_report", { seal });
  assert.match(report.content, /status: \*\*partial\*\*/u);

  // A reported seal stays readable.
  const reread = await call("directorate_diff", { seal });
  assert.match(reread.content, /\[coverage 0\//u);
});

test("the report gate does not ask for Seat dispatches during drain", async () => {
  const { call } = await harness(repo());

  const { content } = await call("directorate_seal", {
    budget_minutes: 10,
    panel_models: ["prov/alpha"],
    target: { kind: "local" },
  });

  const seal = sealOf(content);
  await call("directorate_diff", { seal });
  shiftClock(seal, 7);
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Seats\).*Seats can no longer be launched or continued during drain/u
  );
  const report = await call("directorate_report", { seal });
  assert.match(report.content, /status: \*\*partial\*\*/u);
});

test("ledger listing is repository-local, including outside Git", async () => {
  const first = await harness(repo());
  const second = await harness(repo());

  const makeSeal = async (h: typeof first) => {
    const { content } = await h.call("directorate_seal", {
      target: { kind: "local" },
    });

    return sealOf(content);
  };

  const own = await makeSeal(first);
  const other = await makeSeal(second);
  const { content } = await first.call("directorate_ledger_list", {});
  assert.ok(content.includes(own));
  assert.ok(!content.includes(other));

  const dir = mkdtempSync(path.join(tmpdir(), "directorate-no-repo-"));
  dirs.push(dir);
  const outside = await harness(dir);
  const empty = await outside.call("directorate_ledger_list", {});
  assert.equal(
    empty.content,
    "No Directorate seals found for this repository."
  );
});

test("ledger listing names the most recently reported seal, however many newer seals are unreported", async () => {
  const h = await harness(repo());

  const { content } = await h.call("directorate_seal", {
    target: { kind: "local" },
  });

  const base = JSON.parse(
    readFileSync(path.join(state, h.sealOf(content), "seal.json"), "utf-8")
  );

  const put = (id: string, reportedAt?: string) => {
    mkdirSync(path.join(state, id));
    writeFileSync(
      path.join(state, id, "seal.json"),
      JSON.stringify({ ...base, id, reportedAt })
    );
  };

  // Reported in the reverse of their creation order, then buried under newer unreported seals.
  const later = "directorate-20250101000000-a00001";
  put(later, "2025-03-02T00:00:00.000Z");
  put("directorate-20250102000000-a00002", "2025-03-01T00:00:00.000Z");

  for (let i = 0; i < 10; i += 1) {
    put(`directorate-2099010100000${i}-b0000${i}`);
  }

  const listed = await h.call("directorate_ledger_list", {});
  assert.match(
    listed.content,
    new RegExp(
      `^Latest reported seal \\(re-check this one\\): \`${later}\``,
      "u"
    )
  );
});

test("after a plugin reload, the session's unreported seal is found even after an abandon; strangers are not bound", async () => {
  const dir = repo();
  const h1 = await harness(dir, "reload");
  await h1.call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const contentResult59 = await h1.call("directorate_seal", {
    abandon: true,
    budget_minutes: 10,
    mode: "default",
    target: { kind: "local" },
  });

  const live = h1.sealOf(contentResult59.content);

  shiftClock(live, 11);
  const h2 = await harness(dir, "reload");

  const mine: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: h2.S("lead"),
    system: [],
    tools: { directorate_report: {}, read: {} },
  };

  await present(h2.hooks["session.context"])(mine);
  assert.deepEqual(
    Object.keys(mine.tools),
    ["directorate_report"],
    "locked after reload"
  );

  const stranger: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: "someone-else",
    system: [],
    tools: { read: {} },
  };

  await present(h2.hooks["session.context"])(stranger);
  assert.deepEqual(Object.keys(stranger.tools), ["read"]);
});

test(
  "the scoped watchdog recovers an overdue seal after a three-day shutdown",
  { timeout: 10_000 },
  async () => {
    const dir = repo();
    const start = Date.now();
    await Effect.runPromise(
      Effect.gen(function* watchdogTest() {
        yield* TestClock.setTime(start);
        const run = Effect.runPromiseWith(yield* Effect.context());
        const h = yield* Effect.tryPromise(() => harness(dir, undefined, run));

        const result = yield* Effect.tryPromise(() =>
          h.call("directorate_seal", {
            budget_minutes: 2,
            mode: "default",
            target: { kind: "local" },
          })
        );

        const seal = h.sealOf(result.content);
        assert.equal(
          DateTime.toEpochMillis(sealJson(seal).deadline),
          start + 120_000
        );
        yield* Scope.close(h.scope, Exit.void);
        yield* TestClock.adjust("3 days");
        assert.equal(sealJson(seal).reportedAt, undefined);

        const reloaded = yield* Effect.tryPromise(() =>
          harness(dir, undefined, run)
        );

        yield* TestClock.adjust("30 seconds");
        assert.match(
          yield* Deferred.await(reloaded.notified),
          /<intervened\/filed> the directive.*did not report before lockdown/u
        );
        assert.deepEqual(
          h.notices,
          [],
          "the closed plugin did not run the watchdog"
        );
        assert.equal(sealJson(seal).autoReported, true);
        assert.ok(
          DateTime.toEpochMillis(present(sealJson(seal).reportedAt)) >=
            start + 240_000
        );
        assert.match(
          readFileSync(path.join(state, seal, "report.md"), "utf-8"),
          /status: \*\*partial\*\*/u
        );
        yield* Scope.close(reloaded.scope, Exit.void);
      }).pipe(Effect.provide(TestClock.layer()))
    );
  }
);

test(
  "the watchdog of the instance that sealed another repository recovers its overdue review after a reload",
  { timeout: 10_000 },
  async () => {
    const here = repo();
    const there = repo();
    const start = Date.now();
    await Effect.runPromise(
      Effect.gen(function* watchdogTest() {
        yield* TestClock.setTime(start);
        const run = Effect.runPromiseWith(yield* Effect.context());
        const h = yield* Effect.tryPromise(() => harness(here, "xrepo", run));

        const result = yield* Effect.tryPromise(() =>
          h.call("directorate_seal", {
            budget_minutes: 2,
            repo: there,
            target: { kind: "local" },
          })
        );

        const seal = h.sealOf(result.content);
        assert.equal(sealJson(seal).host, here);
        yield* Scope.close(h.scope, Exit.void);
        yield* TestClock.adjust("1 hour");

        const reloaded = yield* Effect.tryPromise(() =>
          harness(here, "xrepo", run)
        );

        yield* TestClock.adjust("30 seconds");
        assert.match(
          yield* Deferred.await(reloaded.notified),
          new RegExp(`<intervened/filed> the directive for ${seal}`, "u")
        );
        assert.equal(sealJson(seal).autoReported, true);
        assert.match(
          readFileSync(path.join(state, seal, "report.md"), "utf-8"),
          /status: \*\*partial\*\*/u
        );
        yield* Scope.close(reloaded.scope, Exit.void);
      }).pipe(Effect.provide(TestClock.layer()))
    );
  }
);

test("directorate_read, directorate_grep, directorate_ls, directorate_history read the seal, not later edits", async () => {
  const dir = repo();
  const { call } = await harness(dir);

  const contentResult60 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult60.content);

  await assert.rejects(
    call("directorate_ls", { dir: "../outside", seal }),
    /must be relative to the repository/u
  );
  writeFileSync(path.join(dir, "src/a.ts"), "rewritten\n");

  const contentResult61 = await call(
    "directorate_read",
    { path: "src/a.ts", seal },
    "directorate_auditor",
    "scout"
  );

  const r = contentResult61.content;

  assert.match(r, /sealed post-image/u);
  assert.match(r, /2 export const div/u);

  const contentResult62 = await call(
    "directorate_read",
    { path: "src/a.ts", seal, side: "old" },
    "directorate_auditor",
    "scout"
  );

  assert.match(contentResult62.content, /1 export const a = 1/u);

  const contentResult63 = await call(
    "directorate_grep",
    { fixed: true, pattern: "export const b", seal },
    "directorate_auditor",
    "scout"
  );

  assert.match(contentResult63.content, /src\/b.ts:1:export const b = 2/u);

  const contentResult64 = await call(
    "directorate_ls",
    { seal },
    "directorate_auditor",
    "scout"
  );

  assert.match(
    contentResult64.content,
    /2 files at the seal\nsrc\/a.ts\nsrc\/b.ts/u
  );

  const contentResult65 = await call(
    "directorate_history",
    { kind: "log", seal },
    "directorate_auditor",
    "scout"
  );

  assert.match(contentResult65.content, /init/u);
});

test("old-format seals in the store and hook faults never break a session", async () => {
  const old = path.join(state, "directorate-20200101000000-abcdef");
  mkdirSync(old, { recursive: true });
  writeFileSync(
    path.join(old, "seal.json"),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      deadline: new Date().toISOString(),
      id: "directorate-20200101000000-abcdef",
      mode: "default",
      repo: "/x",
      target: { kind: "local" },
    })
  );
  const broken = path.join(state, "directorate-20200101000001-abcdef");
  mkdirSync(broken, { recursive: true });
  writeFileSync(path.join(broken, "seal.json"), "{not json");
  const { S, call, hooks } = await harness(repo());

  const ev: SessionHookEvent = {
    agent: "directorate_liaison",
    sessionID: S("fresh"),
    system: [],
    tools: { read: {} },
  };

  await present(hooks["session.context"])(ev);
  assert.deepEqual(Object.keys(ev.tools), ["read"]);

  const contentResult66 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult66.content);

  assert.ok(seal);
  await present(hooks["tool.execute.before"])({
    agent: "directorate_liaison",
    id: "x",
    input: null,
    sessionID: S("lead"),
    tool: "subagent",
  });
  await present(hooks["permission.evaluate"])({
    action: "subagent",
    resources: null,
    sessionID: S("lead"),
  });
});

test("directorate_read and directorate_history ask permission for the file too, so a deny rule withholds it", async () => {
  const { call, requests } = await harness(repo(), undefined, undefined, (r) =>
    r.resources.includes("src/b.ts")
  );

  const contentResult67 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult67.content);

  const contentResult68 = await call("directorate_read", {
    path: "./src/a.ts",
    seal,
  });

  assert.match(contentResult68.content, /export const a = 2/u);
  assert.deepEqual(
    requests.at(-1),
    { action: "directorate_read", resources: [seal, "src/a.ts"] },
    "the decoded path, beside the seal"
  );
  await assert.rejects(
    call("directorate_read", { path: "src/b.ts", seal }),
    /directorate_read denied/u
  );
  await assert.rejects(
    call("directorate_history", { kind: "log", path: "src/b.ts", seal }),
    /directorate_history denied/u
  );
});

test("directorate_diff stays inside OpenCode's output cut (50 KiB, 2,000 lines), so every region counted read was shown", async () => {
  const dir = repo();
  writeFileSync(
    path.join(dir, "src/wide.ts"),
    `${Array.from(
      { length: 1500 },
      (_, i) => `export const v${i} = "${"€".repeat(200)}"`
    ).join("\n")}\n`
  );
  writeFileSync(path.join(dir, "src/tall.ts"), "\n".repeat(3000));
  const { call } = await harness(dir);

  const contentResult69 = await call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });

  const seal = sealOf(contentResult69.content);

  let calls = 0;

  const readUntilDone = async (): Promise<void> => {
    if (calls >= 200) {
      return;
    }

    const contentResult70 = await call("directorate_diff", { seal });
    const out = contentResult70.content;
    assert.ok(
      Buffer.byteLength(out) <= 50 * 1024 && out.split("\n").length <= 2000,
      `call ${calls}: ${Buffer.byteLength(out)} bytes, ${out.split("\n").length} lines`
    );
    calls += 1;

    if (!/All regions have been read/u.test(out)) {
      await readUntilDone();
    }
  };

  await readUntilDone();

  const s = sealJson(seal);
  assert.equal(s.regions.filter((r) => r.ownerRead).length, s.regions.length);
  assert.ok(calls > 10, `paged in ${calls} calls`);
});

test("re-check: the same Liaison session re-seals a reported review, Compliance resolves the fixed finding, and the Directive compares", async () => {
  const dir = repo();
  const { call } = await harness(dir);

  const contentResult71 = await call("directorate_seal", {
    target: { kind: "local" },
  });

  const first = present(sealOf(contentResult71.content));

  await call("directorate_diff", { seal: first });
  await call(
    "directorate_ledger_add",
    add(first),
    "directorate_auditor",
    "scout"
  );
  await call(
    "directorate_ledger_verdict",
    {
      evidence: ["src/a.ts:2"],
      id: "F1",
      rationale: "r",
      seal: first,
      verdict: "confirmed",
    },
    "directorate_compliance",
    "ref"
  );
  const contentResult72 = await call("directorate_report", { seal: first });
  const before = contentResult72.content;
  assert.match(before, /Division by zero/u);

  writeFileSync(
    path.join(dir, "src/a.ts"),
    "export const a = 2\nexport const div = (x: number, y: number) => (y ? x / y : 0)\n"
  );
  await assert.rejects(
    call("directorate_seal", { mode: "full", recheck: first }),
    /reuses the earlier review's target and mode/u
  );
  await assert.rejects(
    call("directorate_seal", { resume: first }),
    /pass recheck: "directorate-/u
  );
  const contentResult73 = await call("directorate_seal", { recheck: first });
  const sealed = contentResult73.content;
  assert.match(
    sealed,
    new RegExp(
      `Containment sealed \`directorate-[^\`]+\`, a re-check of \`${first}\``,
      "u"
    )
  );
  assert.match(sealed, /Changed since the earlier review: src\/a\.ts/u);
  assert.match(
    sealed,
    /Reopened for re-decision[^\n]*\n- F1 \(important, F1 in the earlier review\) Division by zero/u
  );
  const seal = present(sealOf(sealed));
  assert.notEqual(seal, first);
  assert.equal(sealJson(seal).recheckOf, first);

  const contentResult74 = await call("directorate_ledger_list", {
    brief: true,
    seal,
  });

  assert.match(
    contentResult74.content,
    new RegExp(`F1 \\[open\\].* · carried: confirmed as F1 in ${first}`, "u")
  );
  assert.ok(
    sealJson(seal).regions.some((r) => r.file === "src/b.ts" && r.ownerRead),
    "src/b.ts did not change, so it is not read again"
  );

  await assert.rejects(
    call("directorate_ledger_verdict", {
      evidence: ["src/a.ts:2"],
      id: "F1",
      rationale: "guarded",
      seal,
      verdict: "resolved",
    }),
    /route it to directorate_compliance/u
  );
  await call("directorate_diff", { seal });
  await call(
    "directorate_ledger_verdict",
    {
      evidence: ["src/a.ts:2"],
      id: "F1",
      rationale: "y is checked before dividing",
      seal,
      verdict: "resolved",
    },
    "directorate_compliance",
    "ref2"
  );
  const contentResult75 = await call("directorate_report", { seal });
  const md = contentResult75.content;
  assert.match(
    md,
    /<Approved\/Tolerated> — Prior Findings Resolved\*\* · status: \*\*complete\*\*/u
  );
  assert.match(md, new RegExp(`re-check of \`${first}\``, "u"));
  assert.match(
    md,
    /### Resolved Since `directorate-[^`]+`\n- Division by zero — was `src\/a\.ts:2` \(important, F1\); resolved by/u
  );
  const contentResult76 = await call("directorate_report", { seal: first });
  assert.equal(
    contentResult76.content,
    before,
    "the earlier Directive is unchanged"
  );

  // A bad re-check target fails before abandon files the session's active review.
  const contentResult77 = await call(
    "directorate_seal",
    { target: { kind: "local" } },
    "directorate_liaison",
    "lead9"
  );

  const active = present(sealOf(contentResult77.content));

  await assert.rejects(
    call(
      "directorate_seal",
      { abandon: true, recheck: active },
      "directorate_liaison",
      "lead9"
    ),
    /has not been reported/u
  );
  assert.equal(sealJson(active).reportedAt, undefined);
});
