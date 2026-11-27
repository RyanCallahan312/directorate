import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { DateTime, Effect, Layer } from "effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { Ledger } from "../src/feature/ledger/entry.ts";
import { Gates } from "../src/feature/report/directive.ts";
import { SessionIdSchema } from "../src/platform/host-id.ts";
import { Seal } from "../src/seal/record.ts";
import { SealIdSchema } from "../src/seal/seal-id.ts";
import { Target } from "../src/seal/target.ts";

/** A ledger with no entries and no notes. */
export const emptyLedger = Ledger.make({ entries: [], notes: [] });

const sealedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

/** A seal with no files, regions, or runs; pass only the fields a test is about. */
export const bareSeal = (overrides: Partial<Parameters<typeof Seal.make>[0]>) =>
  Seal.make({
    baseSha: "base",
    budgetMinutes: 10,
    children: [],
    createdAt: sealedAt,
    deadline: sealedAt,
    deleted: [],
    description: "d",
    files: [],
    fingerprint: "f",
    gates: Gates.make({}),
    gen: 0,
    headSha: "head",
    id: SealIdSchema.make("directorate-20260101000000-abcdef"),
    mode: "default",
    owner: "directorate_liaison",
    ownerSession: SessionIdSchema.make("ses_lead"),
    pid: process.pid,
    postImage: "commit",
    refreshes: 0,
    regions: [],
    repo: "/test",
    target: Target.make({ kind: "auto" }),
    ...overrides,
  });

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
