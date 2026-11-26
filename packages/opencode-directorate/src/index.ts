// The Directorate's composition root. A Liaison session seals a target (directorate_seal), works through the budget's
// phases (normal → drain → locked), and leaves through directorate_report's protocol gates, or the deadline watchdog
// reports for it; Auditors, Seats, and Compliance run beside it. Each slice registers its own tools, hooks, and commands;
// this module builds the Layers, registers the slices in order, and connects the handles they hand each other.
import { Plugin } from "@opencode/plugin/effect";
import { Clock, Effect, Layer } from "effect";

import { registerAccess, registerBundled } from "./feature/agents/agents.ts";
import { registerDispatch, waitTool } from "./feature/dispatch/dispatch.ts";
import { ledgerTools } from "./feature/ledger/ledger.ts";
import { registerReport } from "./feature/report/report.ts";
import {
  configureRpc,
  configureTool,
  SettingsStore,
  settingsLines,
} from "./feature/settings/settings.ts";
import {
  adapter,
  Git,
  Host,
  nodeLayer,
  Worktree,
} from "./platform/platform.ts";
import {
  exportCommand,
  exportTools,
  StateRoot,
  Store,
} from "./records/records.ts";
import type { ActiveSeal } from "./records/records.ts";
import { readTools, sealLayer } from "./seal/seal.ts";
import type { Sessions } from "./seal/seal.ts";
import {
  notifyRecoveredReview,
  reviewCommand,
  reviewTools,
  sessionPrefix,
  watchdog,
} from "./workflow/review/review.ts";
import { registerShip } from "./workflow/ship/ship.ts";

const register = Effect.fn("Directorate.register")(function* register() {
  const host = yield* Host;
  const { tools } = yield* adapter<Services>();
  const loadedAt = yield* Clock.currentTimeMillis;

  yield* registerBundled();
  yield* configureRpc();
  const ship = yield* registerShip();
  const settingsLine = yield* settingsLines();

  // A filed Directive frees its seal's settings line; a recovered review's caller hears the Liaison's Directive.
  const report = yield* registerReport(
    settingsLine.forget,
    notifyRecoveredReview
  );

  // Abandoning files through report; a new seal goes to the ship loop, which may own it.
  const sealTools = yield* reviewTools(report.autoReport, ship.sealed);

  yield* host.command.transform((editor) => {
    editor.add(exportCommand(host));
    editor.add(reviewCommand(host));
    editor.add(ship.command);
  });

  // The tool list is part of the prompt prefix: keep this order.
  yield* host.tool.transform((editor) => {
    const tool = tools(editor);
    readTools(tool);
    ledgerTools(tool);
    configureTool(tool);
    exportTools(tool);
    sealTools(tool);
    report.reportTool(tool);
    waitTool(tool);
  });

  // The one ordered session-event consumer: the ship loop hears each event before the review's runs take theirs.
  yield* registerDispatch(ship.sessionEvent);
  yield* watchdog(loadedAt, report.autoReport, ship.recoverShips);
  // Registered after the ship loop's own context hook, which runs first.
  yield* sessionPrefix(settingsLine.push);
  yield* registerAccess();
});

/** Directorate review services on the Node platform: the one layer the plugin entry and the tests build. */
export const platformLayer = Layer.mergeAll(
  Store.layer,
  Worktree.layer,
  SettingsStore.layer
).pipe(
  Layer.provideMerge(Layer.merge(Git.layer, StateRoot.layer)),
  Layer.provideMerge(nodeLayer)
);

export type Platform = Layer.Success<typeof platformLayer>;

/** The services tool and hook bodies run with. */
type Services = Platform | Host | Sessions | ActiveSeal;

export default Plugin.define({
  // Layer.build ties the services' resources to the plugin's scope; tools and hooks receive exactly these services,
  // never the host's request context.
  effect: (ctx) =>
    Layer.build(
      sealLayer.pipe(
        Layer.provideMerge(Layer.succeed(Host, ctx)),
        Layer.provideMerge(platformLayer)
      )
    ).pipe(
      Effect.flatMap((services) =>
        register().pipe(Effect.provideContext(services))
      )
    ),
  id: "directorate",
});
