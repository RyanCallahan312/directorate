import { RuleTester } from "oxlint/plugins-dev";

import { noAgentIdInStringRule } from "./no-agent-id-in-string.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const options = [
  {
    ids: ["directorate_liaison", "directorate_seat"],
    owner: "feature/agents/agent.ts",
  },
];

const error = { messageId: "agentIdInString" };

tester.run("directorate/no-agent-id-in-string", noAgentIdInStringRule, {
  invalid: [
    {
      code: 'const text = "Only directorate_liaison runs a review.";',
      errors: [error],
      name: "id in a string",
      options,
    },
    {
      // oxlint-disable-next-line no-template-curly-in-string -- the rule under test reads this source text
      code: "const text = `launch a new directorate_seat for ${model}`;",
      errors: [error],
      name: "id in a template",
      options,
    },
    {
      code: 'const id = "directorate_liaison";',
      errors: [error],
      filename: "src/feature/agents/access.ts",
      name: "bare id outside the owner",
      options,
    },
  ],
  valid: [
    {
      // oxlint-disable-next-line no-template-curly-in-string -- the rule under test reads this source text
      code: "const text = `Only ${Liaison.id} runs a review.`;",
      options,
    },
    {
      code: 'const tool = "directorate_seal";',
      options,
    },
    {
      code: 'const id = "directorate_liaison";',
      filename: "src/feature/agents/agent.ts",
      options,
    },
    'const text = "Only directorate_liaison runs a review.";',
  ],
});
