import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Effect, Result, Schema } from "effect";

import { backend, configure } from "../src/feature/settings/configure-flow.ts";
import type { Dialogs } from "../src/feature/settings/configure-flow.ts";
import { SettingsSchema } from "../src/feature/settings/file.ts";
import type { Settings } from "../src/feature/settings/file.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const present = <T>(value: T | undefined): T => {
  assert.ok(value !== undefined, "expected a value");

  return value;
};

/**
 * Walks /directorate-configure's budget editor once: global scope, Time budgets, the default mode, `text`, then back out
 * and Save. Returns what was written (undefined when nothing changed) and the error toasts shown.
 */
const enterBudget = async (text: string, global: Settings = {}) => {
  const answers = ["global", "budgets", "default", undefined, "save"];
  const errors: string[] = [];
  let written: Settings | undefined;

  const dialog: Dialogs = {
    alert: () => Effect.void,
    confirm: () => Effect.succeed(true),
    path: (p) => p,
    prompt: () => Effect.succeed(text),
    select: (o) => {
      const answer = answers.shift();

      return Effect.succeed(
        o.options.find((c) => String(c.value) === answer)?.value
      );
    },
    toast: (t) =>
      Effect.sync(() => {
        if (t.variant === "error") {
          errors.push(t.description);
        }
      }),
  };

  const view = {
    effective: "",
    files: { global: "/g/directorate.json" },
    global,
    models: [],
    project: {},
  };

  await runPromise(
    configure(
      dialog,
      backend(Effect.succeed(view), (input) =>
        Effect.sync(() => {
          written = input.settings;

          return { effective: "", path: "/g/directorate.json", removed: false };
        })
      )
    )
  );

  return { errors, written };
};

const decodes = (minutes: number) =>
  Result.isSuccess(
    Schema.decodeResult(SettingsSchema)({
      budget_minutes: { default: minutes },
    })
  );

test("the settings dialog accepts exactly the budgets directorate.json's decoder accepts", async () => {
  const values = [2, 2.5, 240, 1.99, 0, -5, 241, 1000, Number.NaN];

  const walks = await Promise.all(
    values.map((minutes) => enterBudget(String(minutes)))
  );

  for (const [i, { errors, written }] of walks.entries()) {
    const minutes = present(values[i]);
    const accepted = written?.budget_minutes?.default === minutes;

    assert.equal(accepted, decodes(minutes), `${minutes} minutes`);
    assert.equal(errors.length, accepted ? 0 : 1, `${minutes} minutes`);

    if (!accepted) {
      assert.match(present(errors[0]), /is not 2–240 minutes/u);
    }
  }
});

test("the settings dialog's 'unset' drops a budget without validating it", async () => {
  const { errors, written } = await enterBudget("unset", {
    budget_minutes: { default: 30, full: 60 },
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(written?.budget_minutes, { full: 60 });
});
