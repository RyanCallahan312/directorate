import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, Layer } from "effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

/** Replace one external CLI with a Node script, keeping native process spawning and argv. */
export const commandFixture = (name: string, script: string) =>
  Layer.effect(
    ChildProcessSpawner,
    ChildProcessSpawner.pipe(
      Effect.map((native) => ({
        ...native,
        spawn: (request: ChildProcess.Command) =>
          native.spawn(
            ChildProcess.isStandardCommand(request) && request.command === name
              ? ChildProcess.make(
                  process.execPath,
                  ["-e", script, "--", ...request.args],
                  request.options
                )
              : request
          ),
      }))
    )
  ).pipe(
    Layer.provide(
      NodeChildProcessSpawner.layer.pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
      )
    )
  );
