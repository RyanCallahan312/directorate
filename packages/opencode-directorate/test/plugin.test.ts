import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

import { Session } from "@opencode/schema/session";
import {
  Cause,
  ConfigProvider,
  Data,
  Deferred,
  Effect,
  Exit,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

const state = mkdtempSync(join(tmpdir(), "directorate-state-"));
// A global file inside a project's .opencode (as with OPENCODE_CONFIG_DIR=~/.opencode): <state>/home has no project file.
const home = join(state, "home");
const globalSettings = join(home, ".opencode", "directorate.json");
const stateConfig = ConfigProvider.layer(
  ConfigProvider.fromEnvRecord({
    DIRECTORATE_STATE_DIR: state,
    DIRECTORATE_SETTINGS: globalSettings,
  })
);
const plugin = (await import("../src/index.ts")).default;

type HostContext = Parameters<typeof plugin.effect>[0];

type CommandEditor = Parameters<
  Parameters<HostContext["command"]["transform"]>[0]
>[0];

type CommandDefinition = Parameters<CommandEditor["add"]>[0];

type SubmittedPrompt = Parameters<HostContext["session"]["prompt"]>[0];

const tuiPlugin = (await import("../src/tui.ts")).default;
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
afterEach(() => rmSync(home, { recursive: true, force: true }));
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "directorate-repo-"));
  dirs.push(dir);
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1\n");
  writeFileSync(join(dir, "src/b.ts"), "export const b = 1\n");
  g("add", ".");
  g("commit", "-qm", "init");
  writeFileSync(
    join(dir, "src/a.ts"),
    "export const a = 2\nexport const div = (x: number, y: number) => x / y\n"
  );
  writeFileSync(join(dir, "src/b.ts"), "export const b = 2\n");
  return dir;
}

/** Serves one event per pull, so the plugin asking for the next event means it finished the previous one. */
function eventBus() {
  const queue = Effect.runSync(
    Queue.unbounded<{ event: unknown; handled: Deferred.Deferred<void> }>()
  );
  let current: Deferred.Deferred<void> | undefined;
  return {
    /** Resolves once the plugin has handled the event. */
    emit: (event: unknown) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const handled = yield* Deferred.make<void>();
          yield* Queue.offer(queue, { event, handled });
          yield* Deferred.await(handled);
        })
      ),
    subscribe: () =>
      Stream.fromEffectRepeat(
        Effect.gen(function* () {
          if (current) yield* Deferred.succeed(current, undefined);
          const next = yield* Queue.take(queue);
          current = next.handled;
          return next.event;
        })
      ),
  };
}
let uid = 0;
/** A permission rule's denial, as the host reports it. */
class Denied extends Data.TaggedError("Denied")<{ message: string }> {}
/** Host state that outlives a plugin reload: instruction entries per session, and each child session's parent. */
const entries = new Map<string, Map<string, unknown>>();
const parents = new Map<string, string>();
/** Each session's agent, which the host records when the session is created. */
const sessionAgents = new Map<string, string>();

/** One plugin instance. Session ids are unique per harness (real ones are), unless `ids` shares them across a reload. */
async function harness(
  dir: string,
  ids?: string,
  run = Effect.runPromise,
  deny: (request: { action: string; resources: string[] }) => boolean = () =>
    false
) {
  const tag = ids ?? `h${++uid}`;
  const S = (name: string) => `ses_${name}-${tag}`;
  const tools = new Map<string, any>();
  const hooks: Record<string, any> = {};
  const asserted: string[] = [];
  const requests: { action: string; resources: string[] }[] = [];
  const interrupted: string[] = [];
  const notices: string[] = [];
  const notified = Deferred.makeUnsafe<string>();
  const rpcs = new Map<string, any>();
  const commands = new Map<string, CommandDefinition>();
  const prompts: SubmittedPrompt[] = [];
  const bus = eventBus();

  const ctx = {
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
    location: { directory: dir },
    rpc: {
      register: (def: any, handlers: any) =>
        Effect.sync(() => {
          rpcs.set(def.id, handlers);
          return { events: { emit: () => Effect.void } };
        }),
    },
    model: {
      list: () =>
        Effect.succeed({
          data: [
            {
              providerID: "prov",
              id: "alpha",
              name: "Alpha",
              enabled: true,
              variants: [{ id: "high" }, { id: "xhigh" }],
            },
            {
              providerID: "prov",
              id: "beta",
              name: "Beta",
              enabled: true,
              variants: [],
            },
            {
              providerID: "prov",
              id: "off",
              name: "Off",
              enabled: false,
              variants: [],
            },
          ],
        }),
    },
    tool: {
      transform: (fn: any) =>
        Effect.sync(() => fn({ add: (t: any) => tools.set(t.name, t) })),
      hook: (n: string, cb: any) =>
        Effect.sync(() => {
          hooks[`tool.${n}`] = (event: any) => run(cb(event));
        }),
    },
    session: {
      hook: (n: string, cb: any) =>
        Effect.sync(() => {
          hooks[`session.${n}`] = (event: any) => run(cb(event));
        }),
      get: ({ sessionID }: any) =>
        Effect.succeed({
          location: { directory: dir },
          parentID: parents.get(sessionID),
          agent: sessionAgents.get(sessionID),
        }),
      prompt: (input: SubmittedPrompt) =>
        Effect.sync(() => {
          prompts.push(input);
        }),
      interrupt: ({ sessionID }: any) =>
        Effect.sync(() => void interrupted.push(sessionID)),
      synthetic: ({ text }: { text: string }) =>
        Effect.sync(() => {
          notices.push(text);
        }).pipe(
          Effect.andThen(Deferred.succeed(notified, text)),
          Effect.asVoid
        ),
      instructions: {
        entry: {
          put: ({ sessionID, key, value }: any) =>
            Effect.sync(
              () =>
                void (
                  entries.get(sessionID) ??
                  entries.set(sessionID, new Map()).get(sessionID)!
                ).set(key, value)
            ),
          remove: ({ sessionID, key }: any) =>
            Effect.sync(() => void entries.get(sessionID)?.delete(key)),
          list: ({ sessionID }: any) =>
            Effect.sync(() =>
              [...(entries.get(sessionID) ?? [])].map(([key, value]) => ({
                key,
                value,
              }))
            ),
        },
      },
    },
    event: { subscribe: bus.subscribe },
    permission: {
      hook: (n: string, cb: any) =>
        Effect.sync(() => {
          hooks[`permission.${n}`] = (event: any) => run(cb(event));
        }),
      assert: (a: any) => {
        asserted.push(`${a.agent}:${a.action}`);
        requests.push({ action: a.action, resources: a.resources });
        return deny(a)
          ? Effect.fail(
              new Denied({ message: `${a.action} denied by a permission rule` })
            )
          : Effect.void;
      },
    },
  };
  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  await run(
    plugin
      .effect(ctx as unknown as Parameters<typeof plugin.effect>[0])
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(stateConfig)
      )
  );
  const call = (
    name: string,
    input: any,
    agent = "directorate_liaison",
    session = "lead"
  ) => {
    const tool = tools.get(name);
    return run(
      Schema.decodeUnknownEffect(tool.input as Schema.Codec<unknown, unknown>)(
        input
      ).pipe(
        Effect.flatMap(
          (decoded) =>
            tool.execute(decoded, {
              agent,
              sessionID: S(session),
              messageID: "m",
              id: "c",
            }) as Effect.Effect<{ content: string }, Error>
        )
      )
    );
  };
  const sealOf = (out: string) =>
    /(?:Containment sealed|Resumed containment) `(directorate-[^`]+)`/.exec(
      out
    )![1];
  /** As the subagent tool does: the before-hook, then the child session's creation (titled by the description); returns the after-hook. */
  const launch = async (
    callId: string,
    agent: string,
    prompt: string,
    child: string,
    st: "running" | "completed" | "failed",
    description?: string
  ) => {
    await hooks["tool.execute.before"]({
      tool: "subagent",
      sessionID: S("lead"),
      agent: "directorate_liaison",
      id: callId,
      input: { agent, prompt, description },
    });
    parents.set(S(child), S("lead"));
    await bus.emit({
      type: "session.created",
      data: {
        sessionID: S(child),
        parentID: S("lead"),
        agent,
        title: description,
      },
    });
    return () =>
      hooks["tool.execute.after"]({
        tool: "subagent",
        sessionID: S("lead"),
        id: callId,
        status: "completed",
        result: {
          content: `<subagent sessionID="${S(child)}" state="${st}">`,
          metadata: { metadata: { sessionID: S(child), status: st } },
        },
      });
  };
  /** As the TUI's promise client: input decoded by the method's schema, JSON back, a failure thrown as { type, message }. */
  const client = {
    rpc: (def: any) =>
      Object.fromEntries(
        Object.keys(def.methods).map((name) => [
          name,
          async (input: unknown) => {
            const exit = await Effect.runPromiseExit(
              Schema.decodeUnknownEffect(
                def.methods[name].input as Schema.Codec<unknown, unknown>
              )(input).pipe(
                Effect.flatMap(
                  (decoded) =>
                    rpcs.get(def.id)[name](decoded, {
                      error: (type: string, message: string) => ({
                        type,
                        message,
                      }),
                    }) as Effect.Effect<unknown, unknown>
                )
              )
            );
            if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
            return JSON.parse(JSON.stringify(exit.value));
          },
        ])
      ),
  };
  return {
    S,
    tools,
    hooks,
    call,
    sealOf,
    asserted,
    requests,
    interrupted,
    notices,
    notified,
    bus,
    launch,
    scope,
    rpcs,
    commands,
    prompts,
    client,
  };
}
const sealJson = (id: string) =>
  JSON.parse(readFileSync(join(state, id, "seal.json"), "utf8"));
const shiftClock = (id: string, minutesAgo: number, minutes = 10) => {
  const file = join(state, id, "seal.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  const start = Date.now() - minutesAgo * 60_000;
  writeFileSync(
    file,
    JSON.stringify({
      ...s,
      createdAt: new Date(start).toISOString(),
      deadline: new Date(start + minutes * 60_000).toISOString(),
      budgetMinutes: minutes,
    })
  );
};
const add = (seal: string, o: any = {}) => ({
  seal,
  title: "Division by zero",
  severity: "important",
  kind: "defect",
  lens: "correctness",
  path: "src/a.ts",
  line: 2,
  quote: "export const div = (x: number, y: number) => x / y",
  trigger: "y=0",
  consequence: "Infinity",
  evidence: ["src/a.ts:2"],
  ...o,
});

test("registers fifteen tools, four hooks, and the settings RPC; tools assert permission; auto target", async () => {
  const { tools, hooks, call, sealOf, asserted, rpcs } = await harness(repo());
  assert.deepEqual([...rpcs.keys()], ["directorate"]);
  assert.deepEqual([...tools.keys()].sort(), [
    "directorate_configure",
    "directorate_coverage",
    "directorate_diff",
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
  for (const [name, tool] of tools)
    assert.doesNotMatch(
      JSON.stringify(Schema.toJsonSchemaDocument(tool.input)),
      /"null"/,
      `${name}: optional inputs are absent keys, not anyOf-null`
    );
  const out = (
    await call("directorate_seal", {
      mode: "default",
      target: { kind: "auto" },
    })
  ).content;
  assert.match(out, /local changes .* 2 files · 2 regions/s);
  assert.ok(sealOf(out));
  assert.deepEqual(asserted, ["directorate_liaison:directorate_seal"]);
});

test("/directorate-review submits a question-first prompt in the current session", async () => {
  const { commands, prompts, S } = await harness(repo());
  const review = commands.get("directorate-review");
  assert.ok(review);

  const sessionID = Session.ID.make(S("lead"));
  const text = "Review PR #123";
  const files = [{ uri: "file:///tmp/context.md" }];
  await Effect.runPromise(
    review.execute({ delivery: "queue", prompt: { files, text }, sessionID })
  );

  assert.equal(prompts.length, 1);
  const [submitted] = prompts;
  assert.ok(submitted);
  assert.equal(submitted.sessionID, sessionID);
  assert.equal(submitted.delivery, "queue");
  assert.deepEqual(submitted.files, files);
  assert.ok(submitted.text.startsWith(text));
  assert.match(
    submitted.text,
    /question tool.*\s+Once the options are settled, dispatch directorate_liaison/u
  );
});

test("worker tool limits are the agents' permission rules, which OpenCode applies by removing denied tools", () => {
  const allowed = (agent: string) => {
    const md = readFileSync(
      new URL(`../agents/${agent}.md`, import.meta.url),
      "utf8"
    );
    const rules = [
      ...md.matchAll(
        /\{\s*action: "?([\w*]+)"?,\s*resource: "?([^",}]+)"?,\s*effect: (\w+),?\s*\}/gu
      ),
    ].map((m) => m.slice(1));
    assert.deepEqual(
      rules[0],
      ["*", "*", "deny"],
      `${agent} denies everything first`
    );
    // Direct file access reaches only the lens references; code is read through the sealed directorate_* tools.
    for (const [action, resource, effect] of rules)
      if (
        effect === "allow" &&
        (action === "read" || action === "external_directory")
      ) {
        assert.ok(
          resource === "~/.config/opencode/skills/directorate_lenses/*" ||
            (action === "read" &&
              resource ===
                ".opencode/skills/directorate_lenses/references/*.md"),
          `${agent}: ${action} is limited to the lens skill`
        );
      }
    return rules
      .filter(
        ([action, , effect]) =>
          action.startsWith("directorate_") && effect === "allow"
      )
      .map(([action]) => action)
      .sort();
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
    [...read, "directorate_ledger_add", "directorate_note"].sort()
  );
  assert.deepEqual(
    allowed("directorate_compliance"),
    [...read, "directorate_ledger_verdict"].sort()
  );
  // Seats review independently: they file, but never list the other seats' entries.
  assert.deepEqual(
    allowed("directorate_seat"),
    [
      ...read.filter((t) => t !== "directorate_ledger_list"),
      "directorate_ledger_add",
      "directorate_note",
    ].sort()
  );
  allowed("directorate_liaison");
});

test("ownership: only the sealing session may cover, refresh, or report", async () => {
  const { call, sealOf } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await assert.rejects(
    call("directorate_report", { seal }, "directorate_liaison", "other-lead"),
    /Only the session that sealed/
  );
  await assert.rejects(
    call(
      "directorate_coverage",
      { seal, regions: ["R1"], disposition: "skipped", note: "x" },
      "directorate_liaison",
      "other-lead"
    ),
    /Only the session that sealed/
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
        seal,
        id: "F1",
        verdict: "refuted",
        rationale: "r",
        evidence: ["src/a.ts:1"],
      },
      "build",
      "build"
    ),
    /Only directorate_liaison or directorate_compliance/
  );
  await assert.rejects(
    call("directorate_ledger_verdict", {
      seal,
      id: "F1",
      verdict: "refuted",
      rationale: "r",
      evidence: ["src/a.ts:1"],
    }),
    /needs directorate_compliance/
  );
});

test("full flow: children registered at launch, gates, compliance confirms, report stops running children", async () => {
  const { S, call, sealOf, launch, interrupted } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  const d1 = (await call("directorate_diff", { seal })).content;
  assert.match(d1, /columns: old line, new line/);
  assert.match(d1, /^\s+2 \+export const div/m);
  const finish = await launch(
    "call-1",
    "directorate_auditor",
    "seal: x\nquestion: Is y ever zero?",
    "child1",
    "running"
  );
  assert.deepEqual(
    [sealJson(seal).children[0].status, sealJson(seal).children[0].session],
    ["running", S("child1")],
    "linked when its session was created"
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Still running: directorate_auditor/
  );
  await finish();
  assert.equal(sealJson(seal).children[0].session, S("child1"));
  await assert.rejects(
    call(
      "directorate_ledger_add",
      add(seal, { quote: "export const div = (x, y) => x % y" }),
      "directorate_auditor",
      "child1"
    ),
    /quote not found/
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
      title: "Speculative",
      severity: "minor",
      path: "src/b.ts",
      line: 1,
      quote: "export const b = 2",
      evidence: ["src/b.ts:1"],
    }),
    "directorate_auditor",
    "child1"
  );
  await call(
    "directorate_ledger_verdict",
    {
      seal,
      id: "F1",
      verdict: "confirmed",
      rationale: "retraced",
      evidence: ["./src/a.ts:2"],
    },
    "directorate_compliance",
    "ref"
  );
  assert.match(
    (
      await call(
        "directorate_ledger_list",
        { seal, ids: ["F1"] },
        "directorate_compliance",
        "ref"
      )
    ).content,
    /confirmed \(important\) by directorate_compliance: retraced \[src\/a.ts:2\]/
  );
  assert.match(
    (
      await call(
        "directorate_ledger_list",
        { seal, brief: true },
        "directorate_compliance",
        "ref"
      )
    ).content,
    /- F2 \[open\] minor · Speculative — src\/b.ts:1/
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Unverified Dossier\): 1 entries/
  );
  const md = (await call("directorate_report", { seal, approach: "ok" }))
    .content;
  assert.match(md, /status: \*\*partial\*\*/);
  assert.match(md, /\[Important\] Division by zero/);
  assert.match(md, /### Unverified Leads[\s\S]*Speculative/);
  assert.match(md, /directorate_auditor did not finish: Is y ever zero\?/);
  assert.deepEqual(interrupted, [S("child1")]);
  await assert.rejects(
    call("directorate_ledger_add", add(seal), "directorate_auditor", "child1"),
    /already reported/
  );
  assert.equal((await call("directorate_report", { seal })).content, md);
});

test("panel: seats assigned at launch, separate reads, credit across seats, a gate for missing seats, one combined report", async () => {
  const { S, call, sealOf, hooks, bus } = await harness(repo());
  const models = ["prov/alpha#high", "prov/beta", "other/gamma#xhigh"];
  await assert.rejects(
    call("directorate_seal", {
      mode: "default",
      target: { kind: "local" },
      panel_models: ["no-provider"],
    }),
    /providerID\/modelID/
  );
  const out = (
    await call("directorate_seal", {
      mode: "default",
      target: { kind: "local" },
      panel_models: models,
    })
  ).content;
  assert.match(
    out,
    /budget 30 min/,
    "a panel gets half again the mode's budget"
  );
  assert.match(out, /Directorate Seats \(3\): alpha#high, beta, gamma#xhigh/);
  const seal = sealOf(out);
  // Launched without a model, each Seat takes the next open seat; its title names the seat, and its session claims it.
  const launch = async (call: string, child: string) => {
    const event = {
      tool: "subagent",
      sessionID: S("lead"),
      agent: "directorate_liaison",
      id: call,
      input: {
        agent: "directorate_seat",
        prompt: `seal: ${seal}`,
        description: "Directorate Seat",
      } as any,
    };
    await hooks["tool.execute.before"](event);
    parents.set(S(child), S("lead"));
    await bus.emit({
      type: "session.created",
      data: {
        sessionID: S(child),
        parentID: S("lead"),
        agent: "directorate_seat",
        title: event.input.description,
      },
    });
    return event.input;
  };
  const inputs = [
    await launch("p1", "pa"),
    await launch("p2", "pb"),
    await launch("p3", "pc"),
  ];
  assert.deepEqual(
    inputs.map((i) => [i.model, i.description]),
    models.map((m) => [m, `Directorate Seat · ${m.slice(m.indexOf("/") + 1)}`])
  );
  assert.deepEqual(
    sealJson(seal).children.map((c: any) => [c.model, c.session]),
    models.map((m, i) => [m, S(["pa", "pb", "pc"][i])])
  );
  // Every seat reads every region, apart from the Liaison and from each other.
  for (const p of ["pa", "pb"]) {
    assert.match(
      (await call("directorate_diff", { seal }, "directorate_seat", p)).content,
      /export const div/
    );
    assert.match(
      (await call("directorate_diff", { seal }, "directorate_seat", p)).content,
      /All regions have been read/
    );
  }
  assert.match(
    (await call("directorate_diff", { seal })).content,
    /export const div/,
    "Seat reads do not cover the Liaison"
  );
  await call("directorate_ledger_add", add(seal), "directorate_seat", "pa");
  await call(
    "directorate_ledger_add",
    add(seal, { title: "Divide by zero" }),
    "directorate_seat",
    "pb"
  );
  assert.match(
    (
      await call(
        "directorate_ledger_list",
        { seal, brief: true },
        "directorate_compliance",
        "ref"
      )
    ).content,
    /F1 .* by alpha#high\n.*F2 .* by beta/
  );
  await call(
    "directorate_ledger_verdict",
    {
      seal,
      id: "F1",
      verdict: "confirmed",
      rationale: "retraced",
      evidence: ["src/a.ts:2"],
    },
    "directorate_compliance",
    "ref"
  );
  await call(
    "directorate_ledger_verdict",
    {
      seal,
      id: "F2",
      verdict: "duplicate",
      of: "F1",
      rationale: "same",
      evidence: ["src/a.ts:2"],
    },
    "directorate_compliance",
    "ref"
  );
  for (const p of ["pa", "pb"])
    await bus.emit({ type: "session.idle", data: { sessionID: S(p) } });
  await bus.emit({
    type: "session.execution.failed",
    data: { sessionID: S("pc") },
  });
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Seats\): 1 of 3 Directorate Seats returned no review: gamma#xhigh \(failed\)/
  );
  // A relaunch takes the failed seat again; when that run fails too, the report goes out without it.
  assert.equal((await launch("p4", "pd")).model, "other/gamma#xhigh");
  await bus.emit({
    type: "session.execution.failed",
    data: { sessionID: S("pd") },
  });
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Seats\)/,
    "a new failed run is a new gap"
  );
  const md = (await call("directorate_report", { seal })).content;
  assert.match(md, /status: \*\*partial\*\*/);
  assert.match(md, /1 of 3 panel seats did not review/);
  assert.match(
    md,
    /Directorate Seats: alpha#high, beta, gamma#xhigh \(memetic isolation intact\)/
  );
  assert.match(
    md,
    /\[Important\] Division by zero\*\* — `src\/a.ts:2` · defect · correctness · seats 2\/3/
  );
  assert.match(
    md,
    /raised by alpha#high, confirmed by directorate_compliance · also raised by beta/
  );
  assert.match(
    md,
    /### Directorate Seats\n\| Seat \| Review \| Raised \| Confirmed \| Only this seat \|\n.*\n\| alpha#high \| completed \| 1 \| 1 \| — \|\n\| beta \| completed \| 1 \| 1 \| — \|\n\| gamma#xhigh \| failed \| 0 \| 0 \| — \|/
  );
  assert.match(md, /Directorate Seat gamma#xhigh: its review failed/);
  assert.doesNotMatch(
    md,
    /directorate_seat did not complete/,
    "a failed seat is reported once, as its seat"
  );
});

test("panel: true seats the default models; a seat named a model by the Liaison keeps it", async () => {
  const { S, call, sealOf, hooks } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
        panel: true,
      })
    ).content
  );
  assert.equal(sealJson(seal).panel.length, 5);
  const event = {
    tool: "subagent",
    sessionID: S("lead"),
    agent: "directorate_liaison",
    id: "p1",
    input: {
      agent: "directorate_seat",
      prompt: "x",
      model: "prov/chosen",
    } as any,
  };
  await hooks["tool.execute.before"](event);
  assert.equal(event.input.model, "prov/chosen");
  assert.equal(sealJson(seal).children[0].model, "prov/chosen");
  assert.match(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
        abandon: true,
      })
    ).content,
    /^(?![\s\S]*Directorate Seats \()/,
    "no panel unless asked"
  );
});

/**
 * The TUI part against a scripted user: each select, prompt, and confirm takes the next step, which answers from the
 * dialog's options. /directorate-configure is run as the TUI runs it, through the command the plugin's keymap layer registers.
 */
function tui(
  client: unknown,
  dir: string,
  steps: ((dialog: any) => unknown)[]
) {
  const seen: any[] = [];
  const toasts: any[] = [];
  const alerts: any[] = [];
  const layers: any[] = [];
  const answer = (kind: string) => async (dialog: any) => {
    seen.push({ kind, ...dialog });
    const step = steps.shift();
    assert.ok(step, `no step left for ${kind} "${dialog.title}"`);
    return step(dialog);
  };
  const context = {
    location: { directory: dir },
    client,
    data: { location: { default: () => ({ directory: dir }) } },
    keymap: { layer: (factory: () => unknown) => void layers.push(factory()) },
    ui: {
      dialog: {
        select: answer("select"),
        prompt: answer("prompt"),
        confirm: answer("confirm"),
        alert: async (a: any) => void alerts.push(a),
      },
      toast: { show: (t: any) => void toasts.push(t) },
      format: { path: (p: string) => p },
    },
  };
  tuiPlugin.setup(context as any);
  const command = layers[0].commands[0];
  return {
    layer: layers[0],
    command,
    run: () => command.run(),
    seen,
    toasts,
    alerts,
    left: () => steps.length,
  };
}
/**
 * The GUI part as OpenCode Desktop loads it: the built dist/gui-experimental.cjs (npm test builds it first), evaluated
 * as CommonJS text with the modules the app provides. Each dialog takes the next step, as in tui().
 */
async function desktop(
  client: unknown,
  session: { location?: { directory: string } } | undefined,
  steps: ((dialog: any) => unknown)[]
) {
  const provided: Record<string, unknown> = {
    "@opencode/plugin/gui": await import("@opencode/plugin/gui"),
    "@opencode/plugin/rpc": await import("@opencode/plugin/rpc"),
    effect: await import("effect"),
  };
  const module = { exports: {} as any };
  const require = (id: string) =>
    provided[id] ??
    assert.fail(
      `the GUI bundle requires ${id}, which the app does not provide`
    );
  new Function(
    "exports",
    "require",
    "module",
    readFileSync(
      new URL("../dist/gui-experimental.cjs", import.meta.url),
      "utf8"
    )
  )(module.exports, require, module);
  const seen: any[] = [];
  const toasts: any[] = [];
  const alerts: any[] = [];
  const commands: any[] = [];
  const ask = (kind: string) => async (dialog: any) => {
    seen.push({ kind, ...dialog });
    const step = steps.shift();
    assert.ok(step, `no step left for ${kind} "${dialog.title}"`);
    return step(dialog);
  };
  const ctx = {
    client: "the app's own server: used only with no session",
    sessions: { current: () => session && { ...session, server: { client } } },
    dialogs: {
      select: ask("select"),
      prompt: ask("prompt"),
      confirm: ask("confirm"),
      alert: async (a: any) => void alerts.push(a),
    },
    toast: { show: (t: any) => void toasts.push(t) },
    add: (_registry: unknown, item: () => unknown) =>
      void commands.push(item()),
  };
  module.exports.default.setup(ctx);
  return {
    command: commands[0],
    seen,
    toasts,
    alerts,
    left: () => steps.length,
  };
}
/** Picks the option with this title; it must be offered and enabled. */
const pick = (title: string) => (d: any) => {
  const o = d.options.find((x: any) => x.title === title);
  assert.ok(
    o && !o.disabled,
    `"${title}" not offered in "${d.title}": ${d.options.map((x: any) => x.title).join(", ")}`
  );
  return o.value;
};
const esc = () => undefined;

test("/directorate-configure in the TUI: a slash and palette command whose dialogs write directorate.json through the RPC", async () => {
  const dir = repo();
  const { client } = await harness(dir);
  const t = tui(client, dir, [
    pick("Global Charter"),
    pick("Default mode"),
    pick("full"),
    pick("Panel by default"),
    pick("On"),
    pick("Directorate Seats (panel models)"),
    pick("Add a Seat…"),
    (d) => (
      assert.deepEqual(
        d.options.map((o: any) => o.title),
        ["prov/alpha", "prov/beta"],
        "disabled models are not offered"
      ),
      pick("prov/alpha")(d)
    ),
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
    (d) => (
      assert.match(d.title, /Global Charter \(unsaved\)/),
      pick("Save")(d)
    ),
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
  assert.match(t.toasts[0].message, /"500" is not 2–240 minutes/);
  assert.deepEqual(JSON.parse(readFileSync(globalSettings, "utf8")), {
    mode: "full",
    budget_minutes: { full: 45 },
    panel: {
      enabled: true,
      models: [
        { model: "prov/beta" },
        { model: "prov/alpha", variant: "xhigh" },
      ],
    },
    lenses: { disabled: ["docs"] },
  });
  assert.equal(t.toasts[1].variant, "success");
  assert.match(
    t.toasts[1].message,
    new RegExp(
      `<Filed/Saved> ${globalSettings}\\. Effective: mode full · panel on · panel models prov/beta, prov/alpha#xhigh · budgets full 45 min · lenses off docs\\.`
    )
  );
});

test("/directorate-configure in OpenCode Desktop: the built GUI bundle runs the same walk through the session's server", async () => {
  const dir = repo();
  const { client } = await harness(dir);
  const d = await desktop(client, { location: { directory: dir } }, [
    (x) => (
      assert.deepEqual(
        x.options.map((o: any) => o.title),
        ["Global Charter", "Local Jurisdiction (This project)"]
      ),
      pick("Local Jurisdiction (This project)")(x)
    ),
    pick("Default mode"),
    pick("full"),
    pick("Time budgets"),
    pick("full"),
    (x) => (
      assert.match(
        x.description,
        /Type "unset" to fall back to 60, ×1\.5 for panels min/
      ),
      "30"
    ),
    pick("default"),
    () => "unset",
    esc,
    (x) => (
      assert.equal(
        x.options.find((o: any) => o.title === "Save").group,
        "File"
      ),
      pick("Save")(x)
    ),
  ]);
  assert.equal(d.command.id, "configure");
  assert.deepEqual(d.command.slash, { name: "directorate-configure" });
  await d.command.run();
  assert.equal(d.left(), 0);
  assert.deepEqual(d.alerts, []);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(dir, ".opencode", "directorate.json"), "utf8")
    ),
    { mode: "full", budget_minutes: { full: 30 } }
  );
  assert.equal(d.toasts[0].variant, "success");
  assert.match(
    d.toasts[0].description,
    /^<Filed\/Saved> .*\.opencode\/directorate\.json\. Effective: mode full · budgets full 30 min\.$/
  );

  // The app's select has no disabled options: in the home directory, "Local Jurisdiction (This project)" is left out.
  mkdirSync(home, { recursive: true });
  const h = await harness(home);
  const x = await desktop(h.client, { location: { directory: home } }, [
    (s) => (
      assert.deepEqual(
        s.options.map((o: any) => o.title),
        ["Global Charter"]
      ),
      undefined
    ),
  ]);
  await x.command.run();
  assert.equal(x.left(), 0);
});

test("/directorate-configure in the TUI: project over global, a rejected save is shown and fixable, unsaved changes need confirming", async () => {
  const dir = repo();
  const { client } = await harness(dir);
  mkdirSync(join(home, ".opencode"), { recursive: true });
  writeFileSync(
    globalSettings,
    JSON.stringify({ mode: "code-quality", lenses: { disabled: ["ux"] } })
  );
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(
    join(dir, ".opencode", "directorate.json"),
    JSON.stringify({ panel: { models: [{ model: "prov/off" }] } })
  );
  const t = tui(client, dir, [
    pick("Local Jurisdiction (This project)"),
    (d) => {
      const by = Object.fromEntries(
        d.options.map((o: any) => [o.title, o.description])
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
    (d) => (
      assert.equal(
        d.options.find((o: any) => o.title === "ux").description,
        "off"
      ),
      pick("ux")(d)
    ),
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
  assert.match(t.alerts[0].title, /not saved/);
  assert.match(t.alerts[0].message, /prov\/off is not an available chat model/);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(dir, ".opencode", "directorate.json"), "utf8")
    ),
    { lenses: { disabled: [] } },
    "an empty list still overrides the global one"
  );
  assert.match(t.toasts[0].message, /Effective: mode code-quality\.$/);

  // Escape with unsaved changes asks first; keeping them returns to the menu.
  const before = readFileSync(globalSettings, "utf8");
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
    readFileSync(globalSettings, "utf8"),
    before,
    "discarded changes are not written"
  );

  // In the home directory the project file would be the global one: there is no project scope.
  mkdirSync(home, { recursive: true });
  const h = await harness(home);
  const x = tui(h.client, home, [
    (d) => (
      assert.equal(
        d.options.find(
          (o: any) => o.title === "Local Jurisdiction (This project)"
        ).disabled,
        true
      ),
      undefined
    ),
  ]);
  await x.run();
  assert.equal(x.left(), 0);
  await assert.rejects(
    h.client
      .rpc(DirectorateRpc)
      .write({ scope: "project", settings: { mode: "full" } }),
    (e: any) =>
      e.type === "rejected" && /^No project settings here/.test(e.message)
  );
  assert.equal(
    readFileSync(globalSettings, "utf8"),
    before,
    "the global file is untouched"
  );

  // A settings file the server cannot read is reported, not edited over.
  writeFileSync(globalSettings, `{ "mode": "fast" }`);
  const b = tui(client, dir, []);
  await b.run();
  assert.match(
    b.alerts[0].message,
    /directorate\.json is not valid Directorate settings/
  );
});

test("directorate_configure: validated writes per scope; the project overrides global key by key; seals use the result", async () => {
  const dir = repo();
  const { call, sealOf, hooks, S } = await harness(dir);
  const cfg = (input: any) =>
    call("directorate_configure", input, "build", "cfg");
  await assert.rejects(
    call("directorate_configure", { action: "show" }),
    /review agents cannot modify Directorate settings/
  );
  await assert.rejects(
    cfg({
      action: "write",
      scope: "global",
      settings: { lenses: { disabled: ["auth"] } },
    }),
    /auth|Expected/,
    "the domain lenses are gone"
  );
  await assert.rejects(
    cfg({
      action: "write",
      scope: "global",
      settings: { panel: { models: [{ model: "prov/off" }] } },
    }),
    /prov\/off is not an available chat model/
  );
  await assert.rejects(
    cfg({
      action: "write",
      scope: "global",
      settings: {
        panel: { models: [{ model: "prov/alpha", variant: "max" }] },
      },
    }),
    /no thinking level "max" \(it has: high, xhigh\)/
  );
  await assert.rejects(
    cfg({
      action: "write",
      scope: "global",
      settings: { panel: { models: [{ model: "prov/alpha#high" }] } },
    }),
    /put the thinking level in variant/
  );
  const g = (
    await cfg({
      action: "write",
      scope: "global",
      settings: {
        mode: "code-quality",
        panel: {
          enabled: true,
          models: [
            { model: "prov/alpha", variant: "xhigh" },
            { model: "prov/beta" },
          ],
        },
        budget_minutes: { "code-quality": 12 },
      },
    })
  ).content;
  assert.match(g, new RegExp(`Wrote ${globalSettings}`));
  assert.deepEqual(
    JSON.parse(readFileSync(globalSettings, "utf8")).panel.models[0],
    { model: "prov/alpha", variant: "xhigh" }
  );
  const p = (
    await cfg({
      action: "write",
      scope: "project",
      settings: {
        panel: { enabled: false },
        lenses: { disabled: ["ux", "docs"] },
      },
    })
  ).content;
  assert.match(
    p,
    /\.opencode\/directorate\.json \(keys not shown[\s\S]*"disabled": \[\n\s+"ux"[\s\S]*\nEffective settings: mode code-quality · panel off · panel models prov\/alpha#xhigh, prov\/beta · budgets code-quality 12 min · lenses off ux, docs/
  );
  const shown = (await cfg({ action: "show", find: "ALP" })).content;
  assert.match(shown, /- prov\/alpha \(Alpha\) \[high, xhigh\]/);
  assert.doesNotMatch(shown, /prov\/beta \(/);
  // The Liaison sees the settings before it seals.
  const ctx: any = {
    agent: "directorate_liaison",
    sessionID: S("lead"),
    system: [],
    tools: {},
  };
  await hooks["session.context"](ctx);
  assert.match(
    ctx.system[0].text,
    /^\[directorate settings\] mode code-quality · panel off/
  );
  // Configured mode, budget, and lenses; the project turned the panel off, and a request turns it back on.
  const out = (
    await call("directorate_seal", { target: { kind: "local" }, panel: true })
  ).content;
  assert.match(out, /budget 12 min/, "a configured budget is used as-is");
  assert.match(out, /Lenses disabled by directorate.json: ux, docs/);
  assert.match(out, /Directorate Seats \(2\): alpha#xhigh, beta/);
  const seal = sealOf(out);
  assert.equal(sealJson(seal).mode, "code-quality");
  await assert.rejects(
    call(
      "directorate_ledger_add",
      add(seal, { lens: "ux" }),
      "directorate_auditor",
      "scout"
    ),
    /ux lens is disabled/
  );
  await assert.rejects(
    call(
      "directorate_ledger_add",
      add(seal, { lens: "billing" }),
      "directorate_auditor",
      "scout"
    ),
    /Expected "correctness" | "security"/,
    "only the ten lenses are accepted"
  );
  await call(
    "directorate_ledger_add",
    add(seal),
    "directorate_auditor",
    "scout"
  );
  const off = (
    await call("directorate_seal", {
      mode: "default",
      target: { kind: "local" },
      abandon: true,
    })
  ).content;
  assert.doesNotMatch(
    off,
    /Directorate Seats \(/,
    "the project's panel off wins over the global on"
  );
  assert.match(off, /budget 20 min/);
  // {} removes a scope's file; a broken file is an error the tool names.
  assert.match(
    (await cfg({ action: "write", scope: "global", settings: {} })).content,
    /Removed/
  );
  writeFileSync(
    join(dir, ".opencode", "directorate.json"),
    `{ "mode": "fast" }`
  );
  await assert.rejects(
    cfg({ action: "show" }),
    /directorate\.json is not valid Directorate settings/
  );
  writeFileSync(
    join(dir, ".opencode", "directorate.json"),
    `{ "lense": { "disabled": ["ux"] } }`
  );
  await assert.rejects(
    cfg({ action: "show" }),
    /not valid Directorate settings.*lense/s,
    "a misspelled key in a file is an error, not ignored"
  );
});

test("gates fire again for new gaps: a new entry after an acknowledged open gate pushes back once more", async () => {
  const { call, sealOf } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await call("directorate_diff", { seal });
  await call(
    "directorate_ledger_add",
    add(seal, { severity: "minor" }),
    "directorate_auditor",
    "scout"
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Unverified Dossier\): 1 entries/
  );
  await call(
    "directorate_ledger_add",
    add(seal, {
      title: "Another",
      severity: "minor",
      path: "src/b.ts",
      line: 1,
      quote: "export const b = 2",
      evidence: ["src/b.ts:1"],
    }),
    "directorate_auditor",
    "scout"
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Unverified Dossier\): 2 entries/,
    "F2 is new"
  );
  const md = (await call("directorate_report", { seal })).content;
  assert.match(md, /2 leads unverified/);
});

test("a completed report closes the ledger", async () => {
  const { call, sealOf } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await call("directorate_diff", { seal });
  await call("directorate_report", { seal });
  await assert.rejects(
    call("directorate_ledger_add", add(seal), "directorate_auditor", "scout"),
    /already reported/
  );
});

test("child events: early completion is reconciled; failure overrides idle", async () => {
  const { S, call, sealOf, launch, bus } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await call("directorate_diff", { seal });
  const fin1 = await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "running"
  );
  await bus.emit({ type: "session.idle", data: { sessionID: S("a") } });
  await fin1();
  assert.equal(sealJson(seal).children[0].status, "completed");
  const fin2 = await launch(
    "c2",
    "directorate_auditor",
    "seal: x\nquestion: q2",
    "b",
    "running"
  );
  await fin2();
  await bus.emit({
    type: "session.execution.failed",
    data: { sessionID: S("b") },
  });
  await bus.emit({ type: "session.idle", data: { sessionID: S("b") } });
  assert.equal(sealJson(seal).children[1].status, "failed");
  assert.match(
    (await call("directorate_report", { seal })).content,
    /directorate_auditor did not complete: q2/
  );
});

test("directorate_wait: the Liaison waits in its turn until a run finishes, and hears what it recorded", async () => {
  const { S, call, sealOf, launch, bus } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  assert.match(
    (await call("directorate_wait", { seal })).content,
    /No Auditor, Seat, or Compliance runs are running/
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
    /Only the session that sealed/
  );
  let returned = false;
  const waiting = call("directorate_wait", { seal }).then(
    (out) => ((returned = true), out.content)
  );
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(returned, false, "nothing finished: still waiting");
  await call("directorate_ledger_add", add(seal), "directorate_auditor", "a");
  await bus.emit({ type: "session.idle", data: { sessionID: S("a") } });
  const out = await waiting;
  assert.match(
    out,
    /^- directorate_auditor completed \(ses_a-[^)]+\): raised F1$/m
  );
  assert.match(
    out,
    /Still running \(1\): directorate_compliance \(ses_b-[^)]+\)\. .*call directorate_wait again/
  );
  await bus.emit({ type: "session.idle", data: { sessionID: S("b") } });
  assert.match(
    (await call("directorate_wait", { seal })).content,
    /No Auditor, Seat, or Compliance runs are running/
  );
});

test("follow-ups to a subagent are new runs of its session: earlier runs keep their outcome, and directorate_wait reports the new run once", async () => {
  const { S, call, sealOf, launch, bus, hooks } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await call(
    "directorate_ledger_add",
    add(seal),
    "directorate_auditor",
    "scout"
  );
  await call(
    "directorate_ledger_add",
    add(seal, {
      title: "Second",
      severity: "minor",
      path: "src/b.ts",
      line: 1,
      quote: "export const b = 2",
      evidence: ["src/b.ts:1"],
    }),
    "directorate_auditor",
    "scout"
  );
  const followUp = (id: string, agent: string, child: string, prompt: string) =>
    hooks["tool.execute.before"]({
      tool: "subagent",
      sessionID: S("lead"),
      agent: "directorate_liaison",
      id,
      input: { agent, prompt, description: "again", sessionID: S(child) },
    });
  const runs = () =>
    sealJson(seal).children.map((k: any) => [k.call, k.session, k.status]);
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
      seal,
      id: "F1",
      verdict: "confirmed",
      rationale: "retraced",
      evidence: ["src/a.ts:2"],
    },
    "directorate_compliance",
    "b"
  );
  await bus.emit({ type: "session.idle", data: { sessionID: S("b") } });
  await followUp("c2", "directorate_compliance", "b", "seal: x\nentries: [F2]");
  assert.deepEqual(runs(), [
    ["c1", S("b"), "completed"],
    ["c2", S("b"), "launching"],
  ]);
  // The child working again belongs to the follow-up, not the earlier run.
  await hooks["tool.execute.before"]({
    tool: "directorate_read",
    sessionID: S("b"),
    agent: "directorate_compliance",
    id: "r1",
    input: {},
  });
  assert.equal(runs()[0][2], "completed");
  const waiting = call("directorate_wait", { seal });
  await call(
    "directorate_ledger_verdict",
    {
      seal,
      id: "F2",
      verdict: "refuted",
      rationale: "guarded",
      evidence: ["src/b.ts:1"],
    },
    "directorate_compliance",
    "b"
  );
  await bus.emit({ type: "session.idle", data: { sessionID: S("b") } });
  const out = (await waiting).content;
  assert.equal(out.match(/^- /gm)?.length, 1, out);
  assert.match(
    out,
    /^- directorate_compliance completed \(ses_b-[^)]+\): decided F2 refuted$/m,
    "only what this run recorded"
  );
  // A failed follow-up fails only itself.
  await followUp("c3", "directorate_compliance", "b", "seal: x\nentries: [F2]");
  await bus.emit({
    type: "session.execution.failed",
    data: { sessionID: S("b") },
  });
  assert.deepEqual(
    runs().map((r: any) => r[2]),
    ["completed", "completed", "failed"]
  );
  // A follow-up to a child still running joins its run.
  await launch(
    "c4",
    "directorate_auditor",
    "seal: x\nquestion: q",
    "a",
    "running"
  );
  await followUp("c5", "directorate_auditor", "a", "also check q2");
  assert.deepEqual(
    runs().map((r: any) => r[0]),
    ["c1", "c2", "c3", "c4"]
  );
});

test("directorate_wait: a budget that locks while it waits says to report, not to wait again", async () => {
  const { call, sealOf, launch } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
        budget_minutes: 10,
      })
    ).content
  );
  await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "running"
  );
  shiftClock(seal, 10 - 1.5 / 60);
  const out = (await call("directorate_wait", { seal })).content;
  assert.match(out, /^The budget is locked: call directorate_report now/m);
  assert.doesNotMatch(out, /directorate_wait again/);
});

test("only the Liaison runs a review: other agents cannot dispatch its subagents or call its tools, and do not see them", async () => {
  const { hooks } = await harness(repo());
  const ev = (agent: string | undefined, action: string, resource: string) =>
    ({
      sessionID: "ses_primary",
      agent,
      action,
      resources: [resource],
      effect: "allow",
    }) as any;
  const decide = async (e: any) => (
    await hooks["permission.evaluate"](e),
    [e.effect, e.message]
  );
  for (const target of [
    "directorate_auditor",
    "directorate_seat",
    "directorate_compliance",
  ]) {
    const [effect, message] = await decide(ev("build", "subagent", target));
    assert.equal(effect, "deny", `build may not dispatch ${target}`);
    assert.match(message, /Dispatch directorate_liaison/);
    assert.equal(
      (await decide(ev("directorate_liaison", "subagent", target)))[0],
      "allow"
    );
  }
  assert.equal(
    (await decide(ev("build", "subagent", "directorate_liaison")))[0],
    "allow"
  );
  assert.equal((await decide(ev("build", "subagent", "explore")))[0], "allow");
  assert.equal(
    (await decide(ev("build", "directorate_ledger_list", "*")))[0],
    "deny"
  );
  assert.equal((await decide(ev("build", "directorate_seal", "*")))[0], "deny");
  assert.equal(
    (await decide(ev("build", "directorate_configure", "*")))[0],
    "allow"
  );
  for (const agent of [
    "directorate_liaison",
    "directorate_auditor",
    "directorate_compliance",
    "directorate_seat",
  ])
    assert.equal(
      (await decide(ev(agent, "directorate_ledger_list", "*")))[0],
      "allow"
    );
  // A request that names no agent is the session's agent's, as the host resolves it; with neither, the rules decide.
  sessionAgents.set("ses_primary", "build");
  assert.equal(
    (await decide(ev(undefined, "subagent", "directorate_compliance")))[0],
    "deny"
  );
  assert.equal(
    (await decide(ev(undefined, "directorate_seal", "*")))[0],
    "deny"
  );
  sessionAgents.set("ses_primary", "directorate_liaison");
  assert.equal(
    (await decide(ev(undefined, "subagent", "directorate_compliance")))[0],
    "allow"
  );
  sessionAgents.delete("ses_primary");
  assert.equal(
    (await decide(ev(undefined, "subagent", "directorate_compliance")))[0],
    "allow",
    "an unknown caller is left to the agents' rules"
  );
  const [, message] = await decide(
    ev("build", "subagent", "directorate_compliance")
  );
  assert.match(
    message,
    /verbatim.*If you already dispatched one, send the follow-up to that session/
  );
  const tools = {
    read: {},
    subagent: {},
    directorate_seal: {},
    directorate_ledger_list: {},
    directorate_report: {},
    directorate_configure: {},
  };
  // Every request kind gets the same tools, so compaction and generate keep the session's prompt-cache prefix.
  for (const kind of ["context", "compaction", "generate"]) {
    const primary: any = {
      sessionID: "ses_primary",
      agent: "build",
      system: [],
      tools: { ...tools },
    };
    await hooks[`session.${kind}`](primary);
    assert.deepEqual(
      Object.keys(primary.tools),
      ["read", "subagent", "directorate_configure"],
      kind
    );
  }
  const liaison: any = {
    sessionID: "ses_liaison",
    agent: "directorate_liaison",
    system: [],
    tools: { ...tools },
  };
  await hooks["session.context"](liaison);
  assert.deepEqual(Object.keys(liaison.tools), Object.keys(tools));
  for (const agent of [
    "directorate_auditor",
    "directorate_seat",
    "directorate_compliance",
  ]) {
    assert.match(
      readFileSync(new URL(`../agents/${agent}.md`, import.meta.url), "utf8"),
      /^hidden: true$/m,
      `${agent} is not offered to other agents`
    );
  }
});

test("child events: a failure reported by the subagent tool beats an earlier idle event", async () => {
  const { S, call, sealOf, launch, bus } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  const fin = await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "failed"
  );
  await bus.emit({ type: "session.idle", data: { sessionID: S("a") } });
  await fin();
  assert.equal(sealJson(seal).children[0].status, "failed");
});

test("children link when their session is created: parallel launches by title; a finish before the after-hook stands", async () => {
  const { S, call, sealOf, hooks, bus } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  const before = (id: string, description: string) =>
    hooks["tool.execute.before"]({
      tool: "subagent",
      sessionID: S("lead"),
      agent: "directorate_liaison",
      id,
      input: {
        agent: "directorate_auditor",
        prompt: `question: ${description}`,
        description,
      },
    });
  await before("c1", "alpha");
  await before("c2", "beta");
  for (const [child, title] of [
    ["b", "beta"],
    ["a", "alpha"],
  ]) {
    parents.set(S(child), S("lead"));
    await bus.emit({
      type: "session.created",
      data: {
        sessionID: S(child),
        parentID: S("lead"),
        agent: "directorate_auditor",
        title,
      },
    });
  }
  assert.deepEqual(
    sealJson(seal).children.map((c: any) => [c.call, c.session, c.status]),
    [
      ["c1", S("a"), "running"],
      ["c2", S("b"), "running"],
    ]
  );
  // The child finishes before the subagent tool returns; a background "running" result does not undo it.
  await bus.emit({ type: "session.idle", data: { sessionID: S("a") } });
  await hooks["tool.execute.after"]({
    tool: "subagent",
    sessionID: S("lead"),
    id: "c1",
    status: "completed",
    result: {
      content: `<subagent sessionID="${S("a")}" state="running">`,
      metadata: { metadata: { sessionID: S("a"), status: "running" } },
    },
  });
  assert.equal(sealJson(seal).children[0].status, "completed");
});

test("after a plugin reload, a child's events reach its review through the parent session's record", async () => {
  const dir = repo();
  const h1 = await harness(dir, "kids");
  const seal = h1.sealOf(
    (
      await h1.call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await h1.launch("c1", "directorate_auditor", "question: q1", "a", "running");
  const h2 = await harness(dir, "kids");
  await h2.bus.emit({
    type: "session.execution.failed",
    data: { sessionID: h2.S("a") },
  });
  assert.equal(sealJson(seal).children[0].status, "failed");
});

test("hooks write the seal only for changes: unrelated subagents and running auditors' tool calls leave it alone", async () => {
  const { S, call, sealOf, launch, hooks, bus } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  const fin = await launch(
    "c1",
    "directorate_auditor",
    "seal: x\nquestion: q1",
    "a",
    "running"
  );
  await fin();
  const inode = () => statSync(join(state, seal, "seal.json")).ino;
  const before = inode();
  await bus.emit({ type: "session.idle", data: { sessionID: S("lead") } });
  await hooks["tool.execute.before"]({
    tool: "subagent",
    sessionID: S("lead"),
    agent: "directorate_liaison",
    id: "e1",
    input: { agent: "explore", prompt: "look around" },
  });
  await hooks["tool.execute.after"]({
    tool: "subagent",
    sessionID: S("lead"),
    id: "e1",
    status: "completed",
    result: {
      content: `<subagent sessionID="${S("x")}" state="completed">`,
      metadata: { metadata: { sessionID: S("x"), status: "completed" } },
    },
  });
  await hooks["tool.execute.before"]({
    tool: "directorate_read",
    sessionID: S("a"),
    agent: "directorate_auditor",
    id: "r1",
    messageID: "m",
    input: {},
  });
  assert.equal(inode(), before, "seal.json was not rewritten");
  assert.deepEqual(
    sealJson(seal).children.map((c: any) => c.call),
    ["c1"]
  );
});

test("one review per session; abandon saves and notifies; resume checks the session's own review and extends a spent budget", async () => {
  const { call, sealOf, notices } = await harness(repo());
  const first = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await assert.rejects(
    call("directorate_seal", { mode: "default", target: { kind: "local" } }),
    /already holds an active containment seal/
  );
  const second = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
        abandon: true,
      })
    ).content
  );
  assert.ok(
    sealJson(first).reportedAt &&
      sealJson(first).autoReported &&
      sealJson(first).abandoned
  );
  assert.match(notices[0], /abandoned for a new review/);
  const third = sealOf(
    (
      await call(
        "directorate_seal",
        { mode: "default", target: { kind: "local" } },
        "directorate_liaison",
        "lead2"
      )
    ).content
  );
  await assert.rejects(
    call(
      "directorate_seal",
      { resume: second },
      "directorate_liaison",
      "lead2"
    ),
    new RegExp(`already holds an active containment seal ${third}`)
  );
  shiftClock(second, 30, 20);
  const resumed = (
    await call(
      "directorate_seal",
      { resume: second },
      "directorate_liaison",
      "lead3"
    )
  ).content;
  assert.match(resumed, /Resumed containment `directorate-/);
  const s = sealJson(second);
  assert.equal(s.ownerSession.startsWith("ses_lead3"), true);
  assert.ok(
    Date.parse(s.deadline) > Date.now() + 4 * 60_000,
    "a spent budget gets more time on resume"
  );
  await assert.rejects(
    call("directorate_report", { seal: second }),
    /Only the session that sealed/
  );
});

test("freshness: gate, refresh, reopened entries need re-anchoring, a second edit is stale", async () => {
  const dir = repo();
  const { call, sealOf } = await harness(dir);
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await call("directorate_diff", { seal });
  await call(
    "directorate_ledger_add",
    add(seal, { severity: "minor" }),
    "directorate_auditor",
    "scout"
  );
  await call("directorate_ledger_verdict", {
    seal,
    id: "F1",
    verdict: "confirmed",
    rationale: "r",
    evidence: ["src/a.ts:2"],
  });
  writeFileSync(
    join(dir, "src/a.ts"),
    "export const a = 2\n// guard added\nexport const div = (x: number, y: number) => (y ? x / y : 0)\n"
  );
  await assert.rejects(
    call("directorate_report", { seal }),
    /Protocol hold \(Containment Drift\)/
  );
  const r = (await call("directorate_refresh", { seal })).content;
  assert.match(r, /Changed: src\/a.ts/);
  assert.match(r, /Reopened for re-verification: F1/);
  await assert.rejects(
    call(
      "directorate_ledger_verdict",
      {
        seal,
        id: "F1",
        verdict: "confirmed",
        rationale: "r",
        evidence: ["src/a.ts:3"],
      },
      "directorate_compliance",
      "ref"
    ),
    /anchor does not match/
  );
  await call(
    "directorate_ledger_verdict",
    {
      seal,
      id: "F1",
      verdict: "refuted",
      rationale: "guarded now",
      evidence: ["src/a.ts:3"],
    },
    "directorate_compliance",
    "ref"
  );
  await call("directorate_diff", { seal });
  writeFileSync(join(dir, "src/b.ts"), "export const b = 3\n");
  const md = (await call("directorate_report", { seal })).content;
  assert.match(md, /status: \*\*stale\*\*/);
  assert.match(
    md,
    /Containment drift \(changed after sealing and not re-verified\): `src\/b.ts`/
  );
  assert.doesNotMatch(md, /### Verified Findings/);
});

test("coverage: 'reviewed' needs a real reader; auditors keep their own read offsets", async () => {
  const dir = repo();
  writeFileSync(
    join(dir, "src/wide.ts"),
    Array.from(
      { length: 300 },
      (_, i) => `export const v${i} = "${"x".repeat(400)}"`
    ).join("\n") + "\n"
  );
  const { call, sealOf } = await harness(dir);
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  const wide = sealJson(seal).regions.find(
    (r: any) => r.file === "src/wide.ts"
  ).id;
  const a1 = (
    await call(
      "directorate_diff",
      { seal, regions: [wide] },
      "directorate_auditor",
      "scoutA"
    )
  ).content;
  assert.match(a1, /\(partial; call again\)/);
  const b1 = (
    await call(
      "directorate_diff",
      { seal, regions: [wide] },
      "directorate_auditor",
      "scoutB"
    )
  ).content;
  assert.doesNotMatch(
    b1,
    /continued from body line/,
    "auditor B starts at the top, not where auditor A stopped"
  );
  const a2 = (
    await call(
      "directorate_diff",
      { seal, regions: [wide] },
      "directorate_auditor",
      "scoutA"
    )
  ).content;
  assert.match(a2, /continued from body line/);
  const out = (
    await call("directorate_coverage", {
      seal,
      regions: ["R1"],
      disposition: "reviewed",
      note: "looked fine",
    })
  ).content;
  assert.match(out, /R1 recorded as skimmed/);
});

test("budget: drain denies auditors not compliance; lock strips tools; role-specific budget text; release after report", async () => {
  const { S, call, sealOf, hooks } = await harness(repo());
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
        budget_minutes: 10,
      })
    ).content
  );
  const ev = (agent: string) =>
    ({
      sessionID: S("lead"),
      action: "subagent",
      resources: [agent],
      effect: "allow",
    }) as any;
  shiftClock(seal, 7);
  const e1 = ev("directorate_auditor");
  await hooks["permission.evaluate"](e1);
  assert.equal(e1.effect, "deny");
  const e2 = ev("directorate_compliance");
  await hooks["permission.evaluate"](e2);
  assert.equal(e2.effect, "allow");
  await call(
    "directorate_ledger_add",
    add(seal),
    "directorate_auditor",
    "scout"
  );
  const scoutOut = (
    await call(
      "directorate_ledger_list",
      { seal },
      "directorate_auditor",
      "scout"
    )
  ).content;
  assert.match(scoutOut, /file surviving candidates now and hand off/);
  shiftClock(seal, 11);
  const lockCtx: any = {
    sessionID: S("lead"),
    agent: "directorate_liaison",
    system: [],
    tools: {
      read: {},
      subagent: {},
      directorate_report: {},
      directorate_note: {},
      directorate_seal: {},
    },
  };
  await hooks["session.context"](lockCtx);
  assert.deepEqual(Object.keys(lockCtx.tools).sort(), [
    "directorate_note",
    "directorate_report",
  ]);
  const md = (await call("directorate_report", { seal })).content;
  assert.match(md, /time budget ran out/);
  const after: any = {
    sessionID: S("lead"),
    agent: "directorate_liaison",
    system: [],
    tools: { read: {}, subagent: {} },
  };
  await hooks["session.context"](after);
  assert.deepEqual(Object.keys(after.tools).sort(), ["read", "subagent"]);
  const e3 = ev("directorate_auditor");
  await hooks["permission.evaluate"](e3);
  assert.equal(e3.effect, "allow");
});

test("after a plugin reload, the session's unreported seal is found even after an abandon; strangers are not bound", async () => {
  const dir = repo();
  const h1 = await harness(dir, "reload");
  await h1.call("directorate_seal", {
    mode: "default",
    target: { kind: "local" },
  });
  const live = h1.sealOf(
    (
      await h1.call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
        budget_minutes: 10,
        abandon: true,
      })
    ).content
  );
  shiftClock(live, 11);
  const h2 = await harness(dir, "reload");
  const mine: any = {
    sessionID: h2.S("lead"),
    agent: "directorate_liaison",
    system: [],
    tools: { read: {}, directorate_report: {} },
  };
  await h2.hooks["session.context"](mine);
  assert.deepEqual(
    Object.keys(mine.tools),
    ["directorate_report"],
    "locked after reload"
  );
  const stranger: any = {
    sessionID: "someone-else",
    agent: "directorate_liaison",
    system: [],
    tools: { read: {} },
  };
  await h2.hooks["session.context"](stranger);
  assert.deepEqual(Object.keys(stranger.tools), ["read"]);
});

test(
  "the scoped watchdog uses Effect time and saves the report after the grace period",
  { timeout: 10_000 },
  async () => {
    const dir = repo();
    const start = Date.now();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const run = Effect.runPromiseWith(yield* Effect.context());
        const h = yield* Effect.tryPromise(() => harness(dir, undefined, run));
        const result = yield* Effect.tryPromise(() =>
          h.call("directorate_seal", {
            mode: "default",
            target: { kind: "local" },
            budget_minutes: 2,
          })
        );
        const seal = h.sealOf(result.content);
        assert.equal(Date.parse(sealJson(seal).deadline), start + 120_000);
        yield* Scope.close(h.scope, Exit.void);
        yield* TestClock.adjust("239 seconds");
        assert.equal(sealJson(seal).reportedAt, undefined);
        const reloaded = yield* Effect.tryPromise(() =>
          harness(dir, undefined, run)
        );
        yield* TestClock.adjust("30 seconds");
        assert.match(
          yield* Deferred.await(reloaded.notified),
          /<intervened\/filed> the directive.*did not report before lockdown/
        );
        assert.deepEqual(
          h.notices,
          [],
          "the closed plugin did not run the watchdog"
        );
        assert.equal(sealJson(seal).autoReported, true);
        assert.ok(Date.parse(sealJson(seal).reportedAt) >= start + 240_000);
        assert.match(
          readFileSync(join(state, seal, "report.md"), "utf8"),
          /status: \*\*partial\*\*/
        );
        yield* Scope.close(reloaded.scope, Exit.void);
      }).pipe(Effect.provide(TestClock.layer()))
    );
  }
);

test("directorate_read, directorate_grep, directorate_ls, directorate_history read the seal, not later edits", async () => {
  const dir = repo();
  const { call, sealOf } = await harness(dir);
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  await assert.rejects(
    call("directorate_ls", { seal, dir: "../outside" }),
    /must be relative to the repository/
  );
  writeFileSync(join(dir, "src/a.ts"), "rewritten\n");
  const r = (
    await call(
      "directorate_read",
      { seal, path: "src/a.ts" },
      "directorate_auditor",
      "scout"
    )
  ).content;
  assert.match(r, /sealed post-image/);
  assert.match(r, /2 export const div/);
  assert.match(
    (
      await call(
        "directorate_read",
        { seal, path: "src/a.ts", side: "old" },
        "directorate_auditor",
        "scout"
      )
    ).content,
    /1 export const a = 1/
  );
  assert.match(
    (
      await call(
        "directorate_grep",
        { seal, pattern: "export const b", fixed: true },
        "directorate_auditor",
        "scout"
      )
    ).content,
    /src\/b.ts:1:export const b = 2/
  );
  assert.match(
    (await call("directorate_ls", { seal }, "directorate_auditor", "scout"))
      .content,
    /2 files at the seal\nsrc\/a.ts\nsrc\/b.ts/
  );
  assert.match(
    (
      await call(
        "directorate_history",
        { seal, kind: "log" },
        "directorate_auditor",
        "scout"
      )
    ).content,
    /init/
  );
});

test("old-format seals in the store and hook faults never break a session", async () => {
  const old = join(state, "directorate-20200101000000-abcdef");
  mkdirSync(old, { recursive: true });
  writeFileSync(
    join(old, "seal.json"),
    JSON.stringify({
      id: "directorate-20200101000000-abcdef",
      repo: "/x",
      mode: "default",
      target: { kind: "local" },
      createdAt: new Date().toISOString(),
      deadline: new Date().toISOString(),
    })
  );
  const broken = join(state, "directorate-20200101000001-abcdef");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "seal.json"), "{not json");
  const { S, call, sealOf, hooks } = await harness(repo());
  const ev: any = {
    sessionID: S("fresh"),
    agent: "directorate_liaison",
    system: [],
    tools: { read: {} },
  };
  await hooks["session.context"](ev);
  assert.deepEqual(Object.keys(ev.tools), ["read"]);
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  assert.ok(seal);
  await hooks["tool.execute.before"]({
    tool: "subagent",
    sessionID: S("lead"),
    agent: "directorate_liaison",
    id: "x",
    input: null,
  });
  await hooks["permission.evaluate"]({
    sessionID: S("lead"),
    action: "subagent",
    resources: null,
  });
});

test("directorate_read and directorate_history ask permission for the file too, so a deny rule withholds it", async () => {
  const { call, sealOf, requests } = await harness(
    repo(),
    undefined,
    undefined,
    (r) => r.resources.includes("src/b.ts")
  );
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  assert.match(
    (await call("directorate_read", { seal, path: "./src/a.ts" })).content,
    /export const a = 2/
  );
  assert.deepEqual(
    requests.at(-1),
    { action: "directorate_read", resources: [seal, "src/a.ts"] },
    "the decoded path, beside the seal"
  );
  await assert.rejects(
    call("directorate_read", { seal, path: "src/b.ts" }),
    /directorate_read denied/
  );
  await assert.rejects(
    call("directorate_history", { seal, kind: "log", path: "src/b.ts" }),
    /directorate_history denied/
  );
});

test("directorate_diff stays inside OpenCode's output cut (50 KiB, 2,000 lines), so every region counted read was shown", async () => {
  const dir = repo();
  writeFileSync(
    join(dir, "src/wide.ts"),
    Array.from(
      { length: 1500 },
      (_, i) => `export const v${i} = "${"€".repeat(200)}"`
    ).join("\n") + "\n"
  );
  writeFileSync(join(dir, "src/tall.ts"), "\n".repeat(3000));
  const { call, sealOf } = await harness(dir);
  const seal = sealOf(
    (
      await call("directorate_seal", {
        mode: "default",
        target: { kind: "local" },
      })
    ).content
  );
  let calls = 0;
  for (
    let out = "";
    !/All regions have been read/.test(out) && calls < 200;
    calls++
  ) {
    out = (await call("directorate_diff", { seal })).content;
    assert.ok(
      Buffer.byteLength(out) <= 50 * 1024 && out.split("\n").length <= 2000,
      `call ${calls}: ${Buffer.byteLength(out)} bytes, ${out.split("\n").length} lines`
    );
  }
  const s = sealJson(seal);
  assert.equal(
    s.regions.filter((r: any) => r.ownerRead).length,
    s.regions.length
  );
  assert.ok(calls > 10, `paged in ${calls} calls`);
});
