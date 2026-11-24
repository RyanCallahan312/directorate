// Directorate review services on the Node platform: the one layer the plugin entry and the tests build.
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Layer } from "effect";

import { Git } from "./git.ts";
import { SettingsStore } from "./settings.ts";
import { StateRoot, Store } from "./store.ts";
import { Worktree } from "./worktree.ts";

const nodeLayer = Layer.mergeAll(
  NodeChildProcessSpawner.layer,
  NodeCrypto.layer
).pipe(Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer)));
export const platformLayer = Layer.mergeAll(
  Store.layer,
  Worktree.layer,
  SettingsStore.layer
).pipe(
  Layer.provideMerge(Layer.merge(Git.layer, StateRoot.layer)),
  Layer.provideMerge(nodeLayer)
);
export type Platform = Layer.Success<typeof platformLayer>;
