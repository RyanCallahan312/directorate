// /directorate-configure's walk against scripted dialogs and a scripted settings RPC: the scope picker without a global
// file, why a save was refused, a file that changed under the dialog, and how the host adapter ends a run.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Effect } from "effect";

import {
  configureFromHost,
  fromHost,
  rpcBackend,
} from "../src/feature/settings/configure-client.ts";
import {
  backend,
  configure,
  NO_GLOBAL_FILE,
  SettingsError,
} from "../src/feature/settings/configure-flow.ts";
import type { Dialogs } from "../src/feature/settings/configure-flow.ts";
import type { Settings } from "../src/feature/settings/file.ts";
import type { SettingsView, WriteInput } from "../src/feature/settings/rpc.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

interface Option {
  title: string;
  description?: string;
  disabled?: boolean;
}

interface Seen {
  title: string;
  options: Option[];
}

/** Dialogs that answer each select with the option of the next title (undefined backs out) and record what they showed. */
const scripted = (answers: (string | undefined)[], prompts: string[] = []) => {
  const seen: Seen[] = [];
  const alerts: string[] = [];

  const dialogs: Dialogs = {
    alert: (a) =>
      Effect.sync(() => {
        alerts.push(a.description);
      }),
    confirm: () => Effect.succeed(true),
    path: (p) => p,
    prompt: () => Effect.succeed(prompts.shift()),
    select: (o) =>
      Effect.sync(() => {
        seen.push({ options: [...o.options], title: o.title });
        const answer = answers.shift();
        const choice = o.options.find((c) => c.title === answer);

        assert.ok(
          answer === undefined || (choice && !choice.disabled),
          `"${answer}" not offered in "${o.title}"`
        );

        return choice?.value;
      }),
    toast: () => Effect.void,
  };

  return { alerts, dialogs, left: () => answers.length, seen };
};

const view = (global: Settings, files: SettingsView["files"]) => ({
  effective: "",
  files,
  global,
  models: [{ name: "A", ref: "p/a", variants: [] }],
  project: {},
});

const GLOBAL = "/g/directorate.json";

test("without a global config directory the Global Charter is shown but cannot be picked", async () => {
  const { dialogs, seen } = scripted([undefined]);

  await runPromise(
    configure(
      dialogs,
      backend(
        Effect.succeed(view({}, { project: "/p/.opencode/x.json" })),
        () => Effect.die("no write expected")
      )
    )
  );

  const global = seen[0]?.options.find((o) => o.title === "Global Charter");
  assert.equal(global?.disabled, true);
  assert.equal(global?.description, NO_GLOBAL_FILE);
  assert.equal(
    seen[0]?.options.find((o) => o.title.startsWith("Local Jurisdiction"))
      ?.disabled,
    undefined
  );
});

test("a file changed under the dialog is read again and the walk continues from it", async () => {
  const reads = [
    view({ mode: "full" }, { global: GLOBAL }),
    view({ mode: "code-quality" }, { global: GLOBAL }),
  ];

  const writes: WriteInput[] = [];

  const { alerts, dialogs, left, seen } = scripted([
    "Global Charter",
    "Default mode",
    "default",
    "Save",
    // Back at the menu, showing the file as it is now.
    "Default mode",
    "default",
    "Save",
  ]);

  await runPromise(
    configure(
      dialogs,
      backend(
        Effect.sync(() => reads.shift() ?? assert.fail("read too often")),
        (input) =>
          Effect.suspend(() => {
            writes.push(input);

            return writes.length === 1
              ? Effect.fail(
                  new SettingsError({ message: "changed", reason: "changed" })
                )
              : Effect.succeed({ effective: "", path: GLOBAL, removed: false });
          })
      )
    )
  );

  assert.equal(left(), 0);
  assert.equal(reads.length, 0, "the settings were read again");
  assert.match(alerts[0] ?? "", /changed since it was read/u);

  const menus = seen.filter((s) =>
    s.title.startsWith("The Directorate // Global")
  );

  assert.equal(
    menus.at(-1)?.options.find((o) => o.title === "Default mode")?.description,
    "default"
  );
  assert.equal(
    menus
      .find((m, i) => i > 0 && !m.title.includes("unsaved"))
      ?.options.find((o) => o.title === "Default mode")?.description,
    "code-quality",
    "after the reload the menu starts from the fresh file"
  );
  assert.deepEqual(
    writes.map((w) => w.previous),
    [{ mode: "full" }, { mode: "code-quality" }],
    "the second save names the fresh file as its previous"
  );
});

test("a refused save keeps the draft to fix, and saves against the same file", async () => {
  const writes: WriteInput[] = [];

  const { alerts, dialogs, left } = scripted([
    "Global Charter",
    "Default mode",
    "full",
    "Save",
    "Save",
  ]);

  await runPromise(
    configure(
      dialogs,
      backend(Effect.succeed(view({}, { global: GLOBAL })), (input) =>
        Effect.suspend(() => {
          writes.push(input);

          return writes.length === 1
            ? Effect.fail(
                new SettingsError({
                  message: "Settings are busy.",
                  reason: "busy",
                })
              )
            : Effect.succeed({ effective: "", path: GLOBAL, removed: false });
        })
      )
    )
  );

  assert.equal(left(), 0);
  assert.deepEqual(alerts, ["Settings are busy."]);
  assert.deepEqual(writes, [
    { previous: {}, scope: "global", settings: { mode: "full" } },
    { previous: {}, scope: "global", settings: { mode: "full" } },
  ]);
});

test("editors leave no empty sections: removing every seat and budget writes nothing for them", async () => {
  let written: Settings | undefined;

  const { dialogs, left } = scripted(
    [
      "Global Charter",
      "Directorate Seats (panel models)",
      "Remove all",
      undefined,
      "Time budgets",
      "full",
      undefined,
      "Save",
    ],
    ["unset"]
  );

  await runPromise(
    configure(
      dialogs,
      backend(
        Effect.succeed(
          view(
            {
              budget_minutes: { full: 30 },
              mode: "full",
              panel: { models: [{ model: "p/a" }] },
            },
            { global: GLOBAL }
          )
        ),
        (input) =>
          Effect.sync(() => {
            written = input.settings;

            return { effective: "", path: GLOBAL, removed: false };
          })
      )
    )
  );

  assert.equal(left(), 0);
  assert.deepEqual(written, { mode: "full" });
});

test("choosing Model default seats the model with no variant, and clears a seat's variant", async () => {
  let written: Settings | undefined;

  const { dialogs, left, seen } = scripted([
    "Global Charter",
    "Directorate Seats (panel models)",
    "Add a Seat…",
    "p/b",
    "Model default",
    "p/b",
    "Thinking level…",
    "Model default",
    undefined,
    "Save",
  ]);

  await runPromise(
    configure(
      dialogs,
      backend(
        Effect.succeed({
          ...view(
            { panel: { models: [{ model: "p/b", variant: "high" }] } },
            { global: GLOBAL }
          ),
          models: [{ name: "B", ref: "p/b", variants: ["high", "xhigh"] }],
        }),
        (input) =>
          Effect.sync(() => {
            written = input.settings;

            return { effective: "", path: GLOBAL, removed: false };
          })
      )
    )
  );

  assert.equal(left(), 0);
  assert.deepEqual(written, {
    panel: { models: [{ model: "p/b" }, { model: "p/b" }] },
  });
  assert.deepEqual(
    seen
      .filter((s) => s.title.startsWith("Thinking level"))
      .map((s) => s.options.map((o) => o.title)),
    [
      ["high", "xhigh", "Model default"],
      ["high", "xhigh", "Model default"],
    ]
  );
});

test("a settings RPC rejection keeps its reason; other host failures have none", async () => {
  const rejected = await runPromise(
    Effect.flip(
      fromHost(() =>
        Promise.reject(
          Object.assign(new Error("Settings changed"), {
            data: { reason: "changed" },
            type: "rejected",
          })
        )
      )
    )
  );

  assert.equal(rejected.reason, "changed");
  assert.equal(rejected.message, "Settings changed");

  const other = await runPromise(
    Effect.flip(fromHost(() => Promise.reject(new Error("offline"))))
  );

  assert.equal(other.reason, undefined);
  assert.equal(other.message, "offline");
});

test("rpcBackend calls the settings RPC with the same options each time", async () => {
  const calls: unknown[] = [];

  const b = rpcBackend(
    {
      settings: (_, options: { location: string }) => {
        calls.push(["settings", options]);

        return Promise.resolve(view({}, { global: GLOBAL }));
      },
      write: (input, options) => {
        calls.push(["write", input.scope, options]);

        return Promise.resolve({ effective: "", path: GLOBAL, removed: true });
      },
    },
    { location: "/here" }
  );

  await runPromise(b.settings);
  await runPromise(b.write({ previous: {}, scope: "global", settings: {} }));
  assert.deepEqual(calls, [
    ["settings", { location: "/here" }],
    ["write", "global", { location: "/here" }],
  ]);
});

test("configureFromHost ends an interrupted walk quietly, with or without a signal, and throws other failures readably", async () => {
  const { dialogs } = scripted([]);

  await configureFromHost(
    dialogs,
    backend(Effect.interrupt, () => Effect.interrupt)
  );

  const boom = new Error("boom");

  await assert.rejects(
    configureFromHost(
      dialogs,
      backend(Effect.die(boom), () => Effect.interrupt)
    ),
    (error: Error) => {
      assert.match(error.message, /boom/u);
      assert.equal(error.cause, boom);

      return true;
    }
  );
});
