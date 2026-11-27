import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { after, afterEach, test } from "node:test";

import { ConfigProvider, Effect, Layer, Ref, Schema } from "effect";

import { Actor } from "../src/feature/agents/agent.ts";
import { platformLayer } from "../src/index.ts";
import type { Platform } from "../src/index.ts";
import { SessionIdSchema } from "../src/platform/host-id.ts";
import { CaptureDrift, settled } from "../src/seal/capture.ts";
import {
  checkEvidence,
  checkQuote,
  fromSecrets,
  isWithheld,
  linesOf,
  readable,
} from "../src/seal/content.ts";
import { assemble, RawDiff } from "../src/seal/diff.ts";
import { Anchor } from "../src/seal/region.ts";
import { history, listFiles, readLines } from "../src/seal/views.ts";
import { createSeal } from "../src/workflow/review/lifecycle.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const { join } = nodePath;
const state = fs.mkdtempSync(join(tmpdir(), "directorate-state-"));
const dirs = [state];

after(() => {
  for (const d of dirs) {
    fs.rmSync(d, { force: true, recursive: true });
  }
});

const testPlatform = platformLayer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({ DIRECTORATE_STATE_DIR: state })
    )
  )
);

const run = <A, E>(effect: Effect.Effect<A, E, Platform>) =>
  runPromise(effect.pipe(Effect.provide(testPlatform)));

const g = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString();

const write = (dir: string, p: string, c: string) => {
  fs.mkdirSync(join(dir, p, ".."), { recursive: true });
  fs.writeFileSync(join(dir, p), c);
};

const repo = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "directorate-repo-"));
  dirs.push(dir);
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "core.autocrlf", "false");
  g(dir, "config", "user.email", "t@e.com");
  g(dir, "config", "user.name", "t");

  for (const [p, c] of Object.entries(files)) {
    write(dir, p, c);
  }

  g(dir, "add", ".");
  g(dir, "commit", "-qm", "init");

  return dir;
};

const lead = Actor.make({
  agent: "directorate_liaison",
  session: SessionIdSchema.make("ses_lead"),
});

const local = (dir: string) =>
  run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { kind: "local" },
    })
  );

const at = (path: string, line: number) =>
  Anchor.make({ endLine: line, line, path, side: "new" });

test("diff status: an excluded file's content change stays modified; binary stays binary; mode-only is mode", () => {
  const patch = [
    "diff --git a/package-lock.json b/package-lock.json",
    "index 1..2 100644",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    "-{}",
    '+{"a":1}',
    "diff --git a/img.png b/img.png",
    "index 3..4 100644",
    "Binary files a/img.png and b/img.png differ",
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
    "",
  ].join("\n");

  const pieces = Schema.decodeSync(RawDiff)(
    [
      ":100644 100644 1 2 M",
      "package-lock.json",
      ":100644 100644 3 4 M",
      "img.png",
      ":100644 100755 5 5 M",
      "run.sh",
      "",
      patch,
    ].join("\0")
  );

  const { files } = assemble(pieces);

  assert.deepEqual(
    files.map((f) => [f.path, f.status, Boolean(f.excluded)]),
    [
      ["package-lock.json", "modified", true],
      ["img.png", "binary", true],
      ["run.sh", "mode", false],
    ]
  );
});

test("lines: a final newline ends the last line rather than starting another", () => {
  assert.deepEqual(linesOf("a\nb\n"), ["a", "b"]);
  assert.deepEqual(linesOf("a\nb"), ["a", "b"]);
  assert.deepEqual(linesOf("a\n\n"), ["a", ""]);
  assert.equal(linesOf("").length, 1);
});

test("reads, anchors, and evidence count a newline-terminated file's lines exactly", async () => {
  const dir = repo({ "src/a.ts": "const first = 1\n" });
  write(dir, "src/a.ts", "const first = 1\nconst second = 2\n");
  const seal = await local(dir);

  assert.match(
    await run(readLines(seal, "src/a.ts", "new")),
    /^src\/a\.ts:1-2 of 2 · /u
  );

  assert.ok(await run(checkQuote(seal, at("src/a.ts", 2), "const second = 2")));
  await assert.rejects(
    run(checkQuote(seal, at("src/a.ts", 3), "const second = 2")),
    /src\/a\.ts:3 is outside the file \(2 lines\)/u
  );

  assert.deepEqual(await run(checkEvidence(seal, ["src/a.ts:2"])), [
    "src/a.ts:2",
  ]);
  await assert.rejects(
    run(checkEvidence(seal, ["src/a.ts:3"])),
    /src\/a\.ts:3: line outside file \(2 lines\)/u
  );
});

test("capture retries: the final failure carries the last attempt's reason", async () => {
  const attempts = Ref.makeUnsafe(0);

  const drifting = Ref.update(attempts, (n) => n + 1).pipe(
    Effect.andThen(
      Effect.fail(
        new CaptureDrift({ reason: "git listed 2 sections but wrote 1" })
      )
    ),
    settled("Files kept changing while sealing.")
  );

  await assert.rejects(
    runPromise(drifting),
    /^.*Files kept changing while sealing\. Last attempt: git listed 2 sections but wrote 1\.$/u
  );
  assert.equal(Ref.getUnsafe(attempts), 3);
});

/** A permission failure, told as an unreadable file: not "not found", and not relabelled as a rejected anchor or evidence. */
const notMissing = (e: Error) =>
  e.name === "UnreadableFile" &&
  /^Cannot read node_modules\/lib\/index\.js: .*PermissionDenied/u.test(
    e.message
  ) &&
  !/not found|Rejected evidence|Use side:"old"/u.test(e.message);

test(
  "an installed dependency that cannot be read fails as unreadable, not as missing or rejected",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const dir = repo({ ".gitignore": "node_modules/\n", "src/a.ts": "a\n" });
    write(dir, "src/a.ts", "b\n");
    write(dir, "node_modules/lib/index.js", "module.exports = 1\n");
    const file = join(dir, "node_modules/lib/index.js");
    const seal = await local(dir);
    fs.chmodSync(file, 0o000);

    try {
      await assert.rejects(
        run(readable(seal, "node_modules/lib/index.js")),
        notMissing
      );
      await assert.rejects(
        run(checkEvidence(seal, ["node_modules/lib/index.js:1"])),
        notMissing
      );
      await assert.rejects(
        run(
          checkQuote(
            seal,
            at("node_modules/lib/index.js", 1),
            "module.exports = 1"
          )
        ),
        notMissing
      );
      // A dependency that is not there at all is still simply not found.
      await assert.rejects(
        run(readable(seal, "node_modules/lib/missing.js")),
        /not found/u
      );
    } finally {
      fs.chmodSync(file, 0o644);
    }
  }
);

test("history: git refusing a blame is a rejected read in git's words, not empty output", async () => {
  const dir = repo({ "src/a.ts": "a\n" });
  write(dir, "src/a.ts", "b\n");
  g(dir, "commit", "-qam", "second commit");

  const seal = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { commit: "HEAD", kind: "commit" },
    })
  );

  await assert.rejects(
    run(history(seal, { kind: "blame", path: "src/a.ts", start: 5 })),
    (e: Error) =>
      e.name === "InvalidRead" &&
      /git blame failed/u.test(e.message) &&
      /has only 1 line/u.test(e.message)
  );
  await assert.rejects(
    run(history(seal, { kind: "blame", path: "src/nope.ts" })),
    /git blame failed/u
  );
  assert.match(
    await run(history(seal, { kind: "log", path: "src/a.ts" })),
    /second commit/u
  );
});

test("an installed dependency read from disk is withheld when binary or over 4 MiB", async () => {
  const dir = repo({ ".gitignore": "node_modules/\n", "src/a.ts": "a\n" });
  write(dir, "src/a.ts", "b\n");
  fs.mkdirSync(join(dir, "node_modules/lib"), { recursive: true });
  fs.writeFileSync(
    join(dir, "node_modules/lib/addon.node"),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1])
  );
  fs.writeFileSync(
    join(dir, "node_modules/lib/big.js"),
    "x".repeat(4 * 1024 * 1024 + 1)
  );
  write(dir, "node_modules/lib/index.js", "module.exports = 1\n");
  const seal = await local(dir);

  await assert.rejects(
    run(readable(seal, "node_modules/lib/addon.node")),
    (e: Error) => e.name === "Withheld" && /binary file/u.test(e.message)
  );
  await assert.rejects(
    run(readable(seal, "node_modules/lib/big.js")),
    (e: Error) =>
      e.name === "Withheld" && /is 4194305 bytes.*over 4 MiB/u.test(e.message)
  );
  assert.deepEqual(await run(readable(seal, "node_modules/lib/index.js")), {
    content: "module.exports = 1\n",
    live: true,
  });
});

test("a file renamed from a secret-like path is withheld on the sealed side only, from one lookup", async () => {
  const dir = repo({ ".env": "TOKEN=1\n", "src/a.ts": "a\n" });
  g(dir, "mv", ".env", "config.txt");
  const seal = await local(dir);
  const copied = fromSecrets(seal);

  assert.deepEqual([...copied], ["config.txt"]);
  assert.ok(isWithheld(seal, "config.txt"));
  assert.ok(isWithheld(seal, "config.txt", "new", copied));
  assert.ok(!isWithheld(seal, "config.txt", "old", copied));
  assert.ok(isWithheld(seal, ".env", "old", copied));
  assert.ok(!isWithheld(seal, "src/a.ts", "new", copied));
  assert.match(await run(listFiles(seal)), /^config\.txt {2}\(withheld\)$/mu);
});
