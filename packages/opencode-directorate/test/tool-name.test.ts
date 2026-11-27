// The door's lockdown check and its NotOwner and Lockdown refusals read only the name a ToolCall carries, so every tool
// must hand the door the name it registered under. The adapter hands each body that name; this registers every tool,
// as the plugin does, against a door that records what reaches it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

import type { Plugin } from "@opencode/plugin/effect";
import { Agent } from "@opencode/schema/agent";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Tool } from "@opencode/schema/tool";
import { ConfigProvider, Effect, Function, Layer, Schema } from "effect";

import { waitTool } from "../src/feature/dispatch/dispatch.ts";
import { ledgerTools } from "../src/feature/ledger/ledger.ts";
import { registerReport } from "../src/feature/report/report.ts";
import { configureTool } from "../src/feature/settings/settings.ts";
import { platformLayer } from "../src/index.ts";
import type { Platform } from "../src/index.ts";
import { adapter, Host, ToolCatalog } from "../src/platform/platform.ts";
import { ActiveSeal, exportTools } from "../src/records/records.ts";
import { readTools, Sessions } from "../src/seal/seal.ts";
import type { ToolCall } from "../src/seal/sessions.ts";
import { reviewTools } from "../src/workflow/review/review.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const state = mkdtempSync(path.join(tmpdir(), "directorate-tool-name-"));

after(() => {
  rmSync(state, { force: true, recursive: true });
});

/** The services tool bodies run with, as the composition root names them. */
type Services = Platform | Host | Sessions | ActiveSeal;

type ToolEditor = Parameters<
  Parameters<Plugin.Context["tool"]["transform"]>[0]
>[0];

const SEAL = "directorate-20260101000000-abcdef";

/** Input each door-guarded tool decodes, so its body runs as far as the door. */
const guarded = new Map(
  Object.entries({
    directorate_coverage: {
      disposition: "skipped",
      note: "generated",
      regions: ["r1"],
      seal: SEAL,
    },
    directorate_diff: { seal: SEAL },
    directorate_ledger_add: {
      consequence: "c",
      evidence: ["a.ts:1"],
      kind: "defect",
      lens: "correctness",
      line: 1,
      path: "a.ts",
      quote: "const value = 1;",
      seal: SEAL,
      severity: "minor",
      trigger: "t",
    },
    directorate_ledger_verdict: {
      evidence: ["a.ts:1"],
      id: "e1",
      rationale: "r",
      seal: SEAL,
      verdict: "refuted",
    },
    directorate_note: { kind: "limit", seal: SEAL, text: "t" },
    directorate_refresh: { seal: SEAL },
    directorate_report: { seal: SEAL },
    directorate_wait: { seal: SEAL },
  })
);

test("every door-guarded tool hands the door the name it registered under", async () => {
  const reached: { call: ToolCall; tool: string }[] = [];
  const registered: Tool.Info[] = [];
  let running = "";

  /** Records the call and stops: what the tool body did before the door is all this test reads. */
  const door = (_sealId: string, call: ToolCall) =>
    Effect.sync(() => reached.push({ call, tool: running })).pipe(
      Effect.andThen(Effect.die("stopped at the door"))
    );

  // SAFETY: tool bodies reach Sessions only through the door; any other method they touch is a defect the test ignores.
  const sessions = Object.assign(Object.create(null) as Sessions["Service"], {
    mutate: door,
    read: door,
  });

  // SAFETY: registration and the adapter use only permission.assert; nothing here registers hooks.
  const host = Object.assign(Object.create(null) as Plugin.Context, {
    permission: { assert: () => Effect.void },
  });

  const layer = Layer.mergeAll(
    Layer.succeed(Sessions, sessions),
    Layer.succeed(Host, host),
    Layer.succeed(
      ActiveSeal,
      ActiveSeal.of({
        active: () => Effect.undefined,
        directory: () => Effect.undefined,
      })
    )
  ).pipe(
    Layer.provideMerge(
      platformLayer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              DIRECTORATE_SETTINGS: path.join(state, "directorate.json"),
              DIRECTORATE_STATE_DIR: state,
            })
          )
        )
      )
    )
  );

  await runPromise(
    Effect.gen(function* registerEvery() {
      const { tools } = yield* adapter<Services>();

      const report = yield* registerReport(
        Function.constVoid,
        () => Effect.void
      );

      const sealTools = yield* reviewTools(
        report.autoReport,
        () => Effect.void
      );

      // The composition root's registrations, in its order.
      const toolList = yield* tools((tool) => {
        readTools(tool);
        ledgerTools(tool);
        configureTool(tool);
        exportTools(tool);
        sealTools(tool);
        report.reportTool(tool);
        waitTool(tool);
      });

      // SAFETY: the adapter only adds tools.
      toolList(
        Object.assign(Object.create(null) as ToolEditor, {
          add: (definition: Tool.Info) => registered.push(definition),
        })
      );

      for (const definition of registered) {
        running = definition.name;

        // Every input here decodes to itself, so the body gets it as the host would hand it over.
        yield* definition
          .execute(guarded.get(definition.name) ?? { seal: SEAL }, {
            agent: Agent.ID.make("directorate_liaison"),
            id: Tool.CallID.make("c"),
            messageID: SessionMessage.ID.make("msg_m"),
            progress: () => Effect.void,
            sessionID: Session.ID.make("ses_lead"),
          })
          .pipe(Effect.exit);
      }
    }).pipe(Effect.provide(layer))
  );

  const names = registered.map(({ name }) => name);

  for (const name of guarded.keys()) {
    assert.ok(names.includes(name), `${name} is registered`);
  }

  assert.deepEqual(
    reached.map(({ tool }) => tool),
    names.filter((name) => guarded.has(name))
  );

  for (const { call, tool } of reached) {
    assert.equal(call.tool, tool);
  }
});

test("the tool transform registers once and adds the same tools, in order, to every editor", async () => {
  let registrations = 0;
  const editors: Tool.Info[][] = [[], []];

  // SAFETY: the adapter uses only permission.assert.
  const host = Object.assign(Object.create(null) as Plugin.Context, {
    permission: { assert: () => Effect.void },
  });

  const replies = await runPromise(
    Effect.gen(function* transformTwice() {
      const { tools } = yield* adapter<never>();

      const toolList = yield* tools((tool) => {
        registrations += 1;

        for (const name of ["directorate_one", "directorate_two"]) {
          tool({
            description: name,
            *execute(_, _c, registered) {
              return yield* Effect.succeed({ content: registered });
            },
            input: Schema.Struct({}),
            name,
          });
        }
      });

      for (const registered of editors) {
        // SAFETY: the adapter only adds tools.
        toolList(
          Object.assign(Object.create(null) as ToolEditor, {
            add: (definition: Tool.Info) => registered.push(definition),
          })
        );
      }

      return yield* Effect.forEach(editors.flat(), (definition) =>
        definition
          .execute(
            {},
            {
              agent: Agent.ID.make("build"),
              id: Tool.CallID.make("c"),
              messageID: SessionMessage.ID.make("msg_m"),
              progress: () => Effect.void,
              sessionID: Session.ID.make("ses_lead"),
            }
          )
          .pipe(Effect.map((reply) => String(reply.content)))
      );
    }).pipe(
      Effect.provide(Layer.merge(Layer.succeed(Host, host), ToolCatalog.layer))
    )
  );

  const [first = [], second = []] = editors;

  assert.equal(registrations, 1);
  assert.deepEqual(
    second.map(({ name }) => name),
    ["directorate_one", "directorate_two"]
  );
  assert.deepEqual(
    first.map(({ name }) => name),
    second.map(({ name }) => name)
  );
  assert.ok(first.every((definition, i) => definition !== second[i]));
  assert.deepEqual(replies, [
    "directorate_one",
    "directorate_two",
    "directorate_one",
    "directorate_two",
  ]);
});
