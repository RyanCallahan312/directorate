// Directorate OpenCode adapter: tools and hooks run in host fibers with the plugin's own services, check permission first,
// and report failures the way the host expects.
import type { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";

import { Actor, Agent, agentNamed } from "../feature/agents/agent.ts";
import { recover } from "./error.ts";
import { Host } from "./host.ts";

/** A tool, hook, or locked-section body: a generator over Effects that may use the services R. */
type Body<Args extends unknown[], A, R> = (
  ...args: Args
) => Effect.fn.Return<A, Error, R>;

/** What a Directorate tool answers: the text the model reads. */
const ToolReplySchema = Schema.Struct({ content: Schema.String });

/** The host's tool, and permission action, that launches a subagent. */
export const isSubagentTool = Schema.is(Schema.Literal("subagent"));

type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];

export type DefineTool<R> = <
  Input extends Schema.Codec<unknown, unknown>,
>(spec: {
  name: string;
  description: string;
  input: Input;
  /** Runs a call; `name` is the name the tool registered under, for the ToolCall it hands the door. */
  execute: Body<
    [input: Input["Type"], c: Tool.Context, name: string],
    typeof ToolReplySchema.Type,
    R
  >;
  /** Files the call reads, checked with the seal. */
  files?: (input: Input["Type"]) => readonly (string | undefined)[];
  /** The agents that keep the tool once the budget locks; none by default. */
  lockdown?: readonly Agent[];
  /** False for a tool any agent may call: it is not part of the review harness. True by default. */
  harness?: boolean;
}) => void;

/** What a tool declares about its callers: who keeps it at lockdown, and whether only Directorate agents call it. */
class ToolDeclaration extends Schema.Class<
  ToolDeclaration,
  { readonly brand: unique symbol }
>("directorate/ToolDeclaration")({
  harness: Schema.Boolean,
  lockdown: Schema.Array(Agent),
  name: Schema.String,
}) {}

const makeCatalog = Effect.gen(function* makeCatalog() {
  const declared = yield* Ref.make(HashMap.empty<string, ToolDeclaration>());

  const declaration = (tool: string) =>
    Ref.get(declared).pipe(
      Effect.map((m) => Option.getOrUndefined(HashMap.get(m, tool)))
    );

  return {
    /** Records tools' declarations by name; declaring a tool again replaces its declaration. */
    declare: (declarations: HashMap.HashMap<string, ToolDeclaration>) =>
      Ref.update(declared, (m) => HashMap.union(m, declarations)),
    /** Whether a Directorate-namespaced tool is part of the review harness, which only Directorate agents call. */
    harness: (tool: string) =>
      declaration(tool).pipe(
        Effect.map(
          (d) => tool.startsWith("directorate_") && (d?.harness ?? true)
        )
      ),
    /** Whether `agent`'s calls to `tool` still run once the budget is locked; other agents keep nothing. */
    keeps: (agent: string | undefined, tool: string) =>
      declaration(tool).pipe(
        Effect.map((d) => {
          const by = agentNamed(agent);

          return by !== undefined && (d?.lockdown.includes(by) ?? false);
        })
      ),
  };
});

/** The tools' declarations, collected once at registration, before any hook or tool runs. */
export class ToolCatalog extends Context.Service<
  ToolCatalog,
  Effect.Success<typeof makeCatalog>
>()("directorate/ToolCatalog") {
  static readonly layer = Layer.effect(ToolCatalog, makeCatalog);
}

// Optional inputs are absent keys (optionalKey): Schema.optional renders as anyOf-null for the model.
export const str = Schema.String;
export const strArr = Schema.Array(str);
export const optional = Schema.optionalKey;
export const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Who makes a tool call, decoded once from the host's tool context. */
export const actor = (c: Tool.Context) =>
  Actor.make({ agent: c.agent, session: c.sessionID });

const toolError = (error: Error) =>
  error instanceof Tool.Error
    ? error
    : new Tool.Error({ message: error.message });

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
       * Runs `register` once: declares every tool it defines in the ToolCatalog now, and returns the host's tool
       * transform, which may run any number of times and adds the same tools, in order, to each editor it is handed.
       * Every tool first checks role and permission on the seal its input names, if any; input the schema rejects never
       * reaches a permission prompt.
       */
      tools: Effect.fnUntraced(function* tools(
        register: (tool: DefineTool<R | Host>) => void
      ) {
        const catalog = yield* ToolCatalog;
        let declarations = HashMap.empty<string, ToolDeclaration>();
        // Each adds a fresh definition: the editor's tools belong to the host, which may change them.
        const additions: ((editor: Editor) => void)[] = [];

        register((spec) => {
          const {
            description,
            files = () => [],
            harness = true,
            input,
            lockdown = [],
            name,
          } = spec;

          declarations = HashMap.set(
            declarations,
            name,
            ToolDeclaration.make({ harness, lockdown, name })
          );

          const run = Effect.fn(name)(function* run(
            value: typeof input.Type,
            c: Tool.Context
          ) {
            yield* authorize(
              name,
              c,
              Predicate.hasProperty(value, "seal") &&
                Predicate.isString(value.seal)
                ? value.seal
                : undefined,
              files(value).filter(Predicate.isString)
            );

            return yield* spec.execute(value, c, name);
          });

          additions.push((editor) =>
            editor.add({
              description,
              execute: (value, c) =>
                run(value, c).pipe(
                  Effect.provideContext(services),
                  Effect.mapError(toolError)
                ),
              input,
              name,
              options: { codemode: false },
            })
          );
        });
        yield* catalog.declare(declarations);

        return (editor: Editor) => {
          for (const add of additions) {
            add(editor);
          }
        };
      }),
    };
  });
