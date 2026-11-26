// Directorate OpenCode adapter: tools and hooks run in host fibers with the plugin's own services, check permission first,
// and report failures the way the host expects.
import type { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Effect, Predicate, Schema } from "effect";

import { budget, budgetLine } from "./budget.ts";
import { failure, recover } from "./error.ts";
import { PANELIST, REFUTER, REVIEWER, SCOUT } from "./model.ts";
import type { Actor, Seal } from "./model.ts";
import type { Platform } from "./platform.ts";
import { Host, Sessions } from "./session.ts";

type Services = Platform | Host | Sessions;

/** A tool, hook, or locked-section body: a generator over Effects that may use the plugin's services. */
type Body<Args extends unknown[], A> = (
  ...args: Args
) => Effect.fn.Return<A, Error, Services>;

type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];

export type DefineTool = <Input extends Schema.Codec<unknown, unknown>>(spec: {
  name: string;
  description: string;
  input: Input;
  execute: Body<[input: Input["Type"], c: Tool.Context], { content: string }>;
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

/** A tool result; while the seal is open, it ends with the caller's budget line. */
export const done = Effect.fnUntraced(function* done(
  seal: Seal,
  text: string,
  agent?: string
) {
  return {
    content: seal.reportedAt
      ? text
      : `${text}\n\n${yield* budgetLine(seal, agent)}`,
  };
});

/** A reported seal accepts no changes; an owner-only tool also needs the session that sealed it. */
export const writable = (
  seal: Seal,
  c: Tool.Context,
  name: string,
  ownerOnly = false
) => {
  if (seal.reportedAt) {
    return failure(
      `${seal.id} was already reported${seal.autoReported ? " (filed automatically)" : ""}; containment is closed and accepts no further changes. Open a new seal for new work.`
    );
  }

  return ownerOnly && seal.ownerSession !== c.sessionID
    ? failure(
        `Only the session that sealed ${seal.id} may call ${name}. To take over an interrupted review, call directorate_seal with resume: "${seal.id}".`
      )
    : Effect.void;
};

/** Runs body under the seal's lock, on a freshly loaded seal. */
export const locked = <A>(
  c: Tool.Context,
  sealId: string,
  body: Body<[seal: Seal], A>
) =>
  Effect.flatMap(Effect.service(Sessions), (sessions) =>
    sessions.locked(c.sessionID, sealId, (seal) => Effect.gen(() => body(seal)))
  );

/** What each role may still call once the budget is locked. */
export const LOCKED_TOOLS = new Map([
  [
    REVIEWER,
    new Set([
      "directorate_report",
      "directorate_ledger_list",
      "directorate_note",
    ]),
  ],
  [SCOUT, new Set(["directorate_ledger_add", "directorate_note"])],
  [PANELIST, new Set(["directorate_ledger_add", "directorate_note"])],
  [REFUTER, new Set(["directorate_ledger_verdict", "directorate_ledger_list"])],
]);

/**
 * Once an open seal's budget locks, only the caller's locked tools run: a model step that began before the deadline still
 * sees the tools stripped at lockdown, and the lock may have been held past it. Check under the seal's lock.
 */
export const unlocked = Effect.fnUntraced(function* unlocked(
  seal: Seal,
  c: Tool.Context,
  name: string
) {
  if (
    !seal.reportedAt &&
    !LOCKED_TOOLS.get(c.agent)?.has(name) &&
    (yield* budget(seal)).phase === "locked"
  ) {
    return yield* failure(
      `Directorate lockdown: the budget for ${seal.id} is locked, so ${name} no longer runs. ${c.agent === REVIEWER ? "Call directorate_report now." : "Hand off what you hold now."}`
    );
  }
});

/** A change to an open seal, under its lock; once the budget locks, only the caller's locked tools run. */
export const mutate = <A>(
  c: Tool.Context,
  sealId: string,
  name: string,
  body: Body<[seal: Seal], A>,
  ownerOnly = false
) =>
  locked(c, sealId, function* mutateSeal(seal) {
    yield* writable(seal, c, name, ownerOnly);
    yield* unlocked(seal, c, name);

    return yield* body(seal);
  });

const toolError = (error: Error) =>
  error instanceof Tool.Error
    ? error
    : new Tool.Error({
        message: error instanceof Error ? error.message : String(error),
      });

/** Binds tools and hooks to the plugin's services; tool and hook bodies never see the host's request context. */
export const adapter = Effect.gen(function* adapter() {
  const services = yield* Effect.context<Services>();
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
    hook: <A>(name: string, body: Body<[event: A], void>) => {
      const run = Effect.fn(`Directorate.${name}`)(body);

      return (event: A) =>
        run(event).pipe(Effect.provideContext(services), recover(name));
    },
    /**
     * Registers tools with an editor. Every tool first checks role and permission on the seal its input names, if any;
     * input the schema rejects never reaches a permission prompt.
     */
    tools:
      (editor: Editor): DefineTool =>
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
