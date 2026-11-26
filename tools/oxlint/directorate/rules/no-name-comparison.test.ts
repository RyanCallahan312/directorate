import { RuleTester } from "oxlint/plugins-dev";

import { noNameComparisonRule } from "./no-name-comparison.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const error = { messageId: "nameComparison" };

tester.run("directorate/no-name-comparison", noNameComparisonRule, {
  invalid: [
    {
      code: 'const done = entry.status === "confirmed";',
      errors: [error],
      name: "strict equality with a name",
    },
    {
      code: 'const open = "open" !== entry.status;',
      errors: [error],
      name: "name on the left",
    },
    {
      code: "const done = phase === `locked`;",
      errors: [error],
      name: "expression-free template",
    },
    {
      code: 'const created = event.type == "session.created";',
      errors: [error],
      name: "loose equality with a dotted name",
    },
    {
      code: 'switch (mode) { case "code-quality": break; default: break; }',
      errors: [error],
      name: "switch case",
    },
    {
      code: 'const stops = ["pause", "stop"].includes(action);',
      errors: [error],
      name: "membership in an array of names",
    },
  ],
  valid: [
    'const blank = text === "";',
    'const up = rel === "..";',
    'const posix = sep !== "/";',
    'const binary = line === "GIT binary patch";',
    'const link = mode === "120000";',
    "const same = a === b;",
    // oxlint-disable-next-line no-template-curly-in-string -- the rule under test reads this source text
    "const tagged = name === `${prefix}-x`;",
    "const done = isConfirmed(entry);",
    'const picked = Match.value(event).pipe(Match.when({ type: "idle" }, () => 1), Match.orElse(() => 0));',
    'const isLocked = Schema.is(PhaseSchema.pick(["locked"]));',
    'const found = ["a", other].includes(x);',
    "switch (count) { case 1: break; default: break; }",
  ],
});
