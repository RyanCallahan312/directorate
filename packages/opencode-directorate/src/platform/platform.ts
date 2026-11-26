// Platform: process and host capabilities with no review policy, and the OpenCode adapter. The slice's entry: the Node
// layer, Git, Worktree, Host, ProcessIdentity, the host-record readers, and the tool adapter.
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, FileSystem, Layer, Option } from "effect";
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

/** Node's process, filesystem, path, and crypto services, and this process's identity. */
export const nodeLayer = Layer.mergeAll(
  processLayer,
  NodeCrypto.layer,
  nodeProcessIdentity
).pipe(Layer.provideMerge(Layer.merge(fileSystemLayer, NodePath.layer)));
