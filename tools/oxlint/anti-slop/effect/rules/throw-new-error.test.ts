import { RuleTester } from "oxlint/plugins-dev";

import { throwNewErrorRule } from "./throw-new-error.ts";

new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
}).run("throw-new-error", throwNewErrorRule, {
	valid: [
		"throw new Error()",
		"const e = new TypeError('x')",
		"throw new lib.CustomError()",
		"throw getError()",
		"throw lib.getError()",
		"throw lib[Error]()",
		"class QueryError extends Data.TaggedError('QueryError') {}",
		"class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {}) {}",
		"class Branded extends Schema.TaggedError<Branded, { readonly brand: unique symbol }>()('Branded', {}) {}",
		"class Failure extends Schema.Error<Failure>()({}) {}",
		"@RegisterServiceError()\nclass SomeError extends Error {}",
	],
	invalid: [
		{
			code: "throw Error('x')",
			errors: [{ messageId: "throwNewError" }],
			output: "throw new Error('x')",
		},
		{
			code: "const e = lib.CustomError()",
			errors: [{ messageId: "throwNewError" }],
			output: "const e = new lib.CustomError()",
		},
		{
			code: "class Foo extends CustomError() {}",
			errors: [{ messageId: "throwNewError" }],
		},
		{
			code: "class Foo extends Other.TaggedError<Foo>()('Foo', {}) {}",
			errors: [{ messageId: "throwNewError" }],
		},
		{
			code: "const Base = class extends CustomError()() {}",
			errors: [{ messageId: "throwNewError" }],
		},
		{
			code: "reject(Error('message'))",
			errors: [{ messageId: "throwNewError" }],
			output: "reject(new Error('message'))",
		},
	],
});
