import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { Option, Predicate, Schema } from "effect";

const decodeOptions = Schema.decodeUnknownOption(
  Schema.Struct({
    /** The agent ids, as their owner spells them. */
    ids: Schema.Array(Schema.String),
    /** The one module that may spell them, as a path suffix. */
    owner: Schema.String,
  })
);

/** Ban spelling an agent id inside a string or template: every other module interpolates the Agent's `id`. */
export const noAgentIdInStringRule = defineRule({
  createOnce(context) {
    const check = (node: ESTree.Node, text: string | null) => {
      const options = Option.getOrUndefined(decodeOptions(context.options[0]));

      if (
        text === null ||
        options === undefined ||
        context.filename.replaceAll("\\", "/").endsWith(options.owner)
      ) {
        return;
      }

      const id = options.ids.find((candidate) => text.includes(candidate));

      if (id !== undefined) {
        context.report({
          data: { id, owner: options.owner },
          messageId: "agentIdInString",
          node,
        });
      }
    };

    return {
      Literal(node) {
        if (Predicate.isString(node.value)) {
          check(node, node.value);
        }
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
    };
  },
  meta: {
    defaultOptions: [{ ids: [], owner: "" }],
    docs: {
      description:
        "Disallow agent ids inside strings; interpolate the Agent's id so the ids live only in their owner module.",
    },
    messages: {
      agentIdInString:
        "Agent id `{{id}}` is written inside a string. Interpolate the Agent's `id` in a template (for example `Liaison.id`) so the id lives only in {{owner}}.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          ids: { items: { type: "string" }, type: "array" },
          owner: { type: "string" },
        },
        required: ["ids", "owner"],
        type: "object",
      },
    ],
    type: "problem",
  },
});
