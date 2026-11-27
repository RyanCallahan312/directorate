import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { AgentIdSchema } from "./packages/opencode-directorate/src/feature/agents/agent.ts";

export default defineConfig({
  env: core.env,
  extends: [core],
  ignorePatterns: [
    ...core.ignorePatterns,
    "tools/oxlint/anti-slop/**",
    ".agents/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
    { name: "directorate", specifier: "./tools/oxlint/directorate/index.ts" },
  ],
  overrides: [
    {
      // The modeling rules of packages/opencode-directorate/src/AGENTS.md that a syntax tree can check.
      files: ["packages/opencode-directorate/src/**/*.ts"],
      rules: {
        "directorate/no-agent-id-in-string": [
          "error",
          {
            ids: [...AgentIdSchema.literals],
            owner: "feature/agents/agent.ts",
          },
        ],
        "directorate/no-handwritten-object-type": "error",
        "directorate/no-name-comparison": "error",
      },
    },
  ],
  rules: {
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    // Replaces unicorn/throw-new-error, which reports Schema.TaggedError<E>() and Schema.Error<E>().
    "anti-slop-effect/throw-new-error": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    // Slices colocate Schema.Class / Schema.TaggedClass / Schema.TaggedError definitions.
    "max-classes-per-file": "off",
    "oxc/no-accumulating-spread": "error",
    "unicorn/throw-new-error": "off",
  },
});
