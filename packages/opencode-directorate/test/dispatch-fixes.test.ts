// Dispatch's hooks and session-event consumer act only on what the door committed: a launch or a child link the seal
// failed to save is neither sent on nor bound.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

import type { Plugin } from "@opencode/plugin/effect";
import {
  ConfigProvider,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";

import { Actor } from "../src/feature/agents/agent.ts";
import { registerDispatch } from "../src/feature/dispatch/dispatch.ts";
import { platformLayer } from "../src/index.ts";
import { SessionIdSchema } from "../src/platform/host-id.ts";
import { Host } from "../src/platform/platform.ts";
import { Records } from "../src/records/records.ts";
import type { SealId } from "../src/seal/seal-id.ts";
import { sealLayer, Sessions } from "../src/seal/seal.ts";
import { createSeal } from "../src/workflow/review/lifecycle.ts";
import { expectWarnings, runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const present = <T>(value: T | null | undefined): T => {
  assert.ok(value !== undefined && value !== null, "expected a value");

  return value;
};

const dirs: string[] = [];

after(() => {
  for (const d of dirs) {
    rmSync(d, { force: true, recursive: true });
  }
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);

  return dir;
};

const state = temp("directorate-state-");

const testPlatform = platformLayer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({ DIRECTORATE_STATE_DIR: state })
    )
  )
);

const repo = () => {
  const dir = temp("directorate-repo-");

  const g = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });

  g("init", "-q", "-b", "main");
  g("config", "core.autocrlf", "false");
  g("config", "user.email", "t@e.com");
  g("config", "user.name", "t");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1\n");
  g("add", ".");
  g("commit", "-qm", "init");
  writeFileSync(path.join(dir, "src/a.ts"), "export const a = 2\n");

  return dir;
};

const LEAD = SessionIdSchema.make("ses_lead");
const lead = Actor.make({ agent: "directorate_liaison", session: LEAD });

/** The Liaison's subagent call `id`, as the subagent tool's execute.before sees it. */
const subagentCall = (id: string) => ({
  agent: "directorate_liaison",
  id,
  input: {
    agent: "directorate_auditor",
    description: "probe",
    prompt: "question: q",
  },
  sessionID: LEAD,
  tool: "subagent",
});

/** The subagent tool returning for call `id`, naming the child session it started. */
const subagentReturned = (id: string, session: string) => ({
  id,
  result: {
    content: `<subagent sessionID="${session}" state="running">`,
    metadata: { metadata: { sessionID: session, status: "running" } },
  },
  sessionID: LEAD,
  status: "completed",
  tool: "subagent",
});

/** session.created's data for an Auditor child of LEAD, titled as its launch. */
const childCreated = (session: string, title: string) => ({
  agent: "directorate_auditor",
  parentID: LEAD,
  sessionID: session,
  title,
});

type ChildCreated = ReturnType<typeof childCreated>;

interface BusEvent {
  created: number;
  data: ChildCreated;
  type: string;
}

/** No session the test did not create exists. */
const SessionNotFound = Schema.TaggedStruct("Session.NotFoundError", {
  sessionID: Schema.String,
});

type HookHandler = (
  event: ReturnType<typeof subagentCall> | ReturnType<typeof subagentReturned>
) => Effect.Effect<void>;

/** A host with only what dispatch reaches: tool hooks, one event bus served an event per pull, and sessions. */
const fakeHost = Effect.gen(function* fakeHost() {
  const hooks = new Map<string, HookHandler>();

  const queue = yield* Queue.unbounded<{
    event: BusEvent;
    handled: Deferred.Deferred<true>;
  }>();

  const current = yield* Ref.make(Option.none<Deferred.Deferred<true>>());

  // The consumer asking for the next event means it finished the previous one.
  const next = Effect.gen(function* next() {
    const previous = yield* Ref.get(current);

    if (Option.isSome(previous)) {
      yield* Deferred.succeed(previous.value, true);
    }

    const item = yield* Queue.take(queue);
    yield* Ref.set(current, Option.some(item.handled));

    return item.event;
  });

  const ctx = {
    event: { subscribe: () => Stream.fromEffectRepeat(next) },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.fail(SessionNotFound.make({ sessionID })),
      instructions: {
        entry: {
          list: () => Effect.succeed([]),
          put: () => Effect.void,
          remove: () => Effect.void,
        },
      },
      interrupt: () => Effect.void,
    },
    tool: {
      hook: (name: string, handler: HookHandler) =>
        Effect.sync(() => {
          hooks.set(name, handler);
        }),
    },
  };

  /** Resolves once the consumer has handled the event. */
  const emit = (type: string, data: ChildCreated) =>
    Effect.gen(function* emitted() {
      const handled = yield* Deferred.make<true>();
      yield* Queue.offer(queue, { event: { created: 0, data, type }, handled });
      yield* Deferred.await(handled);
    });

  // SAFETY: dispatch and Sessions touch only the host domains above.
  const host = Object.assign(Object.create(null) as Plugin.Context, ctx);

  return {
    emit,
    hook: (name: string) => present(hooks.get(name)),
    host,
  };
});

/** Records whose seal.json writes fail while `failing` holds, as a full disk or a revoked permission would. */
const failingRecords = (failing: Ref.Ref<boolean>) =>
  Effect.gen(function* recordsFailingOnDemand() {
    const real = yield* FileSystem.FileSystem;

    const fs = FileSystem.FileSystem.of({
      ...real,
      rename: (from, to) =>
        Effect.flatMap(Ref.get(failing), (fail) =>
          fail && to.endsWith("seal.json")
            ? Effect.fail(
                PlatformError.badArgument({
                  description: `refused to replace ${to}`,
                  method: "rename",
                  module: "FileSystem",
                })
              )
            : real.rename(from, to)
        ),
    });

    return yield* Records.pipe(
      Effect.provide(Layer.fresh(Records.layer)),
      Effect.provideService(FileSystem.FileSystem, fs)
    );
  });

/** A sealed review owned by LEAD, with dispatch registered over a door whose seal saves fail on demand. */
const withDispatch = <A, E>(
  body: (
    env: Effect.Success<typeof fakeHost> & {
      failing: Ref.Ref<boolean>;
      seal: SealId;
    }
  ) => Effect.Effect<A, E, Sessions | Records>
) =>
  runPromise(
    Effect.gen(function* dispatchTest() {
      const seal = yield* createSeal({
        mode: "default",
        owner: lead,
        repo: repo(),
        target: { kind: "local" },
      });

      const failing = yield* Ref.make(false);
      const records = yield* failingRecords(failing);
      const fake = yield* fakeHost;

      return yield* Effect.gen(function* registered() {
        const sessions = yield* Sessions;
        yield* sessions.bind(LEAD, seal.id);
        yield* registerDispatch(() => Effect.void);

        return yield* body({ ...fake, failing, seal: seal.id });
      }).pipe(
        Effect.scoped,
        Effect.provide(sealLayer),
        Effect.provideService(Records, records),
        Effect.provideService(Host, fake.host)
      );
    }).pipe(Effect.provide(testPlatform))
  );

test("a launch the seal failed to save is not sent on: its input is unchanged and no run is recorded", () => {
  expectWarnings(/could not register \S+ in [\s\S]*refused to replace/u);

  return withDispatch(({ failing, hook, seal }) =>
    Effect.gen(function* failedLaunch() {
      const store = yield* Records;
      const rejected = subagentCall("c-rejected");

      yield* Ref.set(failing, true);
      yield* hook("execute.before")(rejected);
      yield* Ref.set(failing, false);

      assert.deepEqual(rejected.input, subagentCall("c-rejected").input);
      assert.deepEqual((yield* store.load(seal)).children, []);

      const saved = subagentCall("c-saved");
      yield* hook("execute.before")(saved);

      assert.equal(saved.input.description, "probe · c-saved");
      assert.deepEqual(
        (yield* store.load(seal)).children.map((c) => c.call),
        ["c-saved"]
      );
    })
  );
});

test("a child is bound to its review only once the seal saved its claim", () => {
  expectWarnings(/could not link \S+ ses_child to [\s\S]*refused to replace/u);

  return withDispatch(({ emit, failing, hook, seal }) =>
    Effect.gen(function* claim() {
      const sessions = yield* Sessions;
      const store = yield* Records;
      yield* hook("execute.before")(subagentCall("c-1"));

      yield* Ref.set(failing, true);
      yield* emit("session.created", childCreated("ses_child", "probe · c-1"));
      yield* Ref.set(failing, false);

      assert.equal(
        yield* sessions.boundTo(SessionIdSchema.make("ses_child")),
        undefined
      );
      assert.equal((yield* store.load(seal)).children[0]?.session, undefined);

      yield* emit("session.created", childCreated("ses_child", "probe · c-1"));

      assert.equal(
        yield* sessions.boundTo(SessionIdSchema.make("ses_child")),
        seal
      );
      assert.equal((yield* store.load(seal)).children[0]?.session, "ses_child");
    })
  );
});

test("a subagent result the seal failed to save does not bind the child it names", () => {
  expectWarnings(
    /could not record subagent result in [\s\S]*refused to replace/u
  );

  return withDispatch(({ failing, hook, seal }) =>
    Effect.gen(function* result() {
      const sessions = yield* Sessions;
      yield* hook("execute.before")(subagentCall("c-1"));

      yield* Ref.set(failing, true);
      yield* hook("execute.after")(subagentReturned("c-1", "ses_missed"));
      yield* Ref.set(failing, false);

      assert.equal(
        yield* sessions.boundTo(SessionIdSchema.make("ses_missed")),
        undefined
      );

      yield* hook("execute.after")(subagentReturned("c-1", "ses_missed"));

      assert.equal(
        yield* sessions.boundTo(SessionIdSchema.make("ses_missed")),
        seal
      );
    })
  );
});
