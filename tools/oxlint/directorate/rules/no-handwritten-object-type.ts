import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** The nominal brand every Schema class passes as its second type argument. */
const BRAND = /^\{\s*readonly brand: unique symbol;?\s*\}$/u;

/** Type parameters declared by the node's enclosing functions, type aliases, interfaces, and classes. */
const typeParametersInScope = (node: ESTree.Node | null): readonly string[] => {
  if (node === null) {
    return [];
  }

  const own =
    "typeParameters" in node &&
    node.typeParameters?.type === "TSTypeParameterDeclaration"
      ? node.typeParameters.params.map((parameter) => parameter.name.name)
      : [];

  return [...own, ...typeParametersInScope(node.parent)];
};

const isFunctionMember = (member: ESTree.TSSignature) =>
  member.type === "TSMethodSignature" ||
  member.type === "TSCallSignatureDeclaration" ||
  (member.type === "TSPropertySignature" &&
    member.typeAnnotation?.typeAnnotation.type === "TSFunctionType");

/**
 * Ban hand-written object shapes: object type literals and interfaces. A schema owns a data shape, so its type is derived.
 * Three shapes have no data for a schema to own and are allowed: the class brand, a generic slot (the shape names a type
 * parameter in scope), and a pure function bag (a port).
 */
export const noHandwrittenObjectTypeRule = defineRule({
  createOnce(context) {
    const allowed = (
      node: ESTree.Node,
      members: readonly ESTree.TSSignature[]
    ) => {
      const source = context.sourceCode.getText(node);

      return (
        BRAND.test(source) ||
        (members.length > 0 && members.every(isFunctionMember)) ||
        typeParametersInScope(node).some((name) =>
          new RegExp(`\\b${name}\\b`, "u").test(source)
        )
      );
    };

    return {
      TSInterfaceDeclaration(node) {
        if (!allowed(node, node.body.body)) {
          context.report({ messageId: "handwrittenObjectType", node: node.id });
        }
      },
      TSTypeLiteral(node) {
        if (!allowed(node, node.members)) {
          context.report({ messageId: "handwrittenObjectType", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow hand-written object types; derive a data shape's type from the schema or value that owns it.",
    },
    messages: {
      handwrittenObjectType:
        "This object shape is written by hand. Give it an owner: a named `Schema.Struct` (or branded class) with a derived type, a type derived from what already owns it (`typeof X.Type`, `Parameters<typeof f>[0]`, `ReturnType<typeof make>`), or plain positional parameters. A generic type lets a schema own its non-generic fields and adds only the generic slot.",
    },
    type: "problem",
  },
});
