import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import {
  grepSealed,
  history,
  listFiles,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  readLines,
  renderRegions,
} from "../src/browse.ts";
import { budget, budgetLine } from "../src/budget.ts";
import { childFailures } from "../src/children.ts";
import { command } from "../src/command.ts";
import {
  checkEvidence,
  checkQuote,
  depsOf,
  readable,
  sealedFile,
} from "../src/content.ts";
import {
  coverageSummary,
  dispose,
  markShown,
  nextRegions,
} from "../src/coverage.ts";
import { assemble, buildRegions, RawDiff } from "../src/diff.ts";
import { isSecret } from "../src/exclusions.ts";
import { Git } from "../src/git.ts";
import {
  currentSeverity,
  decide,
  reopen,
  unresolved,
  verdictError,
} from "../src/ledger.ts";
import { RepoPath, RepoScope } from "../src/model.ts";
import type {
  Actor,
  Entry,
  Ledger,
  Mode,
  Seal,
  Verdict,
} from "../src/model.ts";
import { platformLayer } from "../src/platform.ts";
import type { Platform } from "../src/platform.ts";
import { assess, finalize, renderReport } from "../src/report.ts";
import {
  changedSinceSeal,
  createSeal,
  recheckSeal,
  refreshSeal,
} from "../src/seal.ts";
import { SettingsStore } from "../src/settings.ts";
import { StateRoot, Store } from "../src/store.ts";
import { currentFingerprint } from "../src/target.ts";

const present = <T>(value: T | null | undefined): T => {
  assert.ok(value !== undefined && value !== null, "expected a value");

  return value;
};

const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = fs;

const { join } = nodePath;
const state = mkdtempSync(join(tmpdir(), "directorate-state-"));

const platformWithEnv = (env: Record<string, string>) =>
  platformLayer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))
  );

/** The platform, with seals stored under this suite's temporary state directory. */
const testPlatform = platformWithEnv({ DIRECTORATE_STATE_DIR: state });

const run = <A, E>(effect: Effect.Effect<A, E, Platform>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testPlatform)));

// The seal store, as the tests reach it.
const store = Effect.service(Store);
const diffFile = (s: Seal) => store.pipe(Effect.map((st) => st.diffFile(s)));

const loadSeal = (id: string) =>
  store.pipe(Effect.flatMap((st) => st.load(id)));

const loadLedger = (id: string) =>
  store.pipe(Effect.flatMap((st) => st.loadLedger(id)));

/** The seal with each region changed by `f`. */
const regions = (
  s: Seal,
  f: (r: Seal["regions"][number], i: number) => Partial<Seal["regions"][number]>
): Seal => ({ ...s, regions: s.regions.map((r, i) => ({ ...r, ...f(r, i) })) });

const settingsFile = (env: Record<string, string>) =>
  Effect.runPromise(
    SettingsStore.use((s) => s.file("global", "/x/repo")).pipe(
      Effect.provide(platformWithEnv(env))
    )
  );

test("the global settings file follows OpenCode's config directory: DIRECTORATE_SETTINGS, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, HOME", async () => {
  const all = {
    DIRECTORATE_SETTINGS: "/x/directorate.json",
    HOME: "/x/home",
    OPENCODE_CONFIG_DIR: "/x/oc",
    XDG_CONFIG_HOME: "/x/xdg",
  };

  assert.equal(await settingsFile(all), "/x/directorate.json");
  assert.equal(
    await settingsFile({ ...all, DIRECTORATE_SETTINGS: "" }),
    "/x/oc/directorate.json"
  );
  assert.equal(
    await settingsFile({ HOME: "/x/home", XDG_CONFIG_HOME: "/x/xdg" }),
    "/x/xdg/opencode/directorate.json"
  );
  assert.equal(
    await settingsFile({ HOME: "/x/home" }),
    "/x/home/.config/opencode/directorate.json"
  );
});

const stateRoot = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.service(StateRoot).pipe(Effect.provide(platformWithEnv(env)))
  );

test("the state root comes from Effect Config: DIRECTORATE_STATE_DIR, then XDG_STATE_HOME, then HOME", async () => {
  assert.equal(
    await stateRoot({
      DIRECTORATE_STATE_DIR: "/x/directorate",
      HOME: "/x/home",
      XDG_STATE_HOME: "/x/xdg",
    }),
    "/x/directorate"
  );
  assert.equal(
    await stateRoot({ HOME: "/x/home", XDG_STATE_HOME: "/x/xdg" }),
    "/x/xdg/opencode-directorate"
  );
  assert.equal(
    await stateRoot({ HOME: "/x/home" }),
    "/x/home/.local/state/opencode-directorate"
  );
});

test("the command adapter keeps argv and binary output intact, and caps each output stream", async () => {
  const argv = "a b; literal";
  const options = { maxOutputBytes: 32, timeout: 5000 };

  const out = await run(
    command(
      process.execPath,
      [
        "-e",
        "process.stdout.write(Buffer.from([0, 255])); process.stdout.write(process.argv[1])",
        argv,
      ],
      options
    )
  );

  assert.deepEqual(
    out,
    Buffer.concat([Buffer.from([0, 255]), Buffer.from(argv)])
  );

  const exceedsCap = (stream: "stdout" | "stderr") =>
    assert.rejects(
      run(
        command(
          process.execPath,
          ["-e", `process.${stream}.write(Buffer.alloc(33))`],
          options
        )
      ),
      new RegExp(`${stream} exceeded 32 bytes`, "u")
    );

  await exceedsCap("stdout");
  await exceedsCap("stderr");
});

test(
  "interrupting the command waits for the spawned process to exit",
  { timeout: 5000 },
  async () => {
    await run(
      Effect.gen(function* simulateExit() {
        const spawner = yield* ChildProcessSpawner;
        const started = yield* Deferred.make<number>();

        const withPid = {
          ...spawner,
          spawn: (...args: Parameters<typeof spawner.spawn>) =>
            spawner
              .spawn(...args)
              .pipe(
                Effect.tap((child) => Deferred.succeed(started, child.pid))
              ),
        };

        const fiber = yield* command(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { timeout: 10_000 }
        ).pipe(
          Effect.provideService(ChildProcessSpawner, withPid),
          Effect.forkChild
        );

        const pid = yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      })
    );
  }
);

const dirs: string[] = [state];

after(() => {
  for (const d of dirs) {
    rmSync(d, { force: true, recursive: true });
  }
});

const g = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString();

const MATH = "export function div(a: number, b: number) {\n  return a / b\n}\n";

const defaultFiles = {
  "package-lock.json": "{}\n",
  "src/math.ts": MATH,
};

const write = (dir: string, p: string, c: string | Buffer) => {
  mkdirSync(join(dir, p, ".."), { recursive: true });
  writeFileSync(join(dir, p), c);
};

const repo = (
  files: Record<string, string | Buffer> = defaultFiles
): string => {
  const dir = mkdtempSync(join(tmpdir(), "directorate-repo-"));
  dirs.push(dir);
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@e.com");
  g(dir, "config", "user.name", "t");

  for (const [p, c] of Object.entries(files)) {
    write(dir, p, c);
  }

  g(dir, "add", ".");
  g(dir, "commit", "-qm", "init");

  return dir;
};

const scout = { agent: "directorate_auditor", session: "s-scout" };
const lead = { agent: "directorate_liaison", session: "s-lead" };
const refuter = { agent: "directorate_compliance", session: "s-ref" };

const local = async (dir: string, mode: Mode = "default") =>
  await run(
    createSeal({ mode, owner: lead, repo: dir, target: { kind: "local" } })
  );

test("paths capture and freshness interpret bracketed directories literally", async () => {
  const dir = repo({
    "[route]/tracked.ts": "inside\n",
    "r/tracked.ts": "outside\n",
  });

  write(dir, "[route]/new.ts", "new inside\n");
  write(dir, "r/new.ts", "new outside\n");

  const seal = await run(
    createSeal({
      mode: "default",
      repo: dir,
      target: { kind: "paths", paths: ["[route]/"] },
    })
  );

  assert.deepEqual(
    seal.files.map((f) => f.path),
    ["[route]/new.ts", "[route]/tracked.ts"]
  );
  assert.deepEqual(
    seal.regions.map((r) => r.file),
    ["[route]/new.ts", "[route]/tracked.ts"]
  );
  write(dir, "r/tracked.ts", "changed outside\n");
  const fingerprintResult = await run(currentFingerprint(seal));
  assert.equal(fingerprintResult.fingerprint, seal.fingerprint);
  write(dir, "[route]/tracked.ts", "changed inside\n");
  const fingerprintResult2 = await run(currentFingerprint(seal));
  assert.notEqual(fingerprintResult2.fingerprint, seal.fingerprint);

  const diff = await run(
    createSeal({
      mode: "default",
      repo: dir,
      target: { kind: "local", paths: ["[route]"] },
    })
  );

  assert.deepEqual(diff.files.map((f) => f.path).toSorted(), [
    "[route]/new.ts",
    "[route]/tracked.ts",
  ]);

  const matches = await run(
    grepSealed(diff, "changed", { paths: ["[route]"] })
  );

  assert.match(matches, /^\[route\]\/tracked.ts:/mu);
  assert.doesNotMatch(matches, /^r\//mu);
  const outside = await run(readLines(diff, "r/tracked.ts", "new"));
  assert.match(
    outside,
    /base .*outside the sealed scope; working tree not captured/u
  );
  assert.doesNotMatch(outside, /changed outside/u);
});

test("unsupported targets reject path restrictions rather than widen the review", async () => {
  const dir = repo({ "a/file.ts": "a\n", "b/file.ts": "b\n" });

  await Promise.all(
    (["commit", "auto", "range", "pr"] as const).map((kind) =>
      assert.rejects(
        run(
          createSeal({
            mode: "default",
            repo: dir,
            target: { kind, paths: ["a"] },
          })
        ),
        /does not support paths/u
      )
    )
  );
});

test("paths seal does not expose a base blob as the post-image of an absent sparse file", async () => {
  const dir = repo({
    "hidden/file.ts": "not checked out\n",
    "visible/file.ts": "visible\n",
  });

  g(dir, "sparse-checkout", "set", "--cone", "visible");

  const seal = await run(
    createSeal({ mode: "default", repo: dir, target: { kind: "paths" } })
  );

  assert.equal(
    seal.files.find((f) => f.path === "hidden/file.ts")?.status,
    "deleted"
  );
  assert.ok(seal.regions.every((r) => r.file !== "hidden/file.ts"));
  assert.doesNotMatch(await run(listFiles(seal)), /hidden\/file.ts/u);
  await assert.rejects(
    run(readLines(seal, "hidden/file.ts", "new")),
    /does not exist/u
  );
});

test("a recreated staged deletion is present in the sealed diff, listing and new-side read", async () => {
  const dir = repo({
    "src/a.ts": "context\noriginal\n",
    "src/same.ts": "same\n",
  });

  g(dir, "rm", "--cached", "src/a.ts");
  g(dir, "rm", "--cached", "src/same.ts");
  write(dir, "src/a.ts", "context\nreplacement\n");
  const seal = await local(dir);
  const patch = readFileSync(await run(diffFile(seal)), "utf-8");
  assert.match(patch, /^-original$/mu);
  assert.match(patch, /^\+replacement$/mu);
  assert.match(patch, /^ context$/mu);
  assert.doesNotMatch(patch, /src\/same.ts/u);
  assert.ok(seal.regions.every((r) => r.file !== "src/same.ts"));
  assert.deepEqual(
    seal.files.map(({ path, status }) => [path, status]),
    [["src/a.ts", "modified"]]
  );
  assert.match(await run(listFiles(seal, "src")), /^src\/a\.ts$/mu);
  assert.deepEqual(await run(readable(seal, "src/a.ts")), {
    content: "context\nreplacement\n",
    live: false,
  });
});

test("history clips long patch lines even when all clipped lines fit on one page", async () => {
  const dir = repo({ "long.ts": `${"x".repeat(60_000)}\n` });
  const seal = await local(dir);

  const result = await run(
    history(seal, { kind: "show", path: "long.ts", rev: "HEAD" })
  );

  assert.ok(Buffer.byteLength(result) <= OUTPUT_MAX_BYTES);
  assert.match(result, /^\+x+ …$/mu);
});

/** Fixture timestamp. */
const T0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

test("only a subsequent successful retry clears a failed question", async () => {
  const seal = await local(repo());

  const first = {
    agent: scout.agent,
    call: "first",
    prompt: "question: same",
    startedAt: T0,
    status: "completed",
  } as const;

  const failed = {
    ...first,
    call: "failed",
    prompt: "question: same\ncheck the guard",
    status: "failed",
  } as const;

  const reviewed = { ...seal, children: [first, failed], regions: [] };
  assert.deepEqual(childFailures(reviewed), [failed]);
  assert.equal(
    assess(reviewed, { entries: [], notes: [] }, {}, "normal").status,
    "partial"
  );
  assert.equal(
    assess(
      {
        ...reviewed,
        children: [...reviewed.children, { ...first, call: "retry" }],
      },
      { entries: [], notes: [] },
      {},
      "normal"
    ).status,
    "complete"
  );
});

const at = (path: string, line: number, side: "new" | "old" = "new") => ({
  endLine: line,
  line,
  path,
  side,
});

const entry = (id: string, o: Partial<Entry> = {}): Entry => ({
  anchor: at("src/math.ts", 2),
  consequence: "Infinity",
  createdAt: T0,
  evidence: ["src/math.ts:2"],
  id,
  kind: "defect",
  lens: "c",
  quote: "  return a / b",
  raisedBy: scout,
  severity: "minor",
  status: "open",
  title: `title ${id}`,
  trigger: "b=0",
  verdicts: [],
  ...o,
});

// ---------- parsing ----------
test("diff parsing: names from raw records, hunks and offsets from the patch, mode-only changes", async () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "index 1..2 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    " x",
    "+y",
    " z",
    "@@ -10,1 +11,1 @@",
    "-q",
    "+r",
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
    "",
  ].join("\n");

  const pieces = Schema.decodeSync(RawDiff)(
    `:100644 100644 1 2 M\0a.ts\0:100644 100755 3 3 M\0run.sh\0\0${patch}`
  );

  const { text, files } = assemble(pieces);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.added, f.removed]),
    [
      ["a.ts", "modified", 2, 1],
      ["run.sh", "mode", 0, 0],
    ]
  );
  const builtRegions = await run(buildRegions(files, text));
  assert.deepEqual(
    builtRegions.map((r) => [r.id, r.file, r.newStart, r.newEnd]),
    [
      ["R1", "a.ts", 1, 3],
      ["R2", "a.ts", 11, 11],
      ["R3", "run.sh", 0, 0],
    ]
  );
  assert.throws(
    () =>
      Schema.decodeSync(RawDiff)(
        `:100644 100644 1 2 M\0a.ts\0:100644 100644 1 2 M\0b.ts\0\0${patch.split("diff --git a/run.sh")[0]}`
      ),
    /git listed 2 patch sections but wrote 1/u,
    "records without their sections"
  );
});

test("names git quotes in patch headers (quotes, tabs, non-ASCII) seal exactly; a quoted secret stays withheld", async () => {
  const dir = repo({
    "café.ts": "b\n",
    "has space.ts": "a\n",
    'my"dir/.env': "TOKEN=one\n",
    "plain.ts": "p\n",
    "t.ts": "t\n",
  });

  write(dir, "has space.ts", "a\nconst x = 1\n");
  write(dir, "café.ts", "b\nconst y = 2\n");
  write(dir, "tab\there.ts", "const tab = 1\n");
  g(dir, "mv", "plain.ts", 'ren"amed.ts');
  unlinkSync(join(dir, "t.ts"));
  symlinkSync("plain.ts", join(dir, "t.ts"));
  write(dir, 'my"dir/.env', "TOKEN=supersecret\n");
  const seal = await local(dir);
  const byPath = new Map(seal.files.map((f) => [f.path, f]));
  assert.deepEqual([...byPath.keys()].toSorted(), [
    "café.ts",
    "has space.ts",
    'my"dir/.env',
    'ren"amed.ts',
    "t.ts",
    "tab\there.ts",
  ]);
  assert.deepEqual(
    [
      present(byPath.get('ren"amed.ts')).status,
      present(byPath.get('ren"amed.ts')).oldPath,
    ],
    ["renamed", "plain.ts"]
  );
  assert.equal(
    present(byPath.get("t.ts")).status,
    "modified",
    "a typechange is one file with both of git's sections"
  );
  assert.match(present(byPath.get('my"dir/.env')).excluded ?? "", /secret/u);
  assert.ok(
    !readFileSync(await run(diffFile(seal)), "utf-8").includes("supersecret")
  );
  assert.ok(await run(checkQuote(seal, at("has space.ts", 2), "const x = 1")));
  assert.ok(await run(checkQuote(seal, at("café.ts", 2), "const y = 2")));
  assert.ok(
    await run(checkQuote(seal, at("tab\there.ts", 1), "const tab = 1"))
  );
  const tc = seal.regions.filter((r) => r.file === "t.ts");
  assert.ok(tc.length >= 2, "both sections of the typechange are regions");
  const shown = await run(renderRegions(seal, tc));
  assert.match(shown.text, /-t$/mu);
  assert.match(shown.text, /\+symlink -> plain\.ts|\+plain\.ts/mu);
});

const decodePath = Schema.decodeOption(RepoPath);
const decodeScope = Schema.decodeOption(RepoScope);

test("tool paths decode to the repository's form: contained, normalized, the root only as a scope", () => {
  for (const bad of ["../etc/passwd", "/etc/passwd", "", ".", "a/.."]) {
    assert.ok(Option.isNone(decodePath(bad)), bad);
  }

  assert.deepEqual(
    [
      Option.getOrThrow(decodePath(" ./a//./b c.ts ")),
      Option.getOrThrow(decodePath("a/../b")),
    ],
    ["a/b c.ts", "b"]
  );
  assert.deepEqual(
    [".", "", "./src/"].map((v) => Option.getOrThrow(decodeScope(v))),
    ["", "", "src"]
  );
  assert.ok(Option.isNone(decodeScope("../x")));
});

// ---------- sealing ----------
test("local seal: staged+unstaged+untracked, secrets withheld, symlinks as link text, snapshot survives later edits", async () => {
  const dir = repo();
  write(
    dir,
    "src/math.ts",
    `${MATH}export const half = (n: number) => div(n, 2)\n`
  );
  write(dir, "src/new.ts", "export const x = 1\n");
  write(dir, ".env", "TOKEN=supersecret\n");
  symlinkSync("/etc/hosts", join(dir, "src/link.ts"));
  const seal = await local(dir);
  assert.deepEqual(seal.files.map((f) => f.path).toSorted(), [
    ".env",
    "src/link.ts",
    "src/math.ts",
    "src/new.ts",
  ]);
  const diff = readFileSync(await run(diffFile(seal)), "utf-8");
  assert.ok(!diff.includes("supersecret"));
  assert.match(diff, /symlink -> \/etc\/hosts/u);
  assert.ok(!diff.includes("localhost"));
  write(dir, "src/math.ts", "changed\n");
  assert.match((await run(sealedFile(seal, "src/math.ts"))) ?? "", /half/u);
  await assert.rejects(run(readLines(seal, ".env", "new")), /withheld/u);
});

test("seal race: an edit during capture forces a retry, so the diff and snapshot agree", async () => {
  const dir = repo();
  write(dir, "src/math.ts", `${MATH}// edit one\n`);
  let edits = 0;

  const seal = await run(
    createSeal({
      beforeCapture: () =>
        Effect.sync(() => {
          edits += 1;

          if (edits === 1) {
            write(dir, "src/math.ts", `${MATH}// edit two\n`);
          }
        }),
      mode: "default",
      owner: lead,
      repo: dir,
      target: { kind: "local" },
    })
  );

  assert.match(
    readFileSync(await run(diffFile(seal)), "utf-8"),
    /\+\/\/ edit two/u
  );
  assert.match((await run(sealedFile(seal, "src/math.ts"))) ?? "", /edit two/u);
  await assert.rejects(
    run(
      createSeal({
        beforeCapture: () =>
          Effect.sync(() =>
            write(dir, "src/math.ts", `${MATH}// ${(edits += 1)}\n`)
          ),
        mode: "default",
        owner: lead,
        repo: dir,
        target: { kind: "local" },
      })
    ),
    /kept changing/u
  );
});

test("auto target: local changes if any, else the branch against the default branch", async () => {
  const dir = repo();
  g(dir, "checkout", "-q", "-b", "feat");
  write(dir, "src/math.ts", `${MATH}// feat\n`);
  g(dir, "commit", "-qam", "feat");

  const s1 = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { kind: "auto" },
    })
  );

  assert.match(s1.description, /^branch 1 commit ahead of main \(/u);
  assert.match(readFileSync(await run(diffFile(s1)), "utf-8"), /\+\/\/ feat/u);
  write(dir, "src/new.ts", "export const n = 1\n");

  const s2 = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { kind: "auto" },
    })
  );

  assert.match(
    s2.description,
    /^branch 1 commit ahead of main plus local changes/u
  );
  const d2 = readFileSync(await run(diffFile(s2)), "utf-8");
  assert.ok(
    d2.includes("+// feat") && d2.includes("+export const n = 1"),
    "branch commits and local edits are both reviewed"
  );
  const dir2 = repo();
  write(dir2, "src/math.ts", "x\n");

  const descriptionResult = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir2,
      target: { kind: "auto" },
    })
  );

  assert.match(descriptionResult.description, /^local changes/u);

  const s3 = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { base: "@default", kind: "range" },
    })
  );

  assert.match(s3.description, /^main\.\.\.HEAD/u);
});

// ---------- path policy ----------
test("deleted and renamed-away paths have no new side; paths mode records deletions", async () => {
  const dir = repo({
    "src/keep.ts": "k\n",
    "src/math.ts": MATH,
    "src/old.ts": "export const o = 1\n",
  });

  unlinkSync(join(dir, "src/math.ts"));
  g(dir, "mv", "src/old.ts", "src/renamed.ts");
  const seal = await local(dir);
  assert.ok(
    seal.deleted.includes("src/math.ts") && seal.deleted.includes("src/old.ts"),
    JSON.stringify(seal.deleted)
  );
  assert.equal(await run(sealedFile(seal, "src/old.ts")), undefined);
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 2), "return a / b")),
    /does not exist/u
  );
  assert.ok(
    await run(checkQuote(seal, at("src/math.ts", 2, "old"), "return a / b"))
  );

  const p = await run(
    createSeal({
      mode: "full",
      owner: lead,
      repo: dir,
      target: { kind: "paths", paths: ["src"] },
    })
  );

  assert.ok(p.deleted.includes("src/math.ts"));
  assert.equal(await run(sealedFile(p, "src/math.ts")), undefined);
});

test("path policy: symlinked parents withheld; secrets through symlinks, .git, and unignored live files refused", async () => {
  const outside = mkdtempSync(join(tmpdir(), "directorate-out-"));
  dirs.push(outside);
  writeFileSync(join(outside, "a.ts"), "OUTSIDE-SECRET\n");

  const dir = repo({
    ".gitignore": "notes/\nnode_modules/\n",
    "lib/a.ts": "inside\n",
    "src/x.ts": "x\n",
  });

  rmSync(join(dir, "lib"), { recursive: true });
  symlinkSync(outside, join(dir, "lib"));
  const seal = await local(dir);

  const blob =
    readFileSync(await run(diffFile(seal)), "utf-8") +
    ((await run(sealedFile(seal, "lib/a.ts"))) ?? "");

  assert.ok(
    !blob.includes("OUTSIDE-SECRET"),
    "never read through a symlinked directory"
  );

  const dir2 = repo({
    ".gitignore": "notes/\nnode_modules/\n",
    "src/x.ts": "x\n",
  });

  write(dir2, ".env", "API_KEY=leak\n");
  mkdirSync(join(dir2, "notes"));
  symlinkSync("../.env", join(dir2, "notes/x.txt"));
  write(dir2, "node_modules/lib/index.js", "module.exports = 1\n");
  write(dir2, "wip.ts", "untracked\n");

  const c = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir2,
      target: { commit: "HEAD", kind: "commit" },
    })
  );

  await assert.rejects(
    run(readable(c, "notes/x.txt")),
    /not found at the seal/u,
    "ignored non-dependency files are not readable"
  );
  mkdirSync(join(dir2, "node_modules/evil"), { recursive: true });
  symlinkSync("../../.env", join(dir2, "node_modules/evil/x.js"));
  await assert.rejects(
    run(readable(c, "node_modules/evil/x.js")),
    /withheld/u,
    "a dependency symlink to a secret is withheld"
  );
  await assert.rejects(run(readable(c, ".git/config")), /withheld/u);
  await assert.rejects(run(readable(c, "wip.ts")), /not found at the seal/u);
  const liveResult = await run(readable(c, "node_modules/lib/index.js"));
  assert.equal(liveResult.live, true);
  // Bun and pnpm link a workspace's packages into a store; git refuses paths beyond the link, so the target is checked.
  write(
    dir2,
    "node_modules/.bun/pkg@1.0.0+abc123/node_modules/pkg/index.js",
    "module.exports = 2\n"
  );
  mkdirSync(join(dir2, "app/node_modules"), { recursive: true });
  symlinkSync(
    "../../node_modules/.bun/pkg@1.0.0+abc123/node_modules/pkg",
    join(dir2, "app/node_modules/pkg")
  );
  assert.deepEqual(await run(readable(c, "app/node_modules/pkg/index.js")), {
    content: "module.exports = 2\n",
    live: true,
  });
  await assert.rejects(
    run(readable(c, "app/node_modules/pkg/missing.js")),
    /not found/u
  );
});

test("SHA-256 repositories: a first-commit-to-be and a root commit seal against their own empty tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "directorate-repo-"));
  dirs.push(dir);
  g(dir, "init", "-q", "-b", "main", "--object-format=sha256");
  g(dir, "config", "user.email", "t@e.com");
  g(dir, "config", "user.name", "t");
  write(dir, "a.ts", "export const a = 1\n");
  const unborn = await local(dir);
  assert.deepEqual(
    unborn.files.map((f) => [f.path, f.status]),
    [["a.ts", "added"]]
  );
  assert.equal(
    await run(sealedFile(unborn, "a.ts", "old")),
    undefined,
    "the empty base has no files"
  );
  assert.equal(
    await run(history(unborn, { kind: "log" })),
    "(no committed history)"
  );
  g(dir, "add", ".");
  g(dir, "commit", "-qm", "root");

  const root = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { commit: "HEAD", kind: "commit" },
    })
  );

  assert.deepEqual(
    root.files.map((f) => [f.path, f.status]),
    [["a.ts", "added"]]
  );
  assert.match(
    (await run(sealedFile(root, "a.ts"))) ?? "",
    /export const a = 1/u
  );
});

test("a shallow boundary is not a root commit when sealing a commit review", async () => {
  const dir = repo({ "gone.txt": "gone\n", "kept.txt": "kept\n" });
  g(dir, "rm", "gone.txt");
  g(dir, "commit", "-qm", "delete a file");
  const shallow = join(dir, "shallow");
  g(dir, "clone", "-q", "--depth=1", pathToFileURL(dir).href, shallow);

  const reviewCommit = () =>
    run(
      createSeal({
        mode: "default",
        owner: lead,
        repo: shallow,
        target: { commit: "HEAD", kind: "commit" },
      })
    );

  await assert.rejects(
    reviewCommit(),
    /first parent is not available.*Deepen/u
  );

  g(shallow, "fetch", "-q", "--deepen=1");
  const seal = await reviewCommit();
  assert.deepEqual(
    seal.files.map((f) => [f.path, f.status]),
    [["gone.txt", "deleted"]]
  );
});

test("reading a sealed blob fails when git fails, instead of reading as a missing file", async () => {
  const dir = repo();

  const seal = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { commit: "HEAD", kind: "commit" },
    })
  );

  // git exits 1 for cat-file here, which is not git's "no such path" (128). Fresh: the suite's Git is already built.
  const failingGit = Layer.fresh(Git.layer).pipe(
    Layer.provide(
      Layer.effect(
        ChildProcessSpawner,
        Effect.service(ChildProcessSpawner).pipe(
          Effect.map((spawner) => ({
            ...spawner,
            spawn: (cmd: ChildProcess.Command) =>
              spawner.spawn(
                ChildProcess.isStandardCommand(cmd) &&
                  cmd.args.includes("cat-file")
                  ? ChildProcess.make("false", [])
                  : cmd
              ),
          }))
        )
      )
    )
  );

  const read = (path: string) =>
    run(sealedFile(seal, path).pipe(Effect.provide(failingGit)));

  await assert.rejects(read("src/math.ts"), /Cannot read src\/math\.ts/u);
  assert.equal(
    await run(sealedFile(seal, "nope.ts")),
    undefined,
    "a path not in the revision is still absent"
  );
});

test("grep withholds secrets by their full name, even one containing a colon", async () => {
  const dir = repo();
  write(dir, "conf:prod/.env", "TOKEN=supersecret\n");
  write(dir, "a:b.ts", "const TOKEN = 1\n");
  const seal = await local(dir);
  const out = await run(grepSealed(seal, "TOKEN"));
  assert.ok(!out.includes("supersecret"), out);
  assert.match(out, /^a:b\.ts:1:const TOKEN = 1$/mu);
});

test("store: legacy seals migrate on load; malformed seals and ledgers are damaged, not defaults", async () => {
  const dir = repo();
  write(dir, "src/math.ts", `${MATH}// edit\n`);
  const seal = await local(dir);
  const file = join(state, seal.id, "seal.json");
  const legacy = JSON.parse(readFileSync(file, "utf-8"));

  delete legacy.gen;
  delete legacy.refreshes;
  delete legacy.children;
  delete legacy.deleted;

  for (const r of legacy.regions) {
    delete r.readBy;
  }

  legacy.gates = {
    children: true,
    coverage: true,
    freshness: true,
    open: true,
  };
  writeFileSync(file, JSON.stringify(legacy));
  const loaded = await run(loadSeal(seal.id));
  assert.deepEqual(
    [
      loaded.gen,
      loaded.refreshes,
      loaded.children,
      loaded.deleted,
      loaded.regions[0]?.readBy,
    ],
    [0, 0, [], [], []]
  );
  assert.deepEqual(
    loaded.gates,
    { children: [], coverage: [], freshness: "", open: [] },
    "a legacy true gate matches nothing new"
  );
  await run(store.pipe(Effect.flatMap((st) => st.save(loaded))));
  assert.deepEqual(
    JSON.parse(readFileSync(file, "utf-8")).gates,
    loaded.gates,
    "saved in the current format"
  );

  // A non-ISO deadline used to parse as NaN, which made the watchdog report at once.
  const rejectsSeal = async (json: string) => {
    writeFileSync(file, json);
    await assert.rejects(run(loadSeal(seal.id)), /is damaged/u);
  };

  await rejectsSeal(JSON.stringify({ ...legacy, deadline: "soon" }));
  await rejectsSeal(JSON.stringify({ ...legacy, mode: "fast" }));
  await rejectsSeal(JSON.stringify([legacy]));

  writeFileSync(
    join(state, seal.id, "ledger.json"),
    JSON.stringify({ entries: [{ id: "F1" }], notes: [] })
  );
  await assert.rejects(
    run(loadLedger(seal.id)),
    /damaged; refusing to treat it as empty/u
  );
});

const root = process.getuid?.() === 0;

test(
  "worktree read errors fail the capture; withheld files are never read and secrets stay secrets",
  { skip: root && "root reads anything" },
  async () => {
    const dir = repo();
    write(dir, "src/locked.ts", "export const x = 1\n");
    fs.chmodSync(join(dir, "src/locked.ts"), 0o000);

    try {
      await assert.rejects(
        run(
          createSeal({
            mode: "default",
            owner: lead,
            repo: dir,
            target: { kind: "local" },
          })
        ),
        /Cannot read src\/locked\.ts/u,
        "not sealed as a deletion"
      );
    } finally {
      fs.chmodSync(join(dir, "src/locked.ts"), 0o644);
    }

    // An unreadable binary .env: paths and local seals list it as a withheld secret without reading it.
    writeFileSync(join(dir, ".env"), Buffer.from([0, 1, 2, 0]));
    fs.chmodSync(join(dir, ".env"), 0o000);

    try {
      const p = await run(
        createSeal({
          mode: "full",
          owner: lead,
          repo: dir,
          target: { kind: "paths" },
        })
      );

      assert.match(
        present(p.files.find((f) => f.path === ".env")).excluded ?? "",
        /secret/u
      );
      const mdResult = await run(finalize(p, { entries: [], notes: [] }, {}));
      assert.match(mdResult.md, /1 changed secret-like file was withheld/u);

      const l = await run(
        createSeal({
          mode: "default",
          owner: lead,
          repo: dir,
          target: { kind: "local", paths: [".env"] },
        })
      );

      assert.match(
        present(l.files.find((f) => f.path === ".env")).excluded ?? "",
        /secret/u
      );
    } finally {
      fs.chmodSync(join(dir, ".env"), 0o644);
    }
  }
);

test(
  "a 200,000-line addition seals: regions number new lines in one pass",
  { timeout: 60_000 },
  async () => {
    const dir = repo();
    write(
      dir,
      "big.txt",
      `${Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join("\n")}\n`
    );

    const regionsResult = await local(dir);

    const bigRegions = regionsResult.regions.filter(
      (r) => r.file === "big.txt"
    );

    assert.equal(
      bigRegions.length,
      Math.ceil(200_001 / 400),
      "the @@ line plus 200,000 added lines, 400 patch lines per region"
    );
    assert.deepEqual(
      [
        bigRegions[0]?.newStart,
        bigRegions[0]?.newEnd,
        bigRegions[1]?.newStart,
        bigRegions.at(-1)?.newEnd,
      ],
      [1, 399, 400, 200_000]
    );

    // Later chunks render from their own start, numbered as the hunk would number them.
    const mid = present(bigRegions[250]);
    const tail = await run(renderRegions(regionsResult, [mid]));
    assert.deepEqual([mid.newStart, mid.newEnd], [100_000, 100_399]);
    assert.match(tail.text, /^\s+100000 \+line 99999$/mu);
    assert.match(tail.text, /^\s+100399 \+line 100398$/mu);

    const end = await run(
      renderRegions(regionsResult, [present(bigRegions.at(-1))])
    );

    assert.match(end.text, /^\s+200000 \+line 199999$/mu);

    const legacy = await run(
      renderRegions(regionsResult, [
        {
          ...mid,
          hunkStart: undefined,
          newLine: undefined,
          oldLine: undefined,
          sectionStart: undefined,
        },
      ])
    );

    assert.equal(
      legacy.text,
      tail.text,
      "regions from older seals render the same by scanning back"
    );
  }
);

test("mode changes count as drift; binary files compare by bytes", async () => {
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 9]);
  const dir = repo({ "img.bin": bin, "run.sh": "echo hi\n" });
  write(dir, "run.sh", "echo hello\n");
  write(dir, "img.bin", Buffer.from([0, 255, 128, 0, 7]));
  const seal = await local(dir);
  assert.deepEqual(
    await run(changedSinceSeal(seal, seal)),
    [],
    "binary snapshot equals live bytes"
  );
  const fingerprintResult3 = await run(currentFingerprint(seal));
  assert.equal(fingerprintResult3.fingerprint, seal.fingerprint);
  fs.chmodSync(join(dir, "run.sh"), 0o755);
  const fingerprintResult4 = await run(currentFingerprint(seal));
  assert.notEqual(fingerprintResult4.fingerprint, seal.fingerprint);
});

// ---------- coverage ----------
test("coverage: size-charged chunks, per-chunk line ranges, owner reads, explicit skips win", async () => {
  const big = `${Array.from(
    { length: 1200 },
    (_, i) => `const v${i} = ${i}`
  ).join("\n")}\n`;

  const dir = repo({ "a.ts": "x\n" });
  write(dir, "big.ts", big);

  const p = await run(
    createSeal({
      mode: "full",
      owner: lead,
      repo: dir,
      target: { kind: "paths", paths: ["big.ts"] },
    })
  );

  assert.equal(
    nextRegions(p, { owner: true, reader: "owner" }).picked.length,
    2
  );

  const ex = nextRegions(p, {
    ids: p.regions.map((r) => r.id),
    owner: true,
    reader: "owner",
  });

  assert.deepEqual(
    [ex.picked.length, ex.omitted],
    [2, ["R3", "R4"]],
    "explicit requests report what they leave out"
  );
  const l = await local(dir);
  assert.deepEqual(
    l.regions.map((r) => [r.newStart, r.newEnd]),
    [
      [1, 399],
      [400, 799],
      [800, 1199],
      [1200, 1200],
    ]
  );
  const R1 = [{ complete: true, id: "R1", next: 0 }];
  const scouted = markShown(l, R1, { key: "s-scout", owner: false });
  assert.equal(
    coverageSummary(scouted).unread.length,
    4,
    "a scout's read does not cover the lead"
  );
  const read = markShown(scouted, R1, { key: "owner", owner: true });
  assert.equal(coverageSummary(read).read, 1);
  assert.deepEqual(
    read.regions[0]?.readBy,
    ["s-scout", "owner"],
    "readers are sessions, so two of one role each read everything"
  );
  assert.equal(
    nextRegions(read, { owner: false, reader: "s-other" }).picked[0]?.id,
    "R1",
    "another reader of the same role still gets R1"
  );
  assert.equal(l.regions[0]?.readBy.length, 0, "the earlier seal is unchanged");
  const cov = coverageSummary(dispose(read, ["R1"], "skipped", "later").seal);
  assert.deepEqual(
    [cov.read, cov.skipped.length],
    [0, 1],
    "an explicit skip overrides the read receipt"
  );
  assert.deepEqual(
    dispose(l, ["R2"], "reviewed", "fine").coerced,
    ["R2"],
    "reviewed needs a reader"
  );
});

test("blank context lines are numbered even when Git is configured to suppress their prefix", async () => {
  const dir = repo({ "sample.txt": "before\n\nold\nafter\n" });
  g(dir, "config", "diff.suppressBlankEmpty", "true");
  write(dir, "sample.txt", "before\n\nnew\nafter\n");

  const seal = await local(dir);
  const { text } = await run(renderRegions(seal, seal.regions));
  assert.match(text, /^\s+3 \+new$/mu);
  assert.equal(present(seal.regions[0]).newEnd, 4);
});

test("renderRegions: old and new line numbers, a byte-bounded page with continuation", async () => {
  const dir = repo();
  write(dir, "src/math.ts", `${MATH}// tail\n`);
  const seal = await local(dir);
  const { text, shown } = await run(renderRegions(seal, seal.regions));
  assert.deepEqual(shown, [{ complete: true, id: "R1", next: 0 }]);
  assert.match(text, /^\s+4 \+\/\/ tail$/mu);
  assert.match(text, /^\s+2\s+2\s+return a \/ b$/mu);

  // Three bytes a character: a character budget would let this page run past OpenCode's 50 KiB cut.
  const wide = `${Array.from(
    { length: 300 },
    (_, i) => `const v${i} = "${"€".repeat(900)}"`
  ).join("\n")}\n`;

  const dir2 = repo({ "a.ts": "x\n" });
  write(dir2, "w.ts", wide);

  const p = await run(
    createSeal({
      mode: "full",
      owner: lead,
      repo: dir2,
      target: { kind: "paths", paths: ["w.ts"] },
    })
  );

  const first = await run(renderRegions(p, p.regions));
  assert.ok(
    Buffer.byteLength(first.text) <= OUTPUT_MAX_BYTES + 500,
    `${Buffer.byteLength(first.text)}`
  );
  const [firstRegion] = first.shown;
  assert.equal(firstRegion?.complete, false);

  const p2 = regions(p, (_, i) =>
    i ? {} : { offsets: { owner: firstRegion.next } }
  );

  const second = await run(renderRegions(p2, p2.regions));
  assert.match(second.text, /continued from body line/u);
  const one = "y".repeat(150_000);
  const dir3 = repo({ "a.ts": "x\n" });
  write(dir3, "one.json", `${one}\n`);

  const p3 = await run(
    createSeal({
      mode: "full",
      owner: lead,
      repo: dir3,
      target: { kind: "paths", paths: ["one.json"] },
    })
  );

  const r3 = await run(renderRegions(p3, p3.regions));
  assert.ok(
    Buffer.byteLength(r3.text) <= OUTPUT_MAX_BYTES + 500,
    "a long line is paged, not dumped"
  );
  assert.match(r3.text, /↪ y{100}/u, "continuation segments");
  assert.equal(
    r3.shown[0]?.complete,
    false,
    "a region is complete only when every segment was shown"
  );

  const pages = await run(
    Effect.gen(function* countPages() {
      let paged = markShown(p3, r3.shown, { key: "owner", owner: true });
      let pageCount = 1;

      for (let done = false; !done && pageCount < 10; pageCount += 1) {
        const r = yield* renderRegions(paged, paged.regions);
        const [receipt] = r.shown;
        assert.ok(receipt);
        done = receipt.complete;
        paged = markShown(paged, r.shown, { key: "owner", owner: true });
      }

      return pageCount;
    })
  );

  assert.ok(pages >= 3 && pages < 10, `paged in ${pages} calls`);
  const rl = await run(readLines(p3, "one.json", "new"));
  assert.match(rl, /only the first \d+ are shown/u);
  assert.ok(
    Buffer.byteLength(await run(readLines(p, "w.ts", "new"))) <=
      OUTPUT_MAX_BYTES + 500,
    "directorate_read pages by bytes too"
  );
  const short = `${Array.from({ length: 3000 }, () => "x").join("\n")}\n`;
  write(dir3, "short.ts", short);

  const p4 = await run(
    createSeal({
      mode: "full",
      owner: lead,
      repo: dir3,
      target: { kind: "paths", paths: ["short.ts"] },
    })
  );

  const many = await run(renderRegions(p4, p4.regions));
  assert.ok(
    many.text.split("\n").length <= OUTPUT_MAX_LINES + 20,
    "and by lines"
  );
});

// ---------- quotes and evidence ----------
test("quotes: exact lines pass and snap to the real line; fragments and hallucinations fail", async () => {
  const dir = repo();
  write(
    dir,
    "src/math.ts",
    `${MATH}\n\n\n\n\n\nexport const z = div(1, 0)\n}\n`
  );
  const seal = await local(dir);
  assert.deepEqual(
    await run(
      checkQuote(seal, at("src/math.ts", 10), "export const z = div(1, 0)")
    ),
    at("src/math.ts", 10)
  );

  const lineResult = await run(
    checkQuote(seal, at("src/math.ts", 8), "export const z = div(1, 0)")
  );

  assert.equal(lineResult.line, 10, "snapped");
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 11), "}")),
    /too short/u,
    "a lone brace identifies nothing"
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 10), "div(1, 0)")),
    /fragment/u
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 1), "b: number) {\nreturn a /")),
    /fragment/u
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 10), "return a % b")),
    /does not appear/u
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 1), "export const z = div(1, 0)")),
    /appears at line 10/u
  );

  const multi = await run(
    checkQuote(
      seal,
      at("src/math.ts", 1),
      "export function div(a: number, b: number) {\n  return a / b"
    )
  );

  assert.deepEqual([multi.line, multi.endLine], [1, 2]);
});

test("evidence: sealed files, ignored dependencies, URLs; paths normalized; bad refs rejected", async () => {
  const dir = repo({ ".gitignore": "node_modules/\n", "src/math.ts": MATH });
  write(dir, "src/math.ts", "export const z = 1\n");
  write(dir, "node_modules/lib/index.js", "module.exports = 1\n");
  const seal = await local(dir);

  const ok = await run(
    checkEvidence(seal, [
      "./src/math.ts:1",
      "node_modules/lib/index.js:1",
      "https://example.com/doc",
    ])
  );

  assert.deepEqual(ok, [
    "src/math.ts:1",
    "node_modules/lib/index.js:1",
    "https://example.com/doc",
  ]);

  const bad = [
    "src/math.ts:99",
    "nope.ts:1",
    "garbage",
    "../x:1",
    "src/math.ts:2-1",
  ];

  await assert.rejects(
    run(checkEvidence(seal, bad)),
    (e: Error) =>
      bad.every((ref) => e.message.includes(`${ref}:`)) &&
      /line outside file/u.test(e.message) &&
      /invalid line range/u.test(e.message)
  );
  // Agents add side markers and notes; the rejection says what to drop.
  await assert.rejects(
    run(checkEvidence(seal, ["src/math.ts:1 (old)"])),
    /no side marker such as \(old\).*notes such as "none: searched …" go in trigger, brief, or rationale/u
  );
  // math.ts shrank to one line; its removed lines are still evidence on the base side.
  assert.deepEqual(await run(checkEvidence(seal, ["src/math.ts:3"])), [
    "src/math.ts:3",
  ]);
  assert.deepEqual(
    [...depsOf(entry("F1", { evidence: ["./src/a.ts:5"] }))].toSorted(),
    ["src/a.ts", "src/math.ts"]
  );
});

test("listings: worktree seals list what was sealed; dependency directories list one level from disk with link targets", async () => {
  const dir = repo({
    ".gitignore": "node_modules/\n",
    "old.ts": "x\n",
    "src/math.ts": MATH,
  });

  write(dir, "src/new.ts", "export const n = 1\n");
  rmSync(join(dir, "old.ts"));
  const seal = await local(dir);
  // Edits after sealing are not what directorate_read reads, so they are not listed either.
  write(dir, "src/later.ts", "later\n");
  rmSync(join(dir, "src/new.ts"));
  assert.match(
    await run(listFiles(seal)),
    /^3 files at the seal\n\.gitignore\nsrc\/math\.ts\nsrc\/new\.ts$/u
  );
  assert.match(
    await run(listFiles(seal, "src")),
    /^2 files under src at the seal\nsrc\/math\.ts\nsrc\/new\.ts$/u
  );

  // Bun and pnpm link packages into a store whose names cannot be guessed; a listing shows where each link goes.
  write(
    dir,
    "node_modules/.bun/pkg@1.0.0+abc123/node_modules/pkg/index.js",
    "module.exports = 1\n"
  );
  write(
    dir,
    "node_modules/.bun/pkg@1.0.0+abc123/node_modules/pkg/.env",
    "KEY=1\n"
  );
  mkdirSync(join(dir, "app/node_modules"), { recursive: true });
  symlinkSync(
    "../../node_modules/.bun/pkg@1.0.0+abc123/node_modules/pkg",
    join(dir, "app/node_modules/pkg")
  );
  const links = await run(listFiles(seal, "app/node_modules"));
  assert.match(
    links,
    /^1 entries in app\/node_modules · installed dependency directory on disk, not part of the sealed change; one level\n/u
  );
  assert.match(
    links,
    /^pkg\/ -> node_modules\/\.bun\/pkg@1\.0\.0\+abc123\/node_modules\/pkg$/mu
  );
  const pkg = await run(listFiles(seal, "app/node_modules/pkg"));
  assert.match(
    pkg,
    /^2 entries in app\/node_modules\/pkg \(resolves to node_modules\/\.bun\/pkg@1\.0\.0\+abc123\/node_modules\/pkg\)/u
  );
  assert.match(pkg, /^\.env {2}\(withheld\)$/mu);
  assert.match(pkg, /^index\.js$/mu);
  symlinkSync(nodePath.dirname(dir), join(dir, "node_modules/up"));
  assert.match(
    await run(listFiles(seal, "node_modules")),
    /^up\/ -> \(outside the repository\)$/mu,
    "a link to the repository's parent is outside it"
  );

  const liveResult2 = await run(
    readable(seal, "app/node_modules/pkg/index.js")
  );

  assert.equal(liveResult2.live, true);
  await assert.rejects(
    run(listFiles(seal, "node_modules/missing")),
    /not found \(installed dependencies: directorate_ls lists a dependency directory\)/u
  );
  await assert.rejects(
    run(readable(seal, "app/node_modules/pkg/nope.js")),
    /directorate_ls lists a dependency directory/u
  );
});

// ---------- ledger rules ----------
test("verdict rules: lead decides only minor entries by others; refuter decides the rest; authors may withdraw", () => {
  const F1 = entry("F1");
  const F2 = entry("F2", { severity: "important" });
  const F3 = entry("F3", { raisedBy: lead });
  const F4 = entry("F4", { status: "refuted" });
  const ledger: Ledger = { entries: [F1, F2, F3, F4], notes: [] };

  const v = (
    e: Entry,
    by: Actor,
    verdict: Verdict["verdict"],
    extra: Partial<Verdict> = {}
  ) => verdictError(e, by, { evidence: ["a:1"], verdict, ...extra }, ledger);

  const lead2 = { agent: "directorate_liaison", session: "s-other" };
  assert.equal(v(F1, lead, "confirmed"), undefined);
  assert.match(
    v(F1, lead, "confirmed", { severity: "important" }) ?? "",
    /only as minor/u
  );
  assert.match(v(F2, lead, "confirmed") ?? "", /needs directorate_compliance/u);
  assert.match(
    v(F2, lead, "refuted") ?? "",
    /needs directorate_compliance/u,
    "lead cannot bury an important entry"
  );
  assert.match(
    v(F2, lead, "duplicate", { of: "F1" }) ?? "",
    /needs directorate_compliance/u
  );
  assert.equal(v(F2, refuter, "confirmed"), undefined);
  assert.match(
    v(F1, scout, "refuted") ?? "",
    /Only directorate_liaison or directorate_compliance/u
  );
  assert.match(v(F3, lead2, "confirmed") ?? "", /only directorate_compliance/u);
  assert.match(v(F3, lead, "confirmed") ?? "", /raised in this session/u);
  assert.equal(
    v(F3, lead, "refuted"),
    undefined,
    "authors may withdraw their own open entries"
  );
  assert.match(
    v(F4, lead, "confirmed") ?? "",
    /Only directorate_compliance may re-decide/u
  );
  assert.equal(v(F4, refuter, "confirmed"), undefined);
  assert.match(
    v(F1, lead, "duplicate", { of: "F4" }) ?? "",
    /only of open or confirmed/u
  );
  assert.match(
    verdictError(F1, lead, { evidence: [], verdict: "refuted" }, ledger) ?? "",
    /counterevidence/u
  );
});

test("severity follows the current generation: a reopened upgraded entry still needs the refuter", () => {
  const F1 = entry("F1", {
    status: "confirmed",
    verdicts: [
      {
        at: T0,
        by: refuter,
        evidence: ["a:1"],
        rationale: "",
        severity: "blocking",
        verdict: "confirmed",
      },
    ],
  });

  assert.equal(currentSeverity(F1), "blocking");
  const R1 = reopen(F1, "code changed");
  assert.deepEqual(
    [R1.status, R1.severity, R1.verdicts.length, present(R1.history).length],
    ["open", "blocking", 0, 1]
  );
  assert.equal(F1.status, "confirmed", "the earlier entry is unchanged");
  assert.match(
    verdictError(
      R1,
      lead,
      { evidence: ["a:1"], verdict: "confirmed" },
      { entries: [R1], notes: [] }
    ) ?? "",
    /needs directorate_compliance/u
  );
});

test("duplicates: merged claims never raise a verified severity; orphans stay unresolved", () => {
  const F1 = entry("F1", {
    status: "confirmed",
    verdicts: [
      {
        at: T0,
        by: refuter,
        evidence: ["a:1"],
        rationale: "",
        severity: "minor",
        verdict: "confirmed",
      },
    ],
  });

  const F2 = entry("F2", {
    severity: "blocking",
    status: "duplicate",
    verdicts: [
      {
        at: T0,
        by: refuter,
        evidence: ["a:1"],
        of: "F1",
        rationale: "",
        verdict: "duplicate",
      },
    ],
  });

  const F3 = entry("F3", { status: "refuted" });

  const F4 = entry("F4", {
    status: "duplicate",
    verdicts: [
      {
        at: T0,
        by: lead,
        evidence: ["a:1"],
        of: "F3",
        rationale: "",
        verdict: "duplicate",
      },
    ],
  });

  const ledger: Ledger = { entries: [F1, F2, F3, F4], notes: [] };
  assert.equal(currentSeverity(F1), "minor");
  assert.deepEqual(
    unresolved(ledger).map((e) => e.id),
    ["F4"]
  );

  const seal: Seal = {
    baseSha: "base",
    budgetMinutes: 10,
    children: [],
    createdAt: T0,
    deadline: T0,
    deleted: [],
    description: "d",
    files: [],
    fingerprint: "f",
    gates: {},
    gen: 0,
    headSha: "head",
    id: "x",
    mode: "default",
    owner: lead.agent,
    ownerSession: lead.session,
    postImage: "commit",
    refreshes: 0,
    regions: [],
    repo: "/test",
    target: { kind: "auto" },
  };

  const md = renderReport({ ledger, reasons: [], seal, status: "complete" });
  assert.match(
    md,
    /Directorate Directive: <Minor Revisions\/Tolerated with Notes>/u
  );
  assert.match(
    md,
    /merged claims of higher severity \(unverified\): F2 blocking/u
  );
});

// ---------- freshness and refresh ----------
test("freshness: committing the reviewed change is not drift; a real edit is; excluded files are ignored", async () => {
  const dir = repo();
  write(dir, "src/math.ts", `${MATH}export const z = 1\n`);
  const seal = await local(dir);
  g(dir, "add", "-A");
  const fingerprintResult5 = await run(currentFingerprint(seal));
  assert.equal(fingerprintResult5.fingerprint, seal.fingerprint, "staging");
  g(dir, "commit", "-qm", "wip");
  const fingerprintResult6 = await run(currentFingerprint(seal));
  assert.equal(fingerprintResult6.fingerprint, seal.fingerprint, "committing");
  write(dir, ".env", "X=1\n");
  const fingerprintResult7 = await run(currentFingerprint(seal));
  assert.equal(
    fingerprintResult7.fingerprint,
    seal.fingerprint,
    "secret files are not read, even for hashing"
  );
  write(dir, "package-lock.json", '{"v":3}\n');
  const fingerprintResult8 = await run(currentFingerprint(seal));
  assert.notEqual(
    fingerprintResult8.fingerprint,
    seal.fingerprint,
    "a lockfile bump after the seal is drift"
  );
  write(dir, "package-lock.json", "{}\n");
  write(dir, "src/math.ts", "changed\n");
  const fingerprintResult9 = await run(currentFingerprint(seal));
  assert.notEqual(fingerprintResult9.fingerprint, seal.fingerprint);
});

test("worktree refresh: new generation, @@-aligned regions, removed '--' lines intact, reopen on verifier evidence", async () => {
  const dir = repo({
    "q.sql": "select 1;\n-- keep me\n-- drop me\n",
    "src/gone.ts": "x\n",
    "src/guard.ts": "export const ok = true\n",
    "src/math.ts": MATH,
  });

  write(dir, "src/math.ts", `${MATH}export const z = 1\n`);
  write(dir, "q.sql", "select 2;\n-- keep me\n-- drop me\n");
  const seal = await local(dir);

  const ledger: Ledger = {
    entries: [
      entry("F1", {
        evidence: ["src/math.ts:4"],
        status: "confirmed",
        verdicts: [
          {
            at: T0,
            by: refuter,
            evidence: ["src/math.ts:2"],
            rationale: "",
            verdict: "confirmed",
          },
        ],
      }),
      entry("F2", {
        anchor: at("src/zzz.ts", 1),
        evidence: ["src/other.ts:1"],
        status: "confirmed",
        verdicts: [
          {
            at: T0,
            by: refuter,
            evidence: ["src/guard.ts:1"],
            rationale: "",
            verdict: "confirmed",
          },
        ],
      }),
    ],
    notes: [],
  };

  write(dir, "src/guard.ts", "export const ok = false\n");
  write(dir, "q.sql", "select 2;\n-- keep me\n");
  unlinkSync(join(dir, "src/gone.ts"));
  const r = await run(refreshSeal(seal, ledger));
  assert.deepEqual(r.files.toSorted(), [
    "q.sql",
    "src/gone.ts",
    "src/guard.ts",
  ]);
  assert.deepEqual(
    r.reopened,
    ["F2"],
    "verifier evidence in guard.ts reopens F2"
  );
  assert.equal(r.seal.gen, 1);
  assert.ok(r.seal.deleted.includes("src/gone.ts"));
  const text = readFileSync(await run(diffFile(r.seal)), "utf-8");
  assert.match(
    text,
    /^--- drop me$/mu,
    "a removed '-- ' line is not rewritten as a header"
  );
  const lines = text.split("\n");

  for (const reg of r.newRegions) {
    assert.match(
      lines[reg.patchStart - 1] ?? "",
      /^@@/u,
      `${reg.id} starts on its hunk header`
    );
  }

  assert.ok(
    fs.existsSync(await run(diffFile(seal))),
    "the previous generation is kept"
  );
  const refreshesResult = await run(loadSeal(seal.id));
  assert.equal(refreshesResult.refreshes, 1);
});

test("range: base moved to head is stale; refresh rebuilds the empty target diff and reopens findings outside it", async () => {
  const dir = repo();
  g(dir, "checkout", "-q", "-b", "feat");
  write(
    dir,
    "src/math.ts",
    "export function div(a: number, b: number) {\n  return Math.floor(a / b)\n}\n"
  );
  g(dir, "commit", "-qam", "floor");

  const seal = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { base: "main", head: "feat", kind: "range" },
    })
  );

  g(dir, "checkout", "-q", "main");
  g(dir, "merge", "-q", "--ff-only", "feat");
  g(dir, "checkout", "-q", "feat");

  const ledger: Ledger = {
    entries: [
      entry("F1", {
        quote: "  return Math.floor(a / b)",
        status: "confirmed",
        verdicts: [
          {
            at: T0,
            by: refuter,
            evidence: ["src/math.ts:2"],
            rationale: "",
            verdict: "confirmed",
          },
        ],
      }),
    ],
    notes: [],
  };

  const s0 = await run(loadSeal(seal.id));
  const { md } = await run(finalize(s0, ledger, {}));
  assert.match(md, /status: \*\*stale\*\*/u);
  const r = await run(refreshSeal(seal, ledger));
  assert.equal(r.seal.regions.length, 0);
  assert.deepEqual(r.reopened, ["F1"]);
  assert.match(
    present(r.ledger.entries[0]).staleReason ?? "",
    /no longer part of the change/u
  );
  assert.equal(
    present(ledger.entries[0]).status,
    "confirmed",
    "the ledger passed in is unchanged"
  );
});

test("a file renamed from a secret path stays withheld: no diff content, no snapshot", async () => {
  const dir = repo({ ".env": "TOKEN=renamed-secret\n", "src/math.ts": MATH });
  g(dir, "mv", ".env", "config.txt");
  const seal = await local(dir);
  const f = present(seal.files.find((x) => x.path === "config.txt"));
  assert.deepEqual(
    [f.oldPath, f.excluded],
    [".env", "[REDACTED] secret-like path: content withheld"]
  );
  assert.ok(
    !readFileSync(await run(diffFile(seal)), "utf-8").includes("renamed-secret")
  );
  assert.equal(await run(sealedFile(seal, "config.txt")), undefined);
  assert.ok(!fs.existsSync(join(state, seal.id, "snapshot", "config.txt")));
});

test("range refresh deltas withhold secrets", async () => {
  const dir = repo();
  g(dir, "checkout", "-q", "-b", "feat");
  write(dir, "src/math.ts", "x\n");
  g(dir, "commit", "-qam", "a");

  const s = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { base: "main", head: "feat", kind: "range" },
    })
  );

  write(dir, ".env", "API_KEY=leakme\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "b");
  const r = await run(refreshSeal(s, { entries: [], notes: [] }));
  assert.ok(r.files.includes(".env"));
  assert.ok(
    !readFileSync(await run(diffFile(r.seal)), "utf-8").includes("leakme")
  );
});

// ---------- budget, report ----------
test("budget: drain is at least 20% and up to 6 minutes; lock at deadline", () => {
  const cases = [
    [20, 13, "normal"],
    [20, 14.5, "drain"],
    [60, 49, "drain"],
    [20, 20.1, "locked"],
  ] as const;

  for (const [minutes, elapsed, phase] of cases) {
    const seal = { createdAt: T0, deadline: DateTime.add(T0, { minutes }) };
    const now = DateTime.toEpochMillis(T0) + elapsed * 60_000;
    assert.equal(budget(seal, now).phase, phase);
  }
});

test("assess and render: skips make it partial; orphan duplicates count; refuted important candidates are listed", async () => {
  const dir = repo();
  write(dir, "src/math.ts", `${MATH}// x\n`);
  const sealed = await local(dir);

  const skipped = regions(sealed, () => ({
    disposition: "skipped",
    note: "out of time",
  }));

  const empty = { entries: [], notes: [] };
  const a = assess(skipped, empty, {}, "normal");
  assert.equal(a.status, "partial");
  assert.match(
    renderReport({ ledger: empty, seal: skipped, ...a }),
    /<Provisional\/Incomplete> — No Confirmed Issues[\s\S]*skipped: out of time/u
  );
  const seal = regions(sealed, () => ({ ownerRead: true }));

  const ledger: Ledger = {
    entries: [
      entry("F1", {
        brief: "Check `source`.\n\n- Keep the original scope.",
        severity: "important",
        status: "confirmed",
        verdicts: [
          {
            at: T0,
            by: refuter,
            evidence: ["src/math.ts:2"],
            rationale: "r",
            severity: "blocking",
            verdict: "confirmed",
          },
        ],
      }),
      entry("F2"),
      entry("F3", {
        severity: "important",
        status: "refuted",
        verdicts: [
          {
            at: T0,
            by: refuter,
            evidence: ["src/math.ts:1"],
            rationale: "guarded by caller",
            verdict: "refuted",
          },
        ],
      }),
      entry("F4", {
        status: "duplicate",
        verdicts: [
          {
            at: T0,
            by: lead,
            evidence: ["src/math.ts:2"],
            of: "F3",
            rationale: "",
            verdict: "duplicate",
          },
        ],
      }),
      entry("F5", { severity: "important", status: "confirmed" }),
    ],
    notes: [
      {
        at: T0,
        by: lead,
        kind: "unanswered",
        text: "security auditor timed out",
      },
    ],
  };

  const b = assess(seal, ledger, {}, "normal");
  assert.match(b.reasons.join(","), /2 leads unverified/u);
  const md = renderReport({ ledger, seal, ...b });
  assert.match(
    md,
    /\*\*Directorate Directive: <Hold\/Blocking — Do Not Merge>\*\* · status: \*\*partial\*\*/u
  );
  assert.match(md, /### Unverified Leads[\s\S]*title F2[\s\S]*title F4/u);
  assert.ok(
    md.includes(
      "   - **Technical brief:**\n\n     Check `source`.\n\n     - Keep the original scope.\n\n2. **[Important] title F5**"
    )
  );
  assert.doesNotMatch(md, /<\/?(?:details|summary)>/u);
  assert.match(
    md,
    /### Refuted blocking\/important candidates \(cleared by Compliance\)[\s\S]*title F3[\s\S]*guarded by caller/u
  );
  assert.equal(assess(seal, empty, {}, "normal").status, "complete");
  assert.equal(
    assess(seal, empty, { unverified: "gh failed" }, "normal").status,
    "partial"
  );
  assert.equal(assess(seal, empty, { stale: ["a"] }, "normal").status, "stale");
});

// ---------- sealed search and history ----------
test("grepSealed: sealed head for commit targets, hides secrets, translates \\|", async () => {
  const dir = repo({
    ".env": "needle=secret\n",
    "src/a.ts": "const needle = 1\nconst pin = 2\n",
  });

  write(dir, "src/a.ts", "const other = 1\n");

  const seal = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { commit: "HEAD", kind: "commit" },
    })
  );

  const out = await run(grepSealed(seal, "needle\\|pin"));
  assert.match(out, /src\/a.ts:1:const needle = 1/u);
  assert.match(out, /src\/a.ts:2:const pin = 2/u);
  assert.match(out, /translated/u);
  assert.ok(!out.includes("secret"));
});

test("history: log, blame, show with fixed arguments; secrets and option injection refused", async () => {
  const dir = repo({ "config/master.key": "k\n", "src/a.ts": "a\n" });
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

  assert.match(
    await run(history(seal, { kind: "log", path: "src/a.ts" })),
    /second commit/u
  );
  assert.match(
    await run(history(seal, { kind: "blame", path: "src/a.ts" })),
    /\) b$/mu
  );
  assert.match(
    await run(history(seal, { kind: "show", rev: "HEAD" })),
    /second commit/u
  );
  await assert.rejects(
    run(
      history(seal, { kind: "show", path: "config/master.key", rev: "HEAD" })
    ),
    /withheld/u
  );
  await assert.rejects(
    run(history(seal, { kind: "show", rev: "--output=/tmp/x" })),
    /Invalid revision/u
  );
});

// ---------- round 3 regressions ----------
test("paths mode: unchanged committed files render, read, and anchor; '.' and no paths mean the whole repo", async () => {
  const dir = repo({
    "lib/b.ts": "export const b = 1\n",
    "src/keep.ts": "export const keep = 1\nexport const two = 2\n",
  });

  write(dir, "lib/b.ts", "export const b = 2\n");

  const checkPaths = async (paths?: string[]) => {
    const s = await run(
      createSeal({
        mode: "full",
        owner: lead,
        repo: dir,
        target: { kind: "paths", paths },
      })
    );

    const keep = present(s.regions.find((r) => r.file === "src/keep.ts"));
    const { text, shown } = await run(renderRegions(s, [keep]));
    assert.match(
      text,
      /1 export const keep = 1\n\s+2 export const two = 2/u,
      `rendered for paths=${JSON.stringify(paths)}`
    );
    assert.equal(shown[0]?.complete, true);
    assert.equal(
      present(s.files.find((f) => f.path === "src/keep.ts")).status,
      "unchanged"
    );
    assert.match(
      await run(readLines(s, "src/keep.ts", "new")),
      /export const two = 2/u
    );
    assert.ok(
      await run(checkQuote(s, at("src/keep.ts", 2), "export const two = 2"))
    );
    assert.match(
      (await run(sealedFile(s, "lib/b.ts"))) ?? "",
      /b = 2/u,
      "changed files come from the snapshot"
    );
  };

  await checkPaths();
  await checkPaths(["."]);
  await checkPaths(["src", "lib"]);
});

test("secret filter: data files withheld, source files reviewed; a changed secret file makes the review partial", async () => {
  for (const p of [
    "config/secrets.yaml",
    "secrets.json",
    ".envrc",
    "prod.tfvars",
    "terraform.tfstate",
    "credentials.json",
    "config/master.key",
    "app/.env.local",
  ]) {
    assert.ok(isSecret(p), p);
  }

  for (const p of [
    "src/secrets.ts",
    "app/models/secret.rb",
    "lib/client_secret.go",
    "src/auth/credentials.ts",
    "tests/secret.spec.ts",
    ".env.example",
  ]) {
    assert.ok(!isSecret(p), p);
  }

  const dir = repo({
    "config/secrets.yaml": "a: 1\n",
    "src/secrets.ts": "export const x = 1\n",
  });

  write(dir, "src/secrets.ts", 'export const x = "hard-coded"\n');
  write(dir, "config/secrets.yaml", "a: 2\n");
  const seal = regions(await local(dir), () => ({ ownerRead: true }));
  assert.ok(
    seal.regions.some((r) => r.file === "src/secrets.ts"),
    "source named 'secrets' is reviewed"
  );
  const a = assess(seal, { entries: [], notes: [] }, {}, "normal");
  assert.equal(a.status, "partial");
  assert.match(a.reasons.join(","), /secret-like file was withheld/u);
  // Withheld under the lockfile reason, yet its old name is a secret: counted by path, not by the reason's wording.
  const moved = repo({ "config/secrets.yaml": "token: abc123\n" });
  g(moved, "mv", "config/secrets.yaml", "yarn.lock");
  const m = await local(moved);
  assert.deepEqual(
    m.files.map((f) => [f.path, f.oldPath, f.excluded]),
    [
      [
        "yarn.lock",
        "config/secrets.yaml",
        "lockfile: review the manifest change instead",
      ],
    ]
  );
  assert.match(
    assess(m, { entries: [], notes: [] }, {}, "normal").reasons.join(","),
    /1 changed secret-like file was withheld/u
  );
});

test("history: directory paths and pathspec magic cannot reach withheld files", async () => {
  const dir = repo({
    "config/app.ts": "x\n",
    "config/secrets.yaml": "token: abc123\n",
  });

  write(dir, "config/secrets.yaml", "token: zzz999\n");
  write(dir, "config/app.ts", "y\n");
  g(dir, "commit", "-qam", "rotate");

  const seal = await run(
    createSeal({
      mode: "default",
      owner: lead,
      repo: dir,
      target: { commit: "HEAD", kind: "commit" },
    })
  );

  await assert.rejects(
    run(history(seal, { kind: "show", path: "config", rev: "HEAD" })),
    /not a file/u
  );
  await assert.rejects(
    run(history(seal, { kind: "show", path: "config/*", rev: "HEAD" })),
    /not a file/u
  );
  const stat = await run(history(seal, { kind: "show", rev: "HEAD" }));
  assert.ok(!stat.includes("zzz999") && !stat.includes("abc123"));
  assert.ok(
    !/secrets\.yaml/u.test(stat),
    "withheld names are dropped from the file list"
  );
  assert.match(
    await run(
      history(seal, { kind: "show", path: "config/app.ts", rev: "HEAD" })
    ),
    /\+y/u
  );
});

test("mode-only change after the seal: refresh captures it as a metadata region", async () => {
  const dir = repo({ "run.sh": "echo hi\n" });
  write(dir, "run.sh", "echo hello\n");
  const seal = regions(await local(dir), () => ({ ownerRead: true }));
  fs.chmodSync(join(dir, "run.sh"), 0o755);
  const r = await run(refreshSeal(seal, { entries: [], notes: [] }));
  assert.deepEqual(r.files, ["run.sh"]);
  assert.ok(r.newRegions.length >= 1, "the changed region is unread");
  assert.match(
    readFileSync(await run(diffFile(r.seal)), "utf-8"),
    /new mode 100755/u
  );
  const fingerprintResult10 = await run(currentFingerprint(r.seal));
  assert.equal(fingerprintResult10.fingerprint, r.seal.fingerprint);
});

test("typechange refresh: an exec-bit change unreads only the section whose header changed", async () => {
  const dir = repo({ "plain.ts": "p\n" });
  symlinkSync("plain.ts", join(dir, "link"));
  g(dir, "add", "link");
  g(dir, "commit", "-qm", "link");
  unlinkSync(join(dir, "link"));
  write(dir, "link", "echo hi\n");
  const seal = regions(await local(dir), () => ({ ownerRead: true }));
  assert.equal(seal.regions.filter((x) => x.file === "link").length, 2);
  fs.chmodSync(join(dir, "link"), 0o755);
  const r = await run(refreshSeal(seal, { entries: [], notes: [] }));
  assert.equal(
    r.newRegions.length,
    1,
    "the symlink deletion keeps its receipt"
  );
  const shown = await run(renderRegions(r.seal, r.newRegions));
  assert.match(shown.text, /new file mode 100755/u);
  assert.match(shown.text, /\+echo hi/u);
});

test("refresh uses the captured generation to reopen dependent findings", async () => {
  const dir = repo({
    "src/caller.ts": "export const call = () => div(1, 0)\n",
    "src/guard.ts": "export const checked = false\n",
    "src/math.ts": MATH,
  });

  write(dir, "src/math.ts", `${MATH}// first edit\n`);
  const seal = await local(dir);
  write(dir, "src/math.ts", `${MATH}// second edit\n`);

  const ledger = {
    entries: [
      entry("F1", {
        anchor: at("src/caller.ts", 1),
        evidence: ["src/guard.ts:1"],
        quote: "export const call = () => div(1, 0)",
        status: "confirmed",
      }),
    ],
    notes: [],
  };

  let attempt = 0;

  const result = await run(
    refreshSeal(seal, ledger, () =>
      Effect.sync(() => {
        attempt += 1;

        if (attempt === 1) {
          write(dir, "src/guard.ts", "export const checked = true\n");
        }
      })
    )
  );

  assert.equal(attempt, 2);
  assert.deepEqual(result.reopened, ["F1"]);
  assert.match(
    (await run(sealedFile(result.seal, "src/guard.ts"))) ?? "",
    /checked = true/u
  );
});

test("worktree refresh rebuilds the full diff: removed lines anchor on the base; unchanged regions keep receipts", async () => {
  const dir = repo({
    "a.ts": "const one = 1\nconst removed = 2\nconst three = 3\n",
    "b.ts": "bee\n",
  });

  write(
    dir,
    "a.ts",
    "const one = 1\nconst removed = 2\nconst three = 3\nconst four = 4\n"
  );
  write(dir, "b.ts", "bee2\n");
  const seal = regions(await local(dir), () => ({ ownerRead: true }));
  write(dir, "a.ts", "const one = 1\nconst three = 3\nconst four = 4\n");
  const r = await run(refreshSeal(seal, { entries: [], notes: [] }));
  assert.deepEqual(
    r.newRegions.map((x) => x.file),
    ["a.ts"],
    "b.ts kept its read receipt"
  );
  assert.ok(present(r.seal.regions.find((x) => x.file === "b.ts")).ownerRead);
  assert.ok(
    await run(checkQuote(r.seal, at("a.ts", 2, "old"), "const removed = 2")),
    "a line removed after the seal anchors on the base side"
  );
  await assert.rejects(
    run(checkQuote(r.seal, at("a.ts", 2), "const removed = 2")),
    /not found/u
  );
  assert.doesNotMatch(
    readFileSync(await run(diffFile(r.seal)), "utf-8"),
    /# directorate: refresh/u,
    "one coherent base→post-image diff"
  );
});

test("lead cannot launder severity through duplicates; refuting a target reopens its duplicates", () => {
  const F1 = entry("F1", {
    status: "confirmed",
    verdicts: [
      {
        at: T0,
        by: lead,
        evidence: ["a:1"],
        rationale: "",
        severity: "minor",
        verdict: "confirmed",
      },
    ],
  });

  const F2 = entry("F2", { raisedBy: lead, severity: "blocking" });
  const ledger: Ledger = { entries: [F1, F2], notes: [] };
  assert.match(
    verdictError(
      F2,
      lead,
      { evidence: ["a:1"], of: "F1", verdict: "duplicate" },
      ledger
    ) ?? "",
    /hide the higher claim/u
  );
  const F3 = entry("F3", { severity: "important" });

  const F4 = entry("F4", {
    status: "duplicate",
    verdicts: [
      {
        at: T0,
        by: refuter,
        evidence: ["a:1"],
        of: "F3",
        rationale: "",
        verdict: "duplicate",
      },
    ],
  });

  const r = decide(
    { entries: [F3, F4], notes: [] },
    { ...F3, status: "refuted" }
  );

  assert.deepEqual(r.reopened, ["F4"]);
  assert.deepEqual(
    r.ledger.entries.map((e) => e.status),
    ["refuted", "open"]
  );
  assert.deepEqual(
    decide({ entries: [F3, F4], notes: [] }, { ...F3, status: "confirmed" })
      .reopened,
    [],
    "only a refutation reopens them"
  );
});

test("quote snapping prefers the nearest match, not the first one above", async () => {
  const dir = repo();
  write(dir, "y.ts", "  return cached\nconst a = 1\n  return cached\n");
  const s2 = await local(dir);

  const lineResult2 = await run(
    checkQuote(s2, at("y.ts", 3), "  return cached")
  );

  assert.equal(lineResult2.line, 3);

  const lineResult3 = await run(
    checkQuote(s2, at("y.ts", 2), "  return cached")
  );

  assert.equal(
    lineResult3.line,
    3,
    "ties go to the line below (distance order 0, +1, -1)"
  );
});

test("interrupting a mutation releases its lock", async () => {
  const seal = await local(repo());
  await run(
    Effect.gen(function* interruptLock() {
      const locked = yield* Deferred.make<boolean>();
      const st = yield* Store;

      const first = yield* st
        .withLock(
          seal.id,
          Deferred.succeed(locked, true).pipe(Effect.andThen(Effect.never))
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(locked);
      yield* Fiber.interrupt(first);
      yield* st.withLock(seal.id, Effect.void).pipe(Effect.timeout("1 second"));
    })
  );
});

test("mutation lock excludes a separate process", async () => {
  const seal = await local(repo());
  const exec = promisify(execFile);

  const probe = (ms: number) =>
    exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { Effect } from "effect"
    import { platformLayer } from "./src/platform.ts"
    import { Store } from "./src/store.ts"
    console.log(await Effect.runPromise(Effect.flatMap(Effect.service(Store), (store) => store.withLock(process.argv[1], Effect.succeed("acquired"))).pipe(
      Effect.timeoutOrElse({ duration: ${ms}, orElse: () => Effect.succeed("waiting") }),
      Effect.provide(platformLayer),
    )))
  `,
        seal.id,
      ],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, DIRECTORATE_STATE_DIR: state },
        timeout: 5000,
      }
    );

  const result = await run(
    store.pipe(
      Effect.flatMap((st) =>
        st.withLock(
          seal.id,
          Effect.tryPromise(() => probe(150))
        )
      )
    )
  );

  assert.equal(result.stdout.trim(), "waiting");
  const stdoutResult = await probe(2000);
  assert.equal(stdoutResult.stdout.trim(), "acquired");
});

test("PR freshness with a fake gh: unfetched base move is unverified; unfetched head move is stale", async () => {
  const dir = repo();
  g(dir, "checkout", "-q", "-b", "feat");
  write(dir, "src/math.ts", `${MATH}// pr\n`);
  g(dir, "commit", "-qam", "pr");
  const head = g(dir, "rev-parse", "HEAD").trim();
  const base = g(dir, "rev-parse", "main").trim();
  const bin = mkdtempSync(join(tmpdir(), "directorate-bin-"));
  dirs.push(bin);
  const json = join(bin, "pr.json");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat "${json}"\n`, { mode: 0o755 });

  const meta = (h: string, b: string) =>
    writeFileSync(
      json,
      JSON.stringify({
        baseRefName: "main",
        baseRefOid: b,
        headRefName: "feat",
        headRefOid: h,
        number: 7,
        title: "t",
        url: "u",
      })
    );

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;

  try {
    writeFileSync(json, "{}");
    await assert.rejects(
      run(
        createSeal({
          mode: "default",
          owner: lead,
          repo: dir,
          target: { kind: "pr", pr: "7" },
        })
      ),
      /Invalid GitHub CLI response/u
    );
    meta(head, base);

    const seal = await run(
      createSeal({
        mode: "default",
        owner: lead,
        repo: dir,
        target: { kind: "pr", pr: "7" },
      })
    );

    const fingerprintResult11 = await run(currentFingerprint(seal));
    assert.equal(fingerprintResult11.fingerprint, seal.fingerprint);
    meta(head, "1".repeat(40));
    await assert.rejects(
      run(currentFingerprint(seal)),
      /base moved .* not fetched/u
    );
    meta("2".repeat(40), base);
    const cur = await run(currentFingerprint(seal));
    assert.match(cur.unfetched ?? "", /PR head moved/u);

    const { md } = await run(
      finalize(
        await run(loadSeal(seal.id)),
        { entries: [], notes: [] },
        { cur: Result.succeed(cur) }
      )
    );

    assert.match(md, /status: \*\*stale\*\*/u);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("budget lines are written for each role", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  const s = {
    budgetMinutes: 10,
    createdAt: DateTime.makeUnsafe(now - 9 * 60_000),
    deadline: DateTime.makeUnsafe(now + 60_000),
  };

  assert.match(
    budgetLine(s, now, "directorate_auditor"),
    /file surviving candidates now and hand off/u
  );
  assert.match(
    budgetLine(s, now, "directorate_compliance"),
    /finish the entry in hand/u
  );
  assert.match(
    budgetLine(s, now, "directorate_liaison"),
    /call directorate_report/u
  );
  assert.doesNotMatch(
    budgetLine(s, now, "directorate_auditor"),
    /directorate_report/u
  );
});

// ---------- re-checks ----------
const confirmedBy = (by: Actor, evidence: string[]): Verdict => ({
  at: T0,
  by,
  evidence,
  rationale: "",
  severity: "important",
  verdict: "confirmed",
});

test("re-check: identical chunks carry only their own read receipts", async () => {
  const dir = repo();
  write(dir, "repeated.txt", "repeat\n".repeat(1199));
  const sealed = await local(dir);
  assert.equal(sealed.regions.length, 3);

  const prior = {
    ...regions(sealed, (_, i) =>
      i < 2 ? { ownerRead: true, readBy: ["owner"] } : {}
    ),
    reportedAt: T0,
  };

  const next = await run(
    recheckSeal({ ledger: { entries: [], notes: [] }, owner: lead, prior })
  );

  assert.deepEqual(
    coverageSummary(next.seal).unread.map((r) => r.id),
    ["R3"]
  );
});

test("re-check: keeps the base and unchanged reads, carries verified findings and leads, reopens what the fixes touched", async () => {
  const dir = repo({
    "src/math.ts": MATH,
    "src/other.ts": "export const other = 1\n",
  });

  write(dir, "src/math.ts", `${MATH}export const z = 1\n`);
  write(dir, "src/other.ts", "export const other = 2\n");
  const sealed = await local(dir);

  const ledger: Ledger = {
    entries: [
      entry("F1", {
        severity: "important",
        status: "confirmed",
        verdicts: [confirmedBy(refuter, ["src/math.ts:2"])],
      }),
      entry("F2", {
        anchor: at("src/other.ts", 1),
        evidence: ["src/other.ts:1"],
        quote: "export const other = 2",
        severity: "important",
        status: "confirmed",
        verdicts: [confirmedBy(refuter, ["src/other.ts:1"])],
      }),
      entry("F3", { status: "refuted" }),
      entry("F4"),
      entry("F5", {
        status: "duplicate",
        verdicts: [
          {
            at: T0,
            by: refuter,
            evidence: ["src/math.ts:2"],
            of: "F1",
            rationale: "",
            verdict: "duplicate",
          },
        ],
      }),
    ],
    notes: [
      {
        at: T0,
        by: lead,
        kind: "unanswered",
        text: "is div ever called with 0?",
      },
    ],
  };

  const prior = {
    ...regions(sealed, () => ({ ownerRead: true, readBy: ["owner"] })),
    reportedAt: T0,
  };

  await run(store.pipe(Effect.flatMap((st) => st.saveBoth(prior, ledger))));

  await assert.rejects(
    run(recheckSeal({ ledger, owner: lead, prior: sealed })),
    /has not been reported/u
  );

  // The fix touches math.ts only, and everything is committed: the base stays where the earlier review had it.
  write(dir, "src/math.ts", `${MATH}export const z = 2\n`);
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "fix");
  const r = await run(recheckSeal({ ledger, owner: lead, prior }));

  assert.equal(r.seal.recheckOf, sealed.id);
  assert.notEqual(r.seal.id, sealed.id);
  assert.equal(
    r.seal.baseSha,
    sealed.baseSha,
    "committing the fixes is not a new change"
  );
  assert.equal(r.seal.panel, undefined);
  assert.deepEqual(r.files, ["src/math.ts"]);
  const byFile = (f: string) => r.seal.regions.filter((x) => x.file === f);
  assert.ok(
    byFile("src/other.ts").every((x) => x.ownerRead),
    "unchanged regions keep their reads"
  );
  assert.ok(
    byFile("src/math.ts").every((x) => !x.ownerRead),
    "changed regions are read again"
  );

  // F3 (refuted) and F5 (a duplicate of a confirmed finding) do not carry; the rest are renumbered.
  assert.deepEqual(
    r.ledger.entries.map((e) => [
      e.id,
      e.carried?.id,
      e.carried?.status,
      e.status,
    ]),
    [
      ["F1", "F1", "confirmed", "open"],
      ["F2", "F2", "confirmed", "confirmed"],
      ["F3", "F4", "unverified", "open"],
    ]
  );
  assert.deepEqual(r.reopened, ["F1", "F3"]);
  assert.deepEqual(r.kept, ["F2"]);
  assert.match(
    r.ledger.entries[0]?.staleReason ?? "",
    /changed since .*src\/math\.ts/u
  );
  assert.equal(
    present(r.ledger.entries[0]).verdicts.length,
    0,
    "a reopened finding's verdicts move to its history"
  );
  assert.deepEqual(r.unanswered, ["is div ever called with 0?"]);
  assert.deepEqual(r.ledger.notes, []);

  const recheckOfResult = await run(loadSeal(r.seal.id));
  assert.equal(recheckOfResult.recheckOf, sealed.id);
  const entriesResult = await run(loadLedger(r.seal.id));
  assert.equal(entriesResult.entries.length, 3);
  const reportedAtResult = await run(loadSeal(sealed.id));
  assert.ok(reportedAtResult.reportedAt, "the earlier seal stays reported");
});

test("re-check verdicts: only carried entries resolve, only Compliance decides carried verified findings, nobody resolves their own", () => {
  const verified = entry("F1", {
    carried: { id: "F7", status: "confirmed" },
  });

  const unverified = entry("F2", {
    carried: { id: "F8", status: "unverified" },
  });

  const own = entry("F3", {
    carried: { id: "F9", status: "unverified" },
    raisedBy: lead,
  });

  const fresh = entry("F4");

  const ledger: Ledger = {
    entries: [verified, unverified, own, fresh],
    notes: [],
  };

  const v = (
    e: Entry,
    by: Actor,
    verdict: Verdict["verdict"],
    evidence = ["a:1"]
  ) => verdictError(e, by, { evidence, verdict }, ledger);

  assert.match(v(fresh, refuter, "resolved") ?? "", /new in this review/u);
  assert.match(
    v(verified, lead, "resolved") ?? "",
    /route it to directorate_compliance/u
  );
  assert.match(
    v(verified, lead, "refuted") ?? "",
    /route it to directorate_compliance/u,
    "the lead cannot drop a verified finding"
  );
  assert.equal(v(verified, refuter, "resolved"), undefined);
  assert.equal(v(verified, refuter, "confirmed"), undefined);
  assert.match(
    v(verified, refuter, "resolved", []) ?? "",
    /lines that fix it/u
  );
  assert.equal(
    v(unverified, lead, "resolved"),
    undefined,
    "minor unverified leads by others follow the usual rules"
  );
  assert.match(
    v(own, lead, "resolved") ?? "",
    /different session must resolve/u
  );
  assert.equal(
    v(own, lead, "refuted"),
    undefined,
    "an unverified lead of one's own may still be withdrawn"
  );
});

test("resolving an entry reopens its duplicates", () => {
  const F1 = entry("F1", { carried: { id: "F1", status: "confirmed" } });

  const F2 = entry("F2", {
    status: "duplicate",
    verdicts: [
      {
        at: T0,
        by: refuter,
        evidence: ["a:1"],
        of: "F1",
        rationale: "",
        verdict: "duplicate",
      },
    ],
  });

  const { ledger, reopened } = decide(
    { entries: [F1, F2], notes: [] },
    { ...F1, status: "resolved" }
  );

  assert.deepEqual(reopened, ["F2"]);
  assert.match(present(ledger.entries[1]).staleReason ?? "", /was resolved/u);
});

test("re-check Directive: names the earlier seal, marks findings still present or new, and lists what was resolved", () => {
  const earlier = "directorate-20260101000000-aaaaaa";

  const seal: Seal = {
    baseSha: "base",
    budgetMinutes: 10,
    children: [],
    createdAt: T0,
    deadline: T0,
    deleted: [],
    description: "d",
    files: [],
    fingerprint: "f",
    gates: {},
    gen: 0,
    headSha: "head",
    id: "directorate-20260101000000-bbbbbb",
    mode: "default",
    owner: lead.agent,
    ownerSession: lead.session,
    postImage: "commit",
    recheckOf: earlier,
    refreshes: 0,
    regions: [],
    repo: "/test",
    target: { kind: "auto" },
  };

  const still = entry("F1", {
    carried: { id: "F3", status: "confirmed" },
    severity: "important",
    status: "confirmed",
    title: "still broken",
    verdicts: [confirmedBy(refuter, ["src/math.ts:2"])],
  });

  const fresh = entry("F2", {
    status: "confirmed",
    title: "introduced by the fix",
    verdicts: [
      { ...confirmedBy(refuter, ["src/math.ts:2"]), severity: "minor" },
    ],
  });

  const fixed = entry("F3", {
    carried: { id: "F5", status: "confirmed" },
    status: "resolved",
    title: "was broken",
    verdicts: [
      {
        at: T0,
        by: refuter,
        evidence: ["src/math.ts:1"],
        rationale: "guarded now",
        verdict: "resolved",
      },
    ],
  });

  const render = (
    entries: Entry[],
    status: Parameters<typeof renderReport>[0]["status"] = "complete"
  ) =>
    renderReport({ ledger: { entries, notes: [] }, reasons: [], seal, status });

  const md = render([still, fresh, fixed]);
  assert.match(md, new RegExp(`re-check of \`${earlier}\``, "u"));
  assert.match(md, /2 verified, 1 resolved, 0 refuted/u);
  assert.match(
    md,
    new RegExp(
      `still broken\\*\\* .* · still present \\(F3 in \`${earlier}\`\\)`,
      "u"
    )
  );
  assert.match(md, /introduced by the fix\*\* .* · new$/mu);
  assert.match(
    md,
    new RegExp(
      `### Resolved Since \`${earlier}\`\\n- was broken — was \`src/math\\.ts:2\` \\(minor, F5\\); resolved by directorate_compliance: guarded now \`src/math\\.ts:1\``,
      "u"
    )
  );
  assert.match(
    render([fixed]),
    /<Approved\/Tolerated> — Prior Findings Resolved/u
  );
  assert.match(
    render([{ ...still, status: "open", verdicts: [] }], "partial"),
    new RegExp(`verified as F3 in \`${earlier}\`, not re-checked`, "u")
  );
});
