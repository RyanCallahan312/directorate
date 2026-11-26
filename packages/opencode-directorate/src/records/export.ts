import { DateTime, Effect, FileSystem, Path, Result, Schema } from "effect";

import {
  Git,
  Host,
  command,
  isDirectory,
  isFile,
} from "../platform/platform.ts";
import { decodeUtf8 } from "../platform/utf8.ts";
import { isOwnerMark } from "../seal/region.ts";
import { ActiveSeal } from "./active-seal.ts";
import { ExportFailed, writeArchive } from "./archive.ts";
import { isRecordFile, Records } from "./repository.ts";

const TIMEOUT = 120_000;
const SESSION_ID = /^ses[\w-]+$/u;
const DIFF = /^diff(?:\.g\d+)?\.patch$/u;
const SNAPSHOT = /^snapshot(?:\.g\d+)?$/u;

const ExportManifest = Schema.fromJsonString(
  Schema.Struct({
    artifacts: Schema.Array(Schema.String),
    exportedAt: Schema.String,
    formatVersion: Schema.Literal(1),
    missingArtifacts: Schema.Array(Schema.String),
    openCodeVersion: Schema.String,
    reported: Schema.Boolean,
    runsWithoutSession: Schema.Array(Schema.String),
    seal: Schema.String,
    sessions: Schema.Array(
      Schema.Struct({
        error: Schema.optional(Schema.String),
        id: Schema.String,
        log: Schema.optional(Schema.String),
        transcript: Schema.optional(Schema.String),
      })
    ),
  }),
  { space: 2 }
);

const encodeManifest = Schema.encodeEffect(ExportManifest);

export const PAGE_SIZE = 50;

export const listExportReviews = Effect.fn("Directorate.listExportReviews")(
  function* listExportReviews(sessionID: string, before: string | undefined) {
    const store = yield* Records;
    const sessions = yield* ActiveSeal;
    const git = yield* Git;

    const directory =
      (yield* sessions.directory(sessionID)) ??
      (yield* Host).location.directory;

    const repo = yield* git.root(directory);
    const roots = new Set([repo, ...(yield* git.worktrees(repo))]);

    const page = (yield* store.list())
      .filter(
        (seal) =>
          roots.has(seal.repo) && (before === undefined || seal.id < before)
      )
      .slice(0, PAGE_SIZE + 1);

    const active =
      before === undefined ? yield* sessions.active(sessionID) : undefined;

    return {
      activeSeal: active && roots.has(active.repo) ? active.id : undefined,
      nextBefore: page.length > PAGE_SIZE ? page[PAGE_SIZE - 1]?.id : undefined,
      now: DateTime.formatIso(yield* DateTime.now),
      reviews: page.slice(0, PAGE_SIZE).map((seal) => ({
        createdAt: DateTime.formatIso(seal.createdAt),
        description: seal.description.slice(0, 200),
        mode: seal.mode,
        reportedAt: seal.reportedAt && DateTime.formatIso(seal.reportedAt),
        seal: seal.id,
        target: seal.target.kind,
      })),
    };
  }
);

const transcriptId = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      info: Schema.Struct({ id: Schema.String }),
      messages: Schema.Array(Schema.Unknown),
    })
  )
);

/** Copy only regular artifacts, never follow links or put special files in an archive. */
const copyArtifact: (
  source: string,
  dest: string
) => Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* copyEntry(source, dest) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const { type } = yield* fs.lstat(source);

    if (isFile(type)) {
      return yield* fs.copyFile(source, dest);
    }

    if (!isDirectory(type)) {
      return yield* new ExportFailed({
        message: `Not a regular export artifact: ${source}`,
      });
    }

    yield* fs.makeDirectory(dest);
    const names = yield* fs.readDirectory(source);
    yield* Effect.forEach(
      names,
      (name) => copyArtifact(paths.join(source, name), paths.join(dest, name)),
      { discard: true }
    );
  });

const copyReview = Effect.fn("Directorate.copyReview")(function* copyReview(
  id: string,
  staging: string
) {
  const store = yield* Records;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const source = paths.join(store.root, id);

  if (!isDirectory((yield* fs.lstat(source)).type)) {
    return yield* new ExportFailed({
      message: `Not a seal directory: ${source}`,
    });
  }

  const artifacts = paths.join(staging, "seal");
  yield* fs.makeDirectory(artifacts);

  // Copy the review while locked, but don't hold the writer lock across OpenCode calls or compression.
  const { seal, files } = yield* store.withLock(
    id,
    Effect.gen(function* snapshot() {
      const saved = yield* store.load(id);

      const names = (yield* fs.readDirectory(source))
        .filter(
          (name) => isRecordFile(name) || DIFF.test(name) || SNAPSHOT.test(name)
        )
        .toSorted();

      yield* Effect.forEach(
        names,
        (name) =>
          copyArtifact(paths.join(source, name), paths.join(artifacts, name)),
        { discard: true }
      );

      return { files: names, seal: saved };
    })
  );

  const missingArtifacts = [
    "ledger.json",
    seal.gen ? `diff.g${seal.gen}.patch` : "diff.patch",
    ...(seal.pinsCommit
      ? []
      : [seal.gen ? `snapshot.g${seal.gen}` : "snapshot"]),
    ...(seal.reportedAt ? ["report.md"] : []),
  ].filter((name) => !files.includes(name));

  return {
    artifacts: files.map((name) => `seal/${name}`),
    missingArtifacts,
    reported: Boolean(seal.reportedAt),
    runsWithoutSession: seal.children
      .filter((child) => !child.session)
      .map((child) => child.call),
    seal: id,
    sessionIds: [
      ...new Set(
        [
          seal.ownerSession,
          ...(seal.previousOwnerSessions ?? []),
          ...seal.children.map((child) => child.session),
          // Owners' reads are recorded as "owner" (seal/tools.ts); the owner sessions are already listed above.
          ...seal.regions.flatMap((region) =>
            region.readBy.filter((reader) => !isOwnerMark(reader))
          ),
        ].filter((value): value is string => Boolean(value))
      ),
    ],
  };
});

export const exportReview = Effect.fn("Directorate.exportReview")(
  function* exportReview(id: string) {
    const host = yield* Host;
    const store = yield* Records;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* store.load(id);
    const output = paths.resolve(store.root, "exports");
    yield* fs.makeDirectory(output, { mode: 0o700, recursive: true });

    const staging = yield* fs.makeTempDirectoryScoped({
      directory: output,
      prefix: ".export-",
    });

    yield* fs.makeDirectory(paths.join(staging, "sessions"));
    const { sessionIds, ...review } = yield* copyReview(id, staging);

    const sessionExports = yield* Effect.forEach(
      sessionIds,
      Effect.fnUntraced(function* exportSession(session) {
        if (!SESSION_ID.test(session)) {
          return { error: "Invalid OpenCode session ID", id: session };
        }

        // shortcut: the plugin context doesn't expose transcript/log reads; use the OpenCode CLI until it does.
        const transcript = yield* command(
          "opencode",
          ["session", "export", session],
          { timeout: TIMEOUT }
        ).pipe(Effect.result);

        const log = yield* command(
          "opencode",
          [
            "api",
            "get",
            `/api/experimental/session/${session}/log?follow=false`,
          ],
          { timeout: TIMEOUT }
        ).pipe(Effect.result);

        const exportedTranscript =
          Result.isSuccess(transcript) &&
          transcriptId(decodeUtf8(transcript.success)).valueOrUndefined?.info
            .id === session
            ? `sessions/${session}.json`
            : undefined;

        const exportedLog = Result.isSuccess(log)
          ? `sessions/${session}.sse`
          : undefined;

        if (exportedTranscript && Result.isSuccess(transcript)) {
          yield* fs.writeFile(
            paths.join(staging, exportedTranscript),
            transcript.success
          );
        }

        if (exportedLog && Result.isSuccess(log)) {
          yield* fs.writeFile(paths.join(staging, exportedLog), log.success);
        }

        const unavailable = [
          !exportedTranscript && "transcript",
          !exportedLog && "event log",
        ].filter(Boolean);

        return {
          error: unavailable.length
            ? `Could not export ${unavailable.join(" or ")} from the OpenCode CLI. Check that it can reach this session's server.`
            : undefined,
          id: session,
          log: exportedLog,
          transcript: exportedTranscript,
        };
      }),
      { concurrency: 2 }
    );

    const manifest = yield* encodeManifest({
      ...review,
      exportedAt: DateTime.formatIso(yield* DateTime.now),
      formatVersion: 1,
      openCodeVersion: host.app.version,
      sessions: sessionExports,
    });

    yield* fs.writeFileString(paths.join(staging, "manifest.json"), manifest);

    const temp = paths.join(staging, "archive.zip");
    yield* writeArchive(staging, temp, ["manifest.json", "seal", "sessions"]);

    const archive = paths.join(
      output,
      `${id}-${paths.basename(staging).slice(".export-".length)}.zip`
    );

    yield* fs.link(temp, archive);

    const incomplete =
      sessionExports.some((entry) => entry.error) ||
      review.missingArtifacts.length ||
      review.runsWithoutSession.length;

    return `Exported ${id} to ${archive}.${incomplete ? " Some review data was unavailable; see manifest.json." : ""} This archive is unredacted and may contain private code, prompts, and tool output. Nothing was uploaded.`;
  },
  Effect.scoped
);
