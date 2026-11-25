// Directorate review services on the Node platform: the one layer the plugin entry and the tests build.
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, FileSystem, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { Git } from "./git.ts";
import { nodeProcessIdentity } from "./process-identity.ts";
import { SettingsStore } from "./settings.ts";
import { StateRoot, Store } from "./store.ts";
import { Worktree } from "./worktree.ts";

const processLayer = Layer.unwrap(
  Effect.serviceOption(ChildProcessSpawner).pipe(
    Effect.map(
      Option.match({
        onNone: () => NodeChildProcessSpawner.layer,
        onSome: (spawner) => Layer.succeed(ChildProcessSpawner, spawner),
      })
    )
  )
);

const fileSystemLayer = Layer.unwrap(
  Effect.serviceOption(FileSystem.FileSystem).pipe(
    Effect.map(
      Option.match({
        onNone: () => NodeFileSystem.layer,
        onSome: (fs) => Layer.succeed(FileSystem.FileSystem, fs),
      })
    )
  )
);

const nodeLayer = Layer.mergeAll(
  processLayer,
  NodeCrypto.layer,
  nodeProcessIdentity
).pipe(Layer.provideMerge(Layer.merge(fileSystemLayer, NodePath.layer)));

export const platformLayer = Layer.mergeAll(
  Store.layer,
  Worktree.layer,
  SettingsStore.layer
).pipe(
  Layer.provideMerge(Layer.merge(Git.layer, StateRoot.layer)),
  Layer.provideMerge(nodeLayer)
);

export type Platform = Layer.Success<typeof platformLayer>;
