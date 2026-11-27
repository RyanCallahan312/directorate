// directorate.json's pure functions: how two files merge, how a request resolves over them, how settings read in one
// line, and when two settings are the same or none at all.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_PANEL } from "../src/feature/dispatch/seat.ts";
import {
  describe,
  isUnset,
  merge,
  resolve,
  sameSettings,
} from "../src/feature/settings/file.ts";
import type { Settings } from "../src/feature/settings/file.ts";
import { DEFAULT_MODE } from "../src/workflow/review/request.ts";

test("merge: the project's keys override the global ones, key by key within each section", () => {
  const cases: [string, Settings, Settings, Settings][] = [
    ["both empty", {}, {}, {}],
    ["global only", { mode: "full" }, {}, { mode: "full" }],
    ["project only", {}, { mode: "full" }, { mode: "full" }],
    [
      "a top-level key",
      { default_scope: "local", mode: "full" },
      { mode: "code-quality" },
      { default_scope: "local", mode: "code-quality" },
    ],
    [
      "budgets per mode",
      { budget_minutes: { default: 10, full: 60 } },
      { budget_minutes: { full: 30 } },
      { budget_minutes: { default: 10, full: 30 } },
    ],
    [
      "panel keys",
      { panel: { enabled: true, models: [{ model: "p/a" }] } },
      { panel: { models: [{ model: "p/b", variant: "high" }] } },
      {
        panel: { enabled: true, models: [{ model: "p/b", variant: "high" }] },
      },
    ],
    [
      "an empty disabled-lens list still overrides",
      { lenses: { disabled: ["ux"] } },
      { lenses: { disabled: [] } },
      { lenses: { disabled: [] } },
    ],
  ];

  for (const [name, global, project, merged] of cases) {
    assert.deepEqual(merge(global, project), merged, name);
  }
});

test("resolve: the request over the project over the global file over Directorate defaults", () => {
  const global: Settings = {
    budget_minutes: { default: 20, full: 90 },
    mode: "full",
    panel: { enabled: true },
  };

  const project: Settings = {
    lenses: { disabled: ["docs"] },
    mode: "code-quality",
    panel: { models: [{ model: "p/a", variant: "high" }] },
  };

  const cases: [
    string,
    Settings,
    Parameters<typeof resolve>[1],
    ReturnType<typeof resolve>,
  ][] = [
    [
      "nothing set: defaults",
      {},
      {},
      {
        budgetMinutes: undefined,
        lensesOff: undefined,
        mode: DEFAULT_MODE,
        panel: undefined,
      },
    ],
    [
      "global alone",
      merge(global, {}),
      {},
      {
        budgetMinutes: 90,
        lensesOff: undefined,
        mode: "full",
        panel: DEFAULT_PANEL,
      },
    ],
    [
      "project over global",
      merge(global, project),
      {},
      {
        budgetMinutes: undefined,
        lensesOff: ["docs"],
        mode: "code-quality",
        panel: ["p/a#high"],
      },
    ],
    [
      "request over both",
      merge(global, project),
      {
        budgetMinutes: 5,
        mode: "default",
        panel: false,
      },
      {
        budgetMinutes: 5,
        lensesOff: ["docs"],
        mode: "default",
        panel: undefined,
      },
    ],
    [
      "requested mode picks its configured budget",
      merge(global, project),
      { mode: "default" },
      {
        budgetMinutes: 20,
        lensesOff: ["docs"],
        mode: "default",
        panel: ["p/a#high"],
      },
    ],
    [
      "requested panel models over configured ones, even with the panel off",
      merge(global, project),
      { panel: false, panelModels: ["p/z"] },
      {
        budgetMinutes: undefined,
        lensesOff: ["docs"],
        mode: "code-quality",
        panel: ["p/z"],
      },
    ],
    [
      "an empty disabled-lens list turns nothing off",
      { lenses: { disabled: [] } },
      {},
      {
        budgetMinutes: undefined,
        lensesOff: undefined,
        mode: DEFAULT_MODE,
        panel: undefined,
      },
    ],
  ];

  for (const [name, settings, input, resolved] of cases) {
    assert.deepEqual(resolve(settings, input), resolved, name);
  }
});

test("describe: one line of what is set, or nothing", () => {
  const cases: [Settings, string | undefined][] = [
    [{}, undefined],
    [{ budget_minutes: {}, panel: {} }, undefined],
    [{ lenses: { disabled: [] } }, undefined],
    [{ panel: { enabled: false } }, "panel off"],
    [
      {
        budget_minutes: { default: 10, full: 30 },
        default_scope: "local",
        lenses: { disabled: ["ux", "docs"] },
        mode: "full",
        panel: { enabled: true, models: [{ model: "p/a", variant: "x" }] },
      },
      "mode full · scope local · panel on · panel models p/a#x · budgets default 10 min, full 30 min · lenses off ux, docs",
    ],
  ];

  for (const [settings, line] of cases) {
    assert.equal(describe(settings), line, JSON.stringify(settings));
  }
});

test("sameSettings and isUnset ignore empty sections but not an explicit empty lens list", () => {
  const same: [Settings, Settings, boolean][] = [
    [{}, {}, true],
    [{}, { panel: {} }, true],
    [{ budget_minutes: {} }, { lenses: {} }, true],
    [{}, { lenses: { disabled: [] } }, false],
    [{ mode: "full" }, { mode: "full" }, true],
    [{ mode: "full" }, { mode: "default" }, false],
    [
      { panel: { models: [{ model: "p/a" }, { model: "p/b" }] } },
      { panel: { models: [{ model: "p/b" }, { model: "p/a" }] } },
      false,
    ],
  ];

  for (const [a, b, expected] of same) {
    assert.equal(
      sameSettings(a, b),
      expected,
      `${JSON.stringify(a)} vs ${JSON.stringify(b)}`
    );
  }

  const unset: [Settings, boolean][] = [
    [{}, true],
    [{ panel: {} }, true],
    [{ budget_minutes: {}, lenses: {} }, true],
    [{ lenses: { disabled: [] } }, false],
    [{ panel: { enabled: false } }, false],
  ];

  for (const [settings, expected] of unset) {
    assert.equal(isUnset(settings), expected, JSON.stringify(settings));
  }
});
