// Directorate OpenCode adapter: tools and hooks run in host fibers with the plugin's own services, check permission first,
// and report failures the way the host expects.
import type { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Effect, Predicate, Schema } from "effect";

import type { Actor } from "../feature/agents/agent.ts";
import { recover } from "./error.ts";
import { Host } from "./host.ts";

/** A tool, hook, or locked-section body: a generator over Effects that may use the services R. */
export type Body<Args extends unknown[], A, R> = (
  ...args: Args
) => Effect.fn.Return<A, Error, R>;

type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];

export type DefineTool<R> = <
  Input extends Schema.Codec<unknown, unknown>,
>(spec: {
  name: string;
  description: string;
  input: Input;
  execute: Body<
    [input: Input["Type"], c: Tool.Context],
    { content: string },
    R
  >;
  /** Files the call reads, checked with the seal. */
  files?: (input: Input["Type"]) => readonly (string | undefined)[];
}) => void;

// Optional inputs are absent keys (optionalKey): Schema.optional renders as anyOf-null for the model.
export const str = Schema.String;
export const strArr = Schema.Array(str);
export const optional = Schema.optionalKey;
export const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const actor = (c: Tool.Context): Actor => ({
  agent: c.agent,
  session: c.sessionID,
});

const toolError = (error: Error) =>
  error instanceof Tool.Error
    ? error
    : new Tool.Error({
        message: error instanceof Error ? error.message : String(error),
      });

/**
 * Binds tools and hooks to the plugin's services R (the composition root names them); tool and hook bodies never see
 * the host's request context.
 */
export const adapter = <R>() =>
  Effect.gen(function* makeAdapter() {
    const services = yield* Effect.context<R | Host>();
    const host = yield* Host;

    /**
     * Role and permission checks, before any seal is read. The resources are the seal and any file the call reads, so a
     * rule such as `{ action: "directorate_read", resource: "*.env", effect: "deny" }` withholds that file from review.
     */
    const authorize = (
      name: string,
      c: Tool.Context,
      sealId: string | undefined,
      files: readonly string[]
    ) =>
      host.permission.assert({
        action: name,
        agent: c.agent,
        resources: [sealId ?? "*", ...files],
        save: [],
        sessionID: c.sessionID,
        source: { id: c.id, messageID: c.messageID, type: "tool" },
      });

    return {
      /** Hooks run in host fibers: give them the plugin's services, and log (never raise) their failures. */
      hook: <A>(name: string, body: Body<[event: A], void, R | Host>) => {
        const run = Effect.fn(`Directorate.${name}`)(body);

        return (event: A) =>
          run(event).pipe(Effect.provideContext(services), recover(name));
      },
      /**
       * Registers tools with an editor. Every tool first checks role and permission on the seal its input names, if any;
       * input the schema rejects never reaches a permission prompt.
       */
      tools:
        (editor: Editor): DefineTool<R | Host> =>
        (spec) => {
          const { files = () => [], ...definition } = spec;

          const run = Effect.fn(spec.name)(function* run(
            input: typeof spec.input.Type,
            c: Tool.Context
          ) {
            yield* authorize(
              spec.name,
              c,
              Predicate.hasProperty(input, "seal") &&
                Predicate.isString(input.seal)
                ? input.seal
                : undefined,
              files(input).filter(Predicate.isString)
            );

            return yield* spec.execute(input, c);
          });

          editor.add({
            ...definition,
            execute: (input, c) =>
              run(input, c).pipe(
                Effect.provideContext(services),
                Effect.mapError(toolError)
              ),
            options: { codemode: false },
          });
        },
    };
  });
