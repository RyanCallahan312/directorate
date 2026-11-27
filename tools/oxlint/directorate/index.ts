// Directorate's own Oxlint rules: the modeling rules of packages/opencode-directorate/src/AGENTS.md that a syntax tree can
// check. The root Oxlint config enables them for that package's src/ only.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { noAgentIdInStringRule } from "./rules/no-agent-id-in-string.ts";
import { noHandwrittenObjectTypeRule } from "./rules/no-handwritten-object-type.ts";
import { noNameComparisonRule } from "./rules/no-name-comparison.ts";

const directoratePlugin = eslintCompatPlugin({
  meta: { name: "directorate" },
  rules: {
    "no-agent-id-in-string": noAgentIdInStringRule,
    "no-handwritten-object-type": noHandwrittenObjectTypeRule,
    "no-name-comparison": noNameComparisonRule,
  },
});

export default directoratePlugin;
