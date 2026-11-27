import { defineRule, type ESTree } from "@oxlint/plugins";

/**
 * Effect factories whose names end in `Error` but are called, not constructed:
 * `class E extends Schema.TaggedError<E>()("E", {}) {}`.
 */
const effectErrorFactories = new Set([
	"Data.TaggedError",
	"Schema.Error",
	"Schema.TaggedError",
]);

const memberPath = (node: ESTree.Expression): string | undefined =>
	node.type === "MemberExpression" &&
	!node.computed &&
	node.object.type === "Identifier" &&
	node.property.type === "Identifier"
		? `${node.object.name}.${node.property.name}`
		: undefined;

const calleeName = (node: ESTree.Expression): string | undefined => {
	if (node.type === "Identifier") return node.name;
	if (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.property.type === "Identifier"
	) {
		return node.property.name;
	}
	return undefined;
};

const isErrorName = (name: string) =>
	name.length >= 5 && /^[A-Z]/.test(name) && name.endsWith("Error");

/** True when the call is a class's superclass, directly or as the callee of a curried call (`extends F<E>()(...)`). */
const isSuperClass = (node: ESTree.CallExpression) => {
	let current: ESTree.Node = node;

	while (
		current.parent.type === "CallExpression" &&
		current.parent.callee === current
	) {
		current = current.parent;
	}

	return (
		(current.parent.type === "ClassDeclaration" ||
			current.parent.type === "ClassExpression") &&
		current.parent.superClass === current
	);
};

/**
 * Oxlint's `unicorn/throw-new-error`, extended to Effect's error-class factories.
 * The native rule only exempts `Data.TaggedError`, so it reports `Schema.TaggedError<E>()`.
 */
export const throwNewErrorRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Require `new` when creating an error, except for Effect error-class factories.",
		},
		fixable: "code",
		messages: {
			throwNewError:
				"Require `new` when creating an error. Using `new` ensures the error is correctly initialized.",
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				const { callee, parent } = node;
				if (callee.type === "Super" || parent.type === "Decorator") return;

				const path = memberPath(callee);
				if (path !== undefined && effectErrorFactories.has(path)) return;

				const name = calleeName(callee);
				if (name === undefined || !isErrorName(name)) return;

				if (isSuperClass(node)) {
					context.report({ messageId: "throwNewError", node });
					return;
				}

				context.report({
					fix: (fixer) => fixer.insertTextBefore(node, "new "),
					messageId: "throwNewError",
					node,
				});
			},
		};
	},
});
