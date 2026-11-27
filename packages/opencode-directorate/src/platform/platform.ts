// Platform: process and host capabilities with no review policy, and the OpenCode adapter. The slice's entry: the Node
// layer, Git, Worktree, Host, ProcessIdentity, the host-record readers, the keyed lock, and the tool adapter.
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, FileSystem, Layer, Option } from "effect";
import type { Context } from "effect";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { nodeProcessIdentity } from "./process-identity.ts";

export { command } from "./command.ts";

export {
  ChangeCodeSchema,
  Git,
  isDeletion,
  isRename,
  isRenameOrCopy,
  isTypechange,
  UnreadableFile,
} from "./git.ts";

export type { PullRequest } from "./git.ts";

export { sha256 } from "./hash.ts";

export { Host } from "./host.ts";

export {
  activity,
  createdAt,
  foreign,
  idleAt,
  isFailed,
  isIdle,
  isInterrupted,
  isOrphaned,
  isRunning,
  isShutdown,
  isSucceeded,
  isSynthetic,
  isUserInput,
  isUserStop,
  locationKey,
  turns,
} from "./host-record.ts";

export type { Activity } from "./host-record.ts";

export { keyedLock, keyedLockUnsafe } from "./keyed-lock.ts";

export { ProcessIdentity } from "./process-identity.ts";

export {
  actor,
  adapter,
  isSubagentTool,
  optional,
  positiveInt,
  str,
  strArr,
  ToolCatalog,
} from "./tool.ts";

export type { DefineTool } from "./tool.ts";

export {
  IO_CONCURRENCY,
  isDeletedSignature,
  isDirectory,
  isFile,
  Worktree,
} from "./worktree.ts";

export type { LiveEntry } from "./worktree.ts";

/** The ambient `service` when one is provided, else `fallback`'s. */
const ambientOr = <I, S, E, R>(
  service: Context.Key<I, S>,
  fallback: Layer.Layer<I, E, R>
) =>
  Layer.unwrap(
    Effect.serviceOption(service).pipe(
      Effect.map(
        Option.match({
          onNone: () => fallback,
          onSome: (found) => Layer.succeed(service, found),
        })
      )
    )
  );

const processLayer = ambientOr(
  ChildProcessSpawner,
  NodeChildProcessSpawner.layer
);

const fileSystemLayer = ambientOr(FileSystem.FileSystem, NodeFileSystem.layer);

/** Node's process, filesystem, path, and crypto services, and this process's identity. */
export const nodeLayer = Layer.mergeAll(
  processLayer,
  NodeCrypto.layer,
  nodeProcessIdentity
).pipe(Layer.provideMerge(Layer.merge(fileSystemLayer, NodePath.layer)));
