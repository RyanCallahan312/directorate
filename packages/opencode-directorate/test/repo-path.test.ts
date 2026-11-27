import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Exit, Option, Schema } from "effect";

import { LineRef, RepoPath, RepoScope } from "../src/seal/repo-path.ts";

const decodePath = Schema.decodeOption(RepoPath);
const decodeScope = Schema.decodeOption(RepoScope);
const decodeRef = Schema.decodeUnknownEffect(LineRef);

/** The message a LineRef decode of `input` fails with. */
const refFailure = (input: string) => {
  const exit = Effect.runSyncExit(decodeRef(input));

  assert.ok(Exit.isFailure(exit), input);

  return String(exit.cause);
};

test("RepoPath: trimmed, with empty and . segments dropped and .. resolved", () => {
  assert.deepEqual(
    [
      " a/b.ts ",
      "./a//./b.ts",
      "a/b/",
      "a/x/../b.ts",
      "a/./x/y/../../b.ts",
    ].map((p) => Option.getOrThrow(decodePath(p))),
    ["a/b.ts", "a/b.ts", "a/b", "a/b.ts", "a/b.ts"]
  );
});

test("RepoPath: absolute paths, escapes, and the root itself are rejected", () => {
  for (const bad of [
    "/etc/passwd",
    "  /a",
    "..",
    "../a",
    "a/../../b",
    "../repo/a",
    "",
    ".",
    "a/..",
  ]) {
    assert.ok(Option.isNone(decodePath(bad)), bad);
  }
});

test("RepoScope: the root decodes to an empty scope; escapes are rejected", () => {
  assert.deepEqual(
    [".", "", "./", "a/..", "./src/"].map((p) =>
      Option.getOrThrow(decodeScope(p))
    ),
    ["", "", "", "", "src"]
  );
  assert.ok(Option.isNone(decodeScope("../x")));
  assert.ok(Option.isNone(decodeScope("/")));
});

test("RepoPath: a backslash is part of a name, not a separator (POSIX only)", () => {
  assert.deepEqual(
    ["src\\a.ts", "..\\outside", "C:\\outside"].map((p) =>
      Option.getOrThrow(decodePath(p))
    ),
    ["src\\a.ts", "..\\outside", "C:\\outside"]
  );
});

test("LineRef: a path with a colon decodes to its normalized path and range", () => {
  assert.deepEqual(
    ["./src//a:b.ts:3-7", "a.txt:stream:2"].map((r) =>
      Effect.runSync(decodeRef(r))
    ),
    [
      { end: 7, path: "src/a:b.ts", start: 3 },
      { end: 2, path: "a.txt:stream", start: 2 },
    ]
  );
});

test("LineRef: an absolute, escaping, or root path fails with the path named", () => {
  assert.ok(
    refFailure("/etc/passwd:1").includes(
      "Path /etc/passwd must be relative to the repository and stay inside it."
    )
  );
  assert.ok(
    refFailure("a/../../b:1-2").includes(
      "Path a/../../b must be relative to the repository and stay inside it."
    )
  );
  assert.ok(
    refFailure("./:4").includes(
      "Expected a file path, not the repository root."
    )
  );
});
