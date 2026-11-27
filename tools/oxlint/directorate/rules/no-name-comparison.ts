import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { Predicate } from "effect";

/** A word-like literal is a name: a member of some closed set. Anything else ("", "..", "/", text with spaces) is text. */
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

const EQUALITY = new Set(["===", "!==", "==", "!="]);

/** The string a literal or an expression-free template spells, if the node is one. */
const spelled = (node: ESTree.Node) => {
  if (node.type === "Literal") {
    return Predicate.isString(node.value) ? node.value : undefined;
  }

  return node.type === "TemplateLiteral" && node.expressions.length === 0
    ? (node.quasis[0]?.value.cooked ?? undefined)
    : undefined;
};

const isName = (node: ESTree.Node) => {
  const text = spelled(node);

  return text !== undefined && NAME.test(text);
};

/** Ban branching on a name by raw comparison: `x === "name"`, `case "name":`, and `["a", "b"].includes(x)`. */
export const noNameComparisonRule = defineRule({
  createOnce(context) {
    return {
      BinaryExpression(node) {
        if (
          EQUALITY.has(node.operator) &&
          (isName(node.left) || isName(node.right))
        ) {
          context.report({ messageId: "nameComparison", node });
        }
      },
      CallExpression(node) {
        const { callee } = node;

        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "includes" &&
          callee.object.type === "ArrayExpression" &&
          callee.object.elements.length > 0 &&
          callee.object.elements.every(
            (element) => element !== null && isName(element)
          )
        ) {
          context.report({ messageId: "nameComparison", node });
        }
      },
      SwitchCase(node) {
        if (node.test !== null && isName(node.test)) {
          context.report({ messageId: "nameComparison", node: node.test });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow comparing a value with a name literal; the name's owner defines the predicate, getter, Match, or lookup table.",
    },
    messages: {
      nameComparison:
        'A name is compared as a raw string. Ask its owner instead: a module-level `Schema.is(XSchema.pick([...]))` predicate or a getter on the owning class, an exhaustive `Match` for multi-way branching, or a total `Schema.Record(...).make` table for per-name data. Plain text ("", "..", a path separator) may be compared directly.',
    },
    type: "problem",
  },
});
