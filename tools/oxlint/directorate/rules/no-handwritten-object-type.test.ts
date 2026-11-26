import { RuleTester } from "oxlint/plugins-dev";

import { noHandwrittenObjectTypeRule } from "./no-handwritten-object-type.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const error = { messageId: "handwrittenObjectType" };

tester.run(
  "directorate/no-handwritten-object-type",
  noHandwrittenObjectTypeRule,
  {
    invalid: [
      {
        code: "const open = (input: { repo: string; mode?: string }) => input.repo;",
        errors: [error],
        name: "option bag parameter",
      },
      {
        code: "type Reader = { key: string; owner: boolean };",
        errors: [error],
        name: "type alias of an object shape",
      },
      {
        code: "interface Reader { key: string }",
        errors: [error],
        name: "data interface",
      },
      {
        code: "interface Context { scope: string; load: () => void }",
        errors: [error],
        name: "mixed bag of data and functions",
      },
      {
        code: "const launches = new Map<string, { parent: string }>();",
        errors: [error],
        name: "type argument",
      },
      {
        code: "type Empty = {};",
        errors: [error],
        name: "empty shape",
      },
      {
        code: "const wrap = <A>(value: A, options: { strict: boolean }) => value;",
        errors: [error],
        name: "shape that names no type parameter in a generic function",
      },
    ],
    valid: [
      'class Seal extends Schema.Class<Seal, { readonly brand: unique symbol }>("Seal")({}) {}',
      "type Revision<A> = typeof RevisedSchema.Type & { readonly out: A };",
      "interface DialogChoice<V> { readonly value: V }",
      "const pick = <V>(options: { current?: V; choices: readonly V[] }) => options.current;",
      "interface Dialogs { prompt(title: string): void; confirm: (title: string) => boolean }",
      "class ActiveSeal extends Context.Service<ActiveSeal, { readonly active: (id: string) => void }>()('x') {}",
      "type Reader = typeof ReaderSchema.Type;",
      "type Pins = Pick<typeof Containment.Type, 'id' | 'repo'>;",
      "type Backend = ReturnType<typeof backend>;",
      "const read = (key: string, owner: boolean) => key;",
    ],
  }
);
