import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import {
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
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
import { type Ledger, RepoPath, RepoScope, type Seal } from "../src/model.ts";
import { platformLayer, type Platform } from "../src/platform.ts";
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

const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = fs;
const state = mkdtempSync(join(tmpdir(), "directorate-state-"));
/** The platform, with seals stored under this suite's temporary state directory. */
const testPlatform = platformLayer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({ DIRECTORATE_STATE_DIR: state })
    )
  )
);
const run = <A, E>(effect: Effect.Effect<A, E, Platform>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testPlatform)));
// The seal store, as the tests reach it.
const store = Effect.service(Store);
const diffFile = (s: Seal) => Effect.map(store, (st) => st.diffFile(s));
const loadSeal = (id: string) => Effect.flatMap(store, (st) => st.load(id));
const loadLedger = (id: string) =>
  Effect.flatMap(store, (st) => st.loadLedger(id));
/** The seal with each region changed by `f`. */
const regions = (
  s: Seal,
  f: (r: Seal["regions"][number], i: number) => Partial<Seal["regions"][number]>
): Seal => ({ ...s, regions: s.regions.map((r, i) => ({ ...r, ...f(r, i) })) });

test("the global settings file follows OpenCode's config directory: DIRECTORATE_SETTINGS, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, HOME", async () => {
  const file = (env: Record<string, string>) =>
    Effect.runPromise(
      SettingsStore.use((s) => s.file("global", "/x/repo")).pipe(
        Effect.provide(
          platformLayer.pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))
            )
          )
        )
      )
    );
  const all = {
    DIRECTORATE_SETTINGS: "/x/directorate.json",
    OPENCODE_CONFIG_DIR: "/x/oc",
    XDG_CONFIG_HOME: "/x/xdg",
    HOME: "/x/home",
  };
  assert.equal(await file(all), "/x/directorate.json");
  assert.equal(
    await file({ ...all, DIRECTORATE_SETTINGS: "" }),
    "/x/oc/directorate.json"
  );
  assert.equal(
    await file({ XDG_CONFIG_HOME: "/x/xdg", HOME: "/x/home" }),
    "/x/xdg/opencode/directorate.json"
  );
  assert.equal(
    await file({ HOME: "/x/home" }),
    "/x/home/.config/opencode/directorate.json"
  );
});

test("the state root comes from Effect Config: DIRECTORATE_STATE_DIR, then XDG_STATE_HOME, then HOME", async () => {
  const root = (env: Record<string, string>) =>
    Effect.runPromise(
      Effect.service(StateRoot).pipe(
        Effect.provide(
          platformLayer.pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))
            )
          )
        )
      )
    );
  assert.equal(
    await root({
      DIRECTORATE_STATE_DIR: "/x/directorate",
      XDG_STATE_HOME: "/x/xdg",
      HOME: "/x/home",
    }),
    "/x/directorate"
  );
  assert.equal(
    await root({ XDG_STATE_HOME: "/x/xdg", HOME: "/x/home" }),
    "/x/xdg/opencode-directorate"
  );
  assert.equal(
    await root({ HOME: "/x/home" }),
    "/x/home/.local/state/opencode-directorate"
  );
});

test("the command adapter keeps argv and binary output intact, and caps each output stream", async () => {
  const argv = "a b; literal";
  const options = { timeout: 5000, maxOutputBytes: 32 };
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
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(
      run(
        command(
          process.execPath,
          ["-e", `process.${stream}.write(Buffer.alloc(33))`],
          options
        )
      ),
      new RegExp(`${stream} exceeded 32 bytes`)
    );
  }
});

test(
  "interrupting the command waits for the spawned process to exit",
  { timeout: 5000 },
  async () => {
    await run(
      Effect.gen(function* () {
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
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const g = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString();
const MATH = "export function div(a: number, b: number) {\n  return a / b\n}\n";
function repo(
  files: Record<string, string | Buffer> = {
    "src/math.ts": MATH,
    "package-lock.json": "{}\n",
  }
): string {
  const dir = mkdtempSync(join(tmpdir(), "directorate-repo-"));
  dirs.push(dir);
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@e.com");
  g(dir, "config", "user.name", "t");
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  g(dir, "add", ".");
  g(dir, "commit", "-qm", "init");
  return dir;
}
function write(dir: string, p: string, c: string | Buffer) {
  mkdirSync(join(dir, p, ".."), { recursive: true });
  writeFileSync(join(dir, p), c);
}
const scout = { agent: "directorate_auditor", session: "s-scout" };
const lead = { agent: "directorate_liaison", session: "s-lead" };
const refuter = { agent: "directorate_compliance", session: "s-ref" };
const local = async (dir: string, mode: any = "default") =>
  await run(
    createSeal({ repo: dir, mode, target: { kind: "local" }, owner: lead })
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
      repo: dir,
      mode: "default",
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
  assert.equal(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint
  );
  write(dir, "[route]/tracked.ts", "changed inside\n");
  assert.notEqual(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint
  );
  const diff = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "local", paths: ["[route]"] },
    })
  );
  assert.deepEqual(diff.files.map((f) => f.path).sort(), [
    "[route]/new.ts",
    "[route]/tracked.ts",
  ]);
  const matches = await run(
    grepSealed(diff, "changed", { paths: ["[route]"] })
  );
  assert.match(matches, /^\[route\]\/tracked.ts:/m);
  assert.doesNotMatch(matches, /^r\//m);
  const outside = await run(readLines(diff, "r/tracked.ts", "new"));
  assert.match(
    outside,
    /base .*outside the sealed scope; working tree not captured/
  );
  assert.doesNotMatch(outside, /changed outside/);
});

test("unsupported targets reject path restrictions rather than widen the review", async () => {
  const dir = repo({ "a/file.ts": "a\n", "b/file.ts": "b\n" });
  for (const kind of ["commit", "auto", "range", "pr"] as const) {
    await assert.rejects(
      run(
        createSeal({
          repo: dir,
          mode: "default",
          target: { kind, paths: ["a"] },
        })
      ),
      /does not support paths/
    );
  }
});

test("paths seal does not expose a base blob as the post-image of an absent sparse file", async () => {
  const dir = repo({
    "visible/file.ts": "visible\n",
    "hidden/file.ts": "not checked out\n",
  });
  g(dir, "sparse-checkout", "set", "--cone", "visible");
  const seal = await run(
    createSeal({ repo: dir, mode: "default", target: { kind: "paths" } })
  );
  assert.equal(
    seal.files.find((f) => f.path === "hidden/file.ts")?.status,
    "deleted"
  );
  assert.ok(seal.regions.every((r) => r.file !== "hidden/file.ts"));
  assert.doesNotMatch(await run(listFiles(seal)), /hidden\/file.ts/);
  await assert.rejects(
    run(readLines(seal, "hidden/file.ts", "new")),
    /does not exist/
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
  const patch = readFileSync(await run(diffFile(seal)), "utf8");
  assert.match(patch, /^-original$/m);
  assert.match(patch, /^\+replacement$/m);
  assert.match(patch, /^ context$/m);
  assert.doesNotMatch(patch, /src\/same.ts/);
  assert.ok(seal.regions.every((r) => r.file !== "src/same.ts"));
  assert.deepEqual(
    seal.files.map(({ path, status }) => [path, status]),
    [["src/a.ts", "modified"]]
  );
  assert.match(await run(listFiles(seal, "src")), /^src\/a\.ts$/m);
  assert.deepEqual(await run(readable(seal, "src/a.ts")), {
    content: "context\nreplacement\n",
    live: false,
  });
});

test("history clips long patch lines even when all clipped lines fit on one page", async () => {
  const dir = repo({ "long.ts": `${"x".repeat(60_000)}\n` });
  const seal = await local(dir);
  const result = await run(
    history(seal, { kind: "show", rev: "HEAD", path: "long.ts" })
  );
  assert.ok(Buffer.byteLength(result) <= OUTPUT_MAX_BYTES);
  assert.match(result, /^\+x+ …$/m);
});

/** Fixture timestamp. */
const T0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

test("only a subsequent successful retry clears a failed question", async () => {
  const seal = await local(repo());
  const first = {
    call: "first",
    agent: scout.agent,
    prompt: "question: same",
    status: "completed",
    startedAt: T0,
  } as const;
  const failed = {
    ...first,
    call: "failed",
    prompt: "question: same\ncheck the guard",
    status: "failed",
  } as const;
  const reviewed = { ...seal, regions: [], children: [first, failed] };
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
  path,
  line,
  endLine: line,
  side,
});
const entry = (id: string, o: any = {}) => ({
  id,
  raisedBy: scout,
  lens: "c",
  title: `title ${id}`,
  severity: "minor",
  kind: "defect",
  anchor: at("src/math.ts", 2),
  quote: "  return a / b",
  trigger: "b=0",
  consequence: "Infinity",
  evidence: ["src/math.ts:2"],
  status: "open",
  verdicts: [],
  createdAt: T0,
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
  const regions = await run(buildRegions(files, text));
  assert.deepEqual(
    regions.map((r) => [r.id, r.file, r.newStart, r.newEnd]),
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
    /git listed 2 patch sections but wrote 1/,
    "records without their sections"
  );
});

test("names git quotes in patch headers (quotes, tabs, non-ASCII) seal exactly; a quoted secret stays withheld", async () => {
  const dir = repo({
    "has space.ts": "a\n",
    "café.ts": "b\n",
    "plain.ts": "p\n",
    "t.ts": "t\n",
    'my"dir/.env': "TOKEN=one\n",
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
  assert.deepEqual([...byPath.keys()].sort(), [
    "café.ts",
    "has space.ts",
    'my"dir/.env',
    'ren"amed.ts',
    "t.ts",
    "tab\there.ts",
  ]);
  assert.deepEqual(
    [byPath.get('ren"amed.ts')!.status, byPath.get('ren"amed.ts')!.oldPath],
    ["renamed", "plain.ts"]
  );
  assert.equal(
    byPath.get("t.ts")!.status,
    "modified",
    "a typechange is one file with both of git's sections"
  );
  assert.match(byPath.get('my"dir/.env')!.excluded!, /secret/);
  assert.ok(
    !readFileSync(await run(diffFile(seal)), "utf8").includes("supersecret")
  );
  assert.ok(await run(checkQuote(seal, at("has space.ts", 2), "const x = 1")));
  assert.ok(await run(checkQuote(seal, at("café.ts", 2), "const y = 2")));
  assert.ok(
    await run(checkQuote(seal, at("tab\there.ts", 1), "const tab = 1"))
  );
  const tc = seal.regions.filter((r) => r.file === "t.ts");
  assert.ok(tc.length >= 2, "both sections of the typechange are regions");
  const shown = await run(renderRegions(seal, tc));
  assert.match(shown.text, /-t$/m);
  assert.match(shown.text, /\+symlink -> plain\.ts|\+plain\.ts/m);
});

test("tool paths decode to the repository's form: contained, normalized, the root only as a scope", () => {
  const path = (v: string) => Schema.decodeOption(RepoPath)(v);
  const scope = (v: string) => Schema.decodeOption(RepoScope)(v);
  for (const bad of ["../etc/passwd", "/etc/passwd", "", ".", "a/.."])
    assert.equal(path(bad)._tag, "None", bad);
  assert.deepEqual(
    [
      path(" ./a//./b c.ts ").pipe((o) => o._tag === "Some" && o.value),
      path("a/../b").pipe((o) => o._tag === "Some" && o.value),
    ],
    ["a/b c.ts", "b"]
  );
  assert.deepEqual(
    [".", "", "./src/"].map((v) =>
      scope(v).pipe((o) => o._tag === "Some" && o.value)
    ),
    ["", "", "src"]
  );
  assert.equal(scope("../x")._tag, "None");
});

// ---------- sealing ----------
test("local seal: staged+unstaged+untracked, secrets withheld, symlinks as link text, snapshot survives later edits", async () => {
  const dir = repo();
  write(
    dir,
    "src/math.ts",
    MATH + "export const half = (n: number) => div(n, 2)\n"
  );
  write(dir, "src/new.ts", "export const x = 1\n");
  write(dir, ".env", "TOKEN=supersecret\n");
  symlinkSync("/etc/hosts", join(dir, "src/link.ts"));
  const seal = await local(dir);
  assert.deepEqual(seal.files.map((f) => f.path).sort(), [
    ".env",
    "src/link.ts",
    "src/math.ts",
    "src/new.ts",
  ]);
  const diff = readFileSync(await run(diffFile(seal)), "utf8");
  assert.ok(!diff.includes("supersecret"));
  assert.match(diff, /symlink -> \/etc\/hosts/);
  assert.ok(!diff.includes("localhost"));
  write(dir, "src/math.ts", "changed\n");
  assert.match((await run(sealedFile(seal, "src/math.ts")))!, /half/);
  await assert.rejects(run(readLines(seal, ".env", "new")), /withheld/);
});

test("seal race: an edit during capture forces a retry, so the diff and snapshot agree", async () => {
  const dir = repo();
  write(dir, "src/math.ts", MATH + "// edit one\n");
  let edits = 0;
  const seal = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "local" },
      owner: lead,
      beforeCapture: () =>
        Effect.sync(
          () =>
            void (
              edits++ === 0 && write(dir, "src/math.ts", MATH + "// edit two\n")
            )
        ),
    })
  );
  assert.match(
    readFileSync(await run(diffFile(seal)), "utf8"),
    /\+\/\/ edit two/
  );
  assert.match((await run(sealedFile(seal, "src/math.ts")))!, /edit two/);
  await assert.rejects(
    run(
      createSeal({
        repo: dir,
        mode: "default",
        target: { kind: "local" },
        owner: lead,
        beforeCapture: () =>
          Effect.sync(() =>
            write(dir, "src/math.ts", `${MATH}// ${++edits}\n`)
          ),
      })
    ),
    /kept changing/
  );
});

test("auto target: local changes if any, else the branch against the default branch", async () => {
  const dir = repo();
  g(dir, "checkout", "-q", "-b", "feat");
  write(dir, "src/math.ts", MATH + "// feat\n");
  g(dir, "commit", "-qam", "feat");
  const s1 = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "auto" },
      owner: lead,
    })
  );
  assert.match(s1.description, /^branch 1 commit ahead of main \(/);
  assert.match(readFileSync(await run(diffFile(s1)), "utf8"), /\+\/\/ feat/);
  write(dir, "src/new.ts", "export const n = 1\n");
  const s2 = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "auto" },
      owner: lead,
    })
  );
  assert.match(
    s2.description,
    /^branch 1 commit ahead of main plus local changes/
  );
  const d2 = readFileSync(await run(diffFile(s2)), "utf8");
  assert.ok(
    d2.includes("+// feat") && d2.includes("+export const n = 1"),
    "branch commits and local edits are both reviewed"
  );
  const dir2 = repo();
  write(dir2, "src/math.ts", "x\n");
  assert.match(
    (
      await run(
        createSeal({
          repo: dir2,
          mode: "default",
          target: { kind: "auto" },
          owner: lead,
        })
      )
    ).description,
    /^local changes/
  );
  const s3 = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "range", base: "@default" },
      owner: lead,
    })
  );
  assert.match(s3.description, /^main\.\.\.HEAD/);
});

// ---------- path policy ----------
test("deleted and renamed-away paths have no new side; paths mode records deletions", async () => {
  const dir = repo({
    "src/math.ts": MATH,
    "src/old.ts": "export const o = 1\n",
    "src/keep.ts": "k\n",
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
    /does not exist/
  );
  assert.ok(
    await run(checkQuote(seal, at("src/math.ts", 2, "old"), "return a / b"))
  );
  const p = await run(
    createSeal({
      repo: dir,
      mode: "full",
      target: { kind: "paths", paths: ["src"] },
      owner: lead,
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
    "lib/a.ts": "inside\n",
    ".gitignore": "notes/\nnode_modules/\n",
    "src/x.ts": "x\n",
  });
  rmSync(join(dir, "lib"), { recursive: true });
  symlinkSync(outside, join(dir, "lib"));
  const seal = await local(dir);
  const blob =
    readFileSync(await run(diffFile(seal)), "utf8") +
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
      repo: dir2,
      mode: "default",
      target: { kind: "commit", commit: "HEAD" },
      owner: lead,
    })
  );
  await assert.rejects(
    run(readable(c, "notes/x.txt")),
    /not found at the seal/,
    "ignored non-dependency files are not readable"
  );
  mkdirSync(join(dir2, "node_modules/evil"), { recursive: true });
  symlinkSync("../../.env", join(dir2, "node_modules/evil/x.js"));
  await assert.rejects(
    run(readable(c, "node_modules/evil/x.js")),
    /withheld/,
    "a dependency symlink to a secret is withheld"
  );
  await assert.rejects(run(readable(c, ".git/config")), /withheld/);
  await assert.rejects(run(readable(c, "wip.ts")), /not found at the seal/);
  assert.equal(
    (await run(readable(c, "node_modules/lib/index.js"))).live,
    true
  );
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
    /not found/
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
      repo: dir,
      mode: "default",
      target: { kind: "commit", commit: "HEAD" },
      owner: lead,
    })
  );
  assert.deepEqual(
    root.files.map((f) => [f.path, f.status]),
    [["a.ts", "added"]]
  );
  assert.match((await run(sealedFile(root, "a.ts")))!, /export const a = 1/);
});

test("reading a sealed blob fails when git fails, instead of reading as a missing file", async () => {
  const dir = repo();
  const seal = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "commit", commit: "HEAD" },
      owner: lead,
    })
  );
  // git exits 1 for cat-file here, which is not git's "no such path" (128). Fresh: the suite's Git is already built.
  const failingGit = Layer.fresh(Git.layer).pipe(
    Layer.provide(
      Layer.effect(
        ChildProcessSpawner,
        Effect.map(Effect.service(ChildProcessSpawner), (spawner) => ({
          ...spawner,
          spawn: (cmd: ChildProcess.Command) =>
            spawner.spawn(
              cmd._tag === "StandardCommand" && cmd.args.includes("cat-file")
                ? ChildProcess.make("false", [])
                : cmd
            ),
        }))
      )
    )
  );
  const read = (path: string) =>
    run(sealedFile(seal, path).pipe(Effect.provide(failingGit)));
  await assert.rejects(read("src/math.ts"), /Cannot read src\/math\.ts/);
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
  assert.match(out, /^a:b\.ts:1:const TOKEN = 1$/m);
});

test("store: legacy seals migrate on load; malformed seals and ledgers are damaged, not defaults", async () => {
  const dir = repo();
  write(dir, "src/math.ts", MATH + "// edit\n");
  const seal = await local(dir);
  const file = join(state, seal.id, "seal.json");
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["gen", "refreshes", "children", "deleted"]) delete legacy[k];
  for (const r of legacy.regions) delete r.readBy;
  legacy.gates = {
    coverage: true,
    children: true,
    open: true,
    freshness: true,
  };
  writeFileSync(file, JSON.stringify(legacy));
  const loaded = await run(loadSeal(seal.id));
  assert.deepEqual(
    [
      loaded.gen,
      loaded.refreshes,
      loaded.children,
      loaded.deleted,
      loaded.regions[0].readBy,
    ],
    [0, 0, [], [], []]
  );
  assert.deepEqual(
    loaded.gates,
    { coverage: [], children: [], open: [], freshness: "" },
    "a legacy true gate matches nothing new"
  );
  await run(Effect.flatMap(store, (st) => st.save(loaded)));
  assert.deepEqual(
    JSON.parse(readFileSync(file, "utf8")).gates,
    loaded.gates,
    "saved in the current format"
  );
  // A non-ISO deadline used to parse as NaN, which made the watchdog report at once.
  for (const bad of [
    { ...legacy, deadline: "soon" },
    { ...legacy, mode: "fast" },
    [legacy],
  ]) {
    writeFileSync(file, JSON.stringify(bad));
    await assert.rejects(run(loadSeal(seal.id)), /is damaged/);
  }
  writeFileSync(
    join(state, seal.id, "ledger.json"),
    JSON.stringify({ entries: [{ id: "F1" }], notes: [] })
  );
  await assert.rejects(
    run(loadLedger(seal.id)),
    /damaged; refusing to treat it as empty/
  );
});

test("listSeals ages seals by createdAt, which resume moves, not by the date in their id", async () => {
  const dir = repo();
  write(dir, "src/math.ts", MATH + "// edit\n");
  const seal = await local(dir);
  const json = JSON.parse(
    readFileSync(join(state, seal.id, "seal.json"), "utf8")
  );
  const resumed = "directorate-20200101000000-abcabc";
  mkdirSync(join(state, resumed));
  writeFileSync(
    join(state, resumed, "seal.json"),
    JSON.stringify({ ...json, id: resumed })
  );
  writeFileSync(
    join(state, seal.id, "seal.json"),
    JSON.stringify({ ...json, createdAt: "2020-01-01T00:00:00.000Z" })
  );
  const ids = (
    await run(
      Effect.flatMap(store, (st) => st.list({ maxAgeMs: 2 * 86_400_000 }))
    )
  ).map((s) => s.id);
  assert.ok(ids.includes(resumed), "an old id resumed recently is listed");
  assert.ok(!ids.includes(seal.id), "an old createdAt is not");
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
            repo: dir,
            mode: "default",
            target: { kind: "local" },
            owner: lead,
          })
        ),
        /Cannot read src\/locked\.ts/,
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
          repo: dir,
          mode: "full",
          target: { kind: "paths" },
          owner: lead,
        })
      );
      assert.match(p.files.find((f) => f.path === ".env")!.excluded!, /secret/);
      assert.match(
        (await run(finalize(p, { entries: [], notes: [] }, {}))).md,
        /1 changed secret-like file was withheld/
      );
      const l = await run(
        createSeal({
          repo: dir,
          mode: "default",
          target: { kind: "local", paths: [".env"] },
          owner: lead,
        })
      );
      assert.match(l.files.find((f) => f.path === ".env")!.excluded!, /secret/);
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
      Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join("\n") + "\n"
    );
    const regions = (await local(dir)).regions.filter(
      (r) => r.file === "big.txt"
    );
    assert.equal(
      regions.length,
      Math.ceil(200_001 / 400),
      "the @@ line plus 200,000 added lines, 400 patch lines per region"
    );
    assert.deepEqual(
      [
        regions[0].newStart,
        regions[0].newEnd,
        regions[1].newStart,
        regions.at(-1)!.newEnd,
      ],
      [1, 399, 400, 200_000]
    );
  }
);

test("mode changes count as drift; binary files compare by bytes", async () => {
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 9]);
  const dir = repo({ "run.sh": "echo hi\n", "img.bin": bin });
  write(dir, "run.sh", "echo hello\n");
  write(dir, "img.bin", Buffer.from([0, 255, 128, 0, 7]));
  const seal = await local(dir);
  assert.deepEqual(
    await run(changedSinceSeal(seal, seal)),
    [],
    "binary snapshot equals live bytes"
  );
  assert.equal(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint
  );
  fs.chmodSync(join(dir, "run.sh"), 0o755);
  assert.notEqual(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint
  );
});

// ---------- coverage ----------
test("coverage: size-charged chunks, per-chunk line ranges, owner reads, explicit skips win", async () => {
  const big =
    Array.from({ length: 1200 }, (_, i) => `const v${i} = ${i}`).join("\n") +
    "\n";
  const dir = repo({ "a.ts": "x\n" });
  write(dir, "big.ts", big);
  const p = await run(
    createSeal({
      repo: dir,
      mode: "full",
      target: { kind: "paths", paths: ["big.ts"] },
      owner: lead,
    })
  );
  assert.equal(
    nextRegions(p, { reader: "owner", owner: true }).picked.length,
    2
  );
  const ex = nextRegions(p, {
    ids: p.regions.map((r) => r.id),
    reader: "owner",
    owner: true,
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
  const R1 = [{ id: "R1", complete: true, next: 0 }];
  const scouted = markShown(l, R1, { key: "s-scout", owner: false });
  assert.equal(
    coverageSummary(scouted).unread.length,
    4,
    "a scout's read does not cover the lead"
  );
  const read = markShown(scouted, R1, { key: "owner", owner: true });
  assert.equal(coverageSummary(read).read, 1);
  assert.deepEqual(
    read.regions[0].readBy,
    ["s-scout", "owner"],
    "readers are sessions, so two of one role each read everything"
  );
  assert.equal(
    nextRegions(read, { reader: "s-other", owner: false }).picked[0].id,
    "R1",
    "another reader of the same role still gets R1"
  );
  assert.equal(l.regions[0].readBy.length, 0, "the earlier seal is unchanged");
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

test("renderRegions: old and new line numbers, a byte-bounded page with continuation", async () => {
  const dir = repo();
  write(dir, "src/math.ts", MATH + "// tail\n");
  const seal = await local(dir);
  const { text, shown } = await run(renderRegions(seal, seal.regions));
  assert.deepEqual(shown, [{ id: "R1", complete: true, next: 0 }]);
  assert.match(text, /^\s+4 \+\/\/ tail$/m);
  assert.match(text, /^\s+2\s+2\s+return a \/ b$/m);
  // Three bytes a character: a character budget would let this page run past OpenCode's 50 KiB cut.
  const wide =
    Array.from(
      { length: 300 },
      (_, i) => `const v${i} = "${"€".repeat(900)}"`
    ).join("\n") + "\n";
  const dir2 = repo({ "a.ts": "x\n" });
  write(dir2, "w.ts", wide);
  const p = await run(
    createSeal({
      repo: dir2,
      mode: "full",
      target: { kind: "paths", paths: ["w.ts"] },
      owner: lead,
    })
  );
  const first = await run(renderRegions(p, p.regions));
  assert.ok(
    Buffer.byteLength(first.text) <= OUTPUT_MAX_BYTES + 500,
    `${Buffer.byteLength(first.text)}`
  );
  assert.equal(first.shown[0].complete, false);
  const p2 = regions(p, (_, i) =>
    i ? {} : { offsets: { owner: first.shown[0].next } }
  );
  const second = await run(renderRegions(p2, p2.regions));
  assert.match(second.text, /continued from body line/);
  const one = "y".repeat(150_000);
  const dir3 = repo({ "a.ts": "x\n" });
  write(dir3, "one.json", one + "\n");
  const p3 = await run(
    createSeal({
      repo: dir3,
      mode: "full",
      target: { kind: "paths", paths: ["one.json"] },
      owner: lead,
    })
  );
  const r3 = await run(renderRegions(p3, p3.regions));
  assert.ok(
    Buffer.byteLength(r3.text) <= OUTPUT_MAX_BYTES + 500,
    "a long line is paged, not dumped"
  );
  assert.match(r3.text, /↪ y{100}/, "continuation segments");
  assert.equal(
    r3.shown[0].complete,
    false,
    "a region is complete only when every segment was shown"
  );
  let paged = markShown(p3, r3.shown, { key: "owner", owner: true });
  let pages = 1;
  for (let done = false; !done && pages < 10; pages++) {
    const r = await run(renderRegions(paged, paged.regions));
    done = r.shown[0].complete;
    paged = markShown(paged, r.shown, { key: "owner", owner: true });
  }
  assert.ok(pages >= 3 && pages < 10, `paged in ${pages} calls`);
  const rl = await run(readLines(p3, "one.json", "new"));
  assert.match(rl, /only the first \d+ are shown/);
  assert.ok(
    Buffer.byteLength(await run(readLines(p, "w.ts", "new"))) <=
      OUTPUT_MAX_BYTES + 500,
    "directorate_read pages by bytes too"
  );
  const short = Array.from({ length: 3000 }, () => "x").join("\n") + "\n";
  write(dir3, "short.ts", short);
  const p4 = await run(
    createSeal({
      repo: dir3,
      mode: "full",
      target: { kind: "paths", paths: ["short.ts"] },
      owner: lead,
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
    MATH + "\n\n\n\n\n\nexport const z = div(1, 0)\n}\n"
  );
  const seal = await local(dir);
  assert.deepEqual(
    await run(
      checkQuote(seal, at("src/math.ts", 10), "export const z = div(1, 0)")
    ),
    at("src/math.ts", 10)
  );
  assert.equal(
    (
      await run(
        checkQuote(seal, at("src/math.ts", 8), "export const z = div(1, 0)")
      )
    ).line,
    10,
    "snapped"
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 11), "}")),
    /too short/,
    "a lone brace identifies nothing"
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 10), "div(1, 0)")),
    /fragment/
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 1), "b: number) {\nreturn a /")),
    /fragment/
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 10), "return a % b")),
    /does not appear/
  );
  await assert.rejects(
    run(checkQuote(seal, at("src/math.ts", 1), "export const z = div(1, 0)")),
    /appears at line 10/
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
  const dir = repo({ "src/math.ts": MATH, ".gitignore": "node_modules/\n" });
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
      /line outside file/.test(e.message) &&
      /invalid line range/.test(e.message)
  );
  // Agents add side markers and notes; the rejection says what to drop.
  await assert.rejects(
    run(checkEvidence(seal, ["src/math.ts:1 (old)"])),
    /no side marker such as \(old\).*notes such as "none: searched …" go in trigger, brief, or rationale/
  );
  // math.ts shrank to one line; its removed lines are still evidence on the base side.
  assert.deepEqual(await run(checkEvidence(seal, ["src/math.ts:3"])), [
    "src/math.ts:3",
  ]);
  assert.deepEqual(
    [...depsOf(entry("F1", { evidence: ["./src/a.ts:5"] }) as any)].sort(),
    ["src/a.ts", "src/math.ts"]
  );
});

test("listings: worktree seals list what was sealed; dependency directories list one level from disk with link targets", async () => {
  const dir = repo({
    "src/math.ts": MATH,
    "old.ts": "x\n",
    ".gitignore": "node_modules/\n",
  });
  write(dir, "src/new.ts", "export const n = 1\n");
  rmSync(join(dir, "old.ts"));
  const seal = await local(dir);
  // Edits after sealing are not what directorate_read reads, so they are not listed either.
  write(dir, "src/later.ts", "later\n");
  rmSync(join(dir, "src/new.ts"));
  assert.match(
    await run(listFiles(seal)),
    /^3 files at the seal\n\.gitignore\nsrc\/math\.ts\nsrc\/new\.ts$/
  );
  assert.match(
    await run(listFiles(seal, "src")),
    /^2 files under src at the seal\nsrc\/math\.ts\nsrc\/new\.ts$/
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
    /^1 entries in app\/node_modules · installed dependency directory on disk, not part of the sealed change; one level\n/
  );
  assert.match(
    links,
    /^pkg\/ -> node_modules\/\.bun\/pkg@1\.0\.0\+abc123\/node_modules\/pkg$/m
  );
  const pkg = await run(listFiles(seal, "app/node_modules/pkg"));
  assert.match(
    pkg,
    /^2 entries in app\/node_modules\/pkg \(resolves to node_modules\/\.bun\/pkg@1\.0\.0\+abc123\/node_modules\/pkg\)/
  );
  assert.match(pkg, /^\.env {2}\(withheld\)$/m);
  assert.match(pkg, /^index\.js$/m);
  assert.equal(
    (await run(readable(seal, "app/node_modules/pkg/index.js"))).live,
    true
  );
  await assert.rejects(
    run(listFiles(seal, "node_modules/missing")),
    /not found \(installed dependencies: directorate_ls lists a dependency directory\)/
  );
  await assert.rejects(
    run(readable(seal, "app/node_modules/pkg/nope.js")),
    /directorate_ls lists a dependency directory/
  );
});

// ---------- ledger rules ----------
test("verdict rules: lead decides only minor entries by others; refuter decides the rest; authors may withdraw", () => {
  const F1 = entry("F1");
  const F2 = entry("F2", { severity: "important" });
  const F3 = entry("F3", { raisedBy: lead });
  const F4 = entry("F4", { status: "refuted" });
  const ledger: any = { entries: [F1, F2, F3, F4], notes: [] };
  const v = (e: any, by: any, verdict: any, extra: any = {}) =>
    verdictError(e, by, { verdict, evidence: ["a:1"], ...extra }, ledger);
  const lead2 = { agent: "directorate_liaison", session: "s-other" };
  assert.equal(v(F1, lead, "confirmed"), undefined);
  assert.match(
    v(F1, lead, "confirmed", { severity: "important" })!,
    /only as minor/
  );
  assert.match(v(F2, lead, "confirmed")!, /needs directorate_compliance/);
  assert.match(
    v(F2, lead, "refuted")!,
    /needs directorate_compliance/,
    "lead cannot bury an important entry"
  );
  assert.match(
    v(F2, lead, "duplicate", { of: "F1" })!,
    /needs directorate_compliance/
  );
  assert.equal(v(F2, refuter, "confirmed"), undefined);
  assert.match(
    v(F1, scout, "refuted")!,
    /Only directorate_liaison or directorate_compliance/
  );
  assert.match(v(F3, lead2, "confirmed")!, /only directorate_compliance/);
  assert.match(v(F3, lead, "confirmed")!, /raised in this session/);
  assert.equal(
    v(F3, lead, "refuted"),
    undefined,
    "authors may withdraw their own open entries"
  );
  assert.match(
    v(F4, lead, "confirmed")!,
    /Only directorate_compliance may re-decide/
  );
  assert.equal(v(F4, refuter, "confirmed"), undefined);
  assert.match(
    v(F1, lead, "duplicate", { of: "F4" })!,
    /only of open or confirmed/
  );
  assert.match(
    verdictError(
      F1 as any,
      lead,
      { verdict: "refuted", evidence: [] },
      ledger
    )!,
    /counterevidence/
  );
});

test("severity follows the current generation: a reopened upgraded entry still needs the refuter", () => {
  const F1: any = entry("F1", {
    status: "confirmed",
    verdicts: [
      {
        by: refuter,
        verdict: "confirmed",
        rationale: "",
        evidence: ["a:1"],
        severity: "blocking",
        at: T0,
      },
    ],
  });
  assert.equal(currentSeverity(F1), "blocking");
  const R1 = reopen(F1, "code changed");
  assert.deepEqual(
    [R1.status, R1.severity, R1.verdicts.length, R1.history!.length],
    ["open", "blocking", 0, 1]
  );
  assert.equal(F1.status, "confirmed", "the earlier entry is unchanged");
  assert.match(
    verdictError(
      R1,
      lead,
      { verdict: "confirmed", evidence: ["a:1"] },
      { entries: [R1], notes: [] }
    )!,
    /needs directorate_compliance/
  );
});

test("duplicates: merged claims never raise a verified severity; orphans stay unresolved", () => {
  const F1 = entry("F1", {
    status: "confirmed",
    verdicts: [
      {
        by: refuter,
        verdict: "confirmed",
        rationale: "",
        evidence: ["a:1"],
        severity: "minor",
        at: T0,
      },
    ],
  });
  const F2 = entry("F2", {
    severity: "blocking",
    status: "duplicate",
    verdicts: [
      {
        by: refuter,
        verdict: "duplicate",
        of: "F1",
        rationale: "",
        evidence: ["a:1"],
        at: T0,
      },
    ],
  });
  const F3 = entry("F3", { status: "refuted" });
  const F4 = entry("F4", {
    status: "duplicate",
    verdicts: [
      {
        by: lead,
        verdict: "duplicate",
        of: "F3",
        rationale: "",
        evidence: ["a:1"],
        at: T0,
      },
    ],
  });
  const ledger: any = { entries: [F1, F2, F3, F4], notes: [] };
  assert.equal(currentSeverity(F1 as any), "minor");
  assert.deepEqual(
    unresolved(ledger).map((e) => e.id),
    ["F4"]
  );
  const seal: any = {
    id: "x",
    mode: "default",
    description: "d",
    fingerprint: "f",
    refreshes: 0,
    regions: [],
    files: [],
    children: [],
    deleted: [],
  };
  const md = renderReport({ seal, ledger, status: "complete", reasons: [] });
  assert.match(
    md,
    /Directorate Directive: <Minor Revisions\/Tolerated with Notes>/
  );
  assert.match(
    md,
    /merged claims of higher severity \(unverified\): F2 blocking/
  );
});

// ---------- freshness and refresh ----------
test("freshness: committing the reviewed change is not drift; a real edit is; excluded files are ignored", async () => {
  const dir = repo();
  write(dir, "src/math.ts", MATH + "export const z = 1\n");
  const seal = await local(dir);
  g(dir, "add", "-A");
  assert.equal(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint,
    "staging"
  );
  g(dir, "commit", "-qm", "wip");
  assert.equal(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint,
    "committing"
  );
  write(dir, ".env", "X=1\n");
  assert.equal(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint,
    "secret files are not read, even for hashing"
  );
  write(dir, "package-lock.json", '{"v":3}\n');
  assert.notEqual(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint,
    "a lockfile bump after the seal is drift"
  );
  write(dir, "package-lock.json", "{}\n");
  write(dir, "src/math.ts", "changed\n");
  assert.notEqual(
    (await run(currentFingerprint(seal))).fingerprint,
    seal.fingerprint
  );
});

test("worktree refresh: new generation, @@-aligned regions, removed '--' lines intact, reopen on verifier evidence", async () => {
  const dir = repo({
    "src/math.ts": MATH,
    "src/guard.ts": "export const ok = true\n",
    "src/gone.ts": "x\n",
    "q.sql": "select 1;\n-- keep me\n-- drop me\n",
  });
  write(dir, "src/math.ts", MATH + "export const z = 1\n");
  write(dir, "q.sql", "select 2;\n-- keep me\n-- drop me\n");
  const seal = await local(dir);
  const ledger: any = {
    entries: [
      entry("F1", {
        status: "confirmed",
        evidence: ["src/math.ts:4"],
        verdicts: [
          {
            by: refuter,
            verdict: "confirmed",
            rationale: "",
            evidence: ["src/math.ts:2"],
            at: T0,
          },
        ],
      }),
      entry("F2", {
        status: "confirmed",
        anchor: at("src/zzz.ts", 1),
        evidence: ["src/other.ts:1"],
        verdicts: [
          {
            by: refuter,
            verdict: "confirmed",
            rationale: "",
            evidence: ["src/guard.ts:1"],
            at: T0,
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
  assert.deepEqual(r.files.sort(), ["q.sql", "src/gone.ts", "src/guard.ts"]);
  assert.deepEqual(
    r.reopened,
    ["F2"],
    "verifier evidence in guard.ts reopens F2"
  );
  assert.equal(r.seal.gen, 1);
  assert.ok(r.seal.deleted.includes("src/gone.ts"));
  const text = readFileSync(await run(diffFile(r.seal)), "utf8");
  assert.match(
    text,
    /^--- drop me$/m,
    "a removed '-- ' line is not rewritten as a header"
  );
  const lines = text.split("\n");
  for (const reg of r.newRegions)
    assert.match(
      lines[reg.patchStart - 1],
      /^@@/,
      `${reg.id} starts on its hunk header`
    );
  assert.ok(
    fs.existsSync(await run(diffFile(seal))),
    "the previous generation is kept"
  );
  assert.equal((await run(loadSeal(seal.id))).refreshes, 1);
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
      repo: dir,
      mode: "default",
      target: { kind: "range", base: "main", head: "feat" },
      owner: lead,
    })
  );
  g(dir, "checkout", "-q", "main");
  g(dir, "merge", "-q", "--ff-only", "feat");
  g(dir, "checkout", "-q", "feat");
  const ledger: any = {
    entries: [
      entry("F1", {
        status: "confirmed",
        quote: "  return Math.floor(a / b)",
        verdicts: [
          {
            by: refuter,
            verdict: "confirmed",
            rationale: "",
            evidence: ["src/math.ts:2"],
            at: T0,
          },
        ],
      }),
    ],
    notes: [],
  };
  const s0 = await run(loadSeal(seal.id));
  const { md } = await run(finalize(s0, ledger, {}));
  assert.match(md, /status: \*\*stale\*\*/);
  const r = await run(refreshSeal(seal, ledger));
  assert.equal(r.seal.regions.length, 0);
  assert.deepEqual(r.reopened, ["F1"]);
  assert.match(
    r.ledger.entries[0]!.staleReason!,
    /no longer part of the change/
  );
  assert.equal(
    ledger.entries[0].status,
    "confirmed",
    "the ledger passed in is unchanged"
  );
});

test("a file renamed from a secret path stays withheld: no diff content, no snapshot", async () => {
  const dir = repo({ "src/math.ts": MATH, ".env": "TOKEN=renamed-secret\n" });
  g(dir, "mv", ".env", "config.txt");
  const seal = await local(dir);
  const f = seal.files.find((x) => x.path === "config.txt")!;
  assert.deepEqual(
    [f.oldPath, f.excluded],
    [".env", "[REDACTED] secret-like path: content withheld"]
  );
  assert.ok(
    !readFileSync(await run(diffFile(seal)), "utf8").includes("renamed-secret")
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
      repo: dir,
      mode: "default",
      target: { kind: "range", base: "main", head: "feat" },
      owner: lead,
    })
  );
  write(dir, ".env", "API_KEY=leakme\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "b");
  const r = await run(refreshSeal(s, { entries: [], notes: [] }));
  assert.ok(r.files.includes(".env"));
  assert.ok(
    !readFileSync(await run(diffFile(r.seal)), "utf8").includes("leakme")
  );
});

// ---------- budget, report ----------
test("budget: drain is at least 20% and up to 6 minutes; lock at deadline", () => {
  const s = (min: number) => ({
    createdAt: T0,
    deadline: DateTime.add(T0, { minutes: min }),
  });
  const t = (m: number) => Date.parse("2026-01-01T00:00:00Z") + m * 60_000;
  assert.equal(budget(s(20), t(13)).phase, "normal");
  assert.equal(budget(s(20), t(14.5)).phase, "drain");
  assert.equal(budget(s(60), t(49)).phase, "drain");
  assert.equal(budget(s(20), t(20.1)).phase, "locked");
});

test("assess and render: skips make it partial; orphan duplicates count; refuted important candidates are listed", async () => {
  const dir = repo();
  write(dir, "src/math.ts", MATH + "// x\n");
  const sealed = await local(dir);
  const skipped = regions(sealed, () => ({
    disposition: "skipped",
    note: "out of time",
  }));
  const empty = { entries: [], notes: [] };
  const a = assess(skipped, empty, {}, "normal");
  assert.equal(a.status, "partial");
  assert.match(
    renderReport({ seal: skipped, ledger: empty, ...a }),
    /<Provisional\/Incomplete> — No Confirmed Issues[\s\S]*skipped: out of time/
  );
  const seal = regions(sealed, () => ({ ownerRead: true }));
  const ledger: any = {
    entries: [
      entry("F1", {
        severity: "important",
        status: "confirmed",
        verdicts: [
          {
            by: refuter,
            verdict: "confirmed",
            rationale: "r",
            evidence: ["src/math.ts:2"],
            severity: "blocking",
            at: T0,
          },
        ],
      }),
      entry("F2"),
      entry("F3", {
        severity: "important",
        status: "refuted",
        verdicts: [
          {
            by: refuter,
            verdict: "refuted",
            rationale: "guarded by caller",
            evidence: ["src/math.ts:1"],
            at: T0,
          },
        ],
      }),
      entry("F4", {
        status: "duplicate",
        verdicts: [
          {
            by: lead,
            verdict: "duplicate",
            of: "F3",
            rationale: "",
            evidence: ["src/math.ts:2"],
            at: T0,
          },
        ],
      }),
    ],
    notes: [
      {
        kind: "unanswered",
        text: "security auditor timed out",
        by: lead,
        at: T0,
      },
    ],
  };
  const b = assess(seal, ledger, {}, "normal");
  assert.match(b.reasons.join(), /2 leads unverified/);
  const md = renderReport({ seal, ledger, ...b });
  assert.match(
    md,
    /\*\*Directorate Directive: <Hold\/Blocking — Do Not Merge>\*\* · status: \*\*partial\*\*/
  );
  assert.match(md, /### Unverified Leads[\s\S]*title F2[\s\S]*title F4/);
  assert.match(
    md,
    /Refuted blocking\/important candidates \(cleared by Compliance\)[\s\S]*title F3[\s\S]*guarded by caller/
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
    "src/a.ts": "const needle = 1\nconst pin = 2\n",
    ".env": "needle=secret\n",
  });
  write(dir, "src/a.ts", "const other = 1\n");
  const seal = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "commit", commit: "HEAD" },
      owner: lead,
    })
  );
  const out = await run(grepSealed(seal, "needle\\|pin"));
  assert.match(out, /src\/a.ts:1:const needle = 1/);
  assert.match(out, /src\/a.ts:2:const pin = 2/);
  assert.match(out, /translated/);
  assert.ok(!out.includes("secret"));
});

test("history: log, blame, show with fixed arguments; secrets and option injection refused", async () => {
  const dir = repo({ "src/a.ts": "a\n", "config/master.key": "k\n" });
  write(dir, "src/a.ts", "b\n");
  g(dir, "commit", "-qam", "second commit");
  const seal = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "commit", commit: "HEAD" },
      owner: lead,
    })
  );
  assert.match(
    await run(history(seal, { kind: "log", path: "src/a.ts" })),
    /second commit/
  );
  assert.match(
    await run(history(seal, { kind: "blame", path: "src/a.ts" })),
    /\) b$/m
  );
  assert.match(
    await run(history(seal, { kind: "show", rev: "HEAD" })),
    /second commit/
  );
  await assert.rejects(
    run(
      history(seal, { kind: "show", rev: "HEAD", path: "config/master.key" })
    ),
    /withheld/
  );
  await assert.rejects(
    run(history(seal, { kind: "show", rev: "--output=/tmp/x" })),
    /Invalid revision/
  );
});

// ---------- round 3 regressions ----------
test("paths mode: unchanged committed files render, read, and anchor; '.' and no paths mean the whole repo", async () => {
  const dir = repo({
    "src/keep.ts": "export const keep = 1\nexport const two = 2\n",
    "lib/b.ts": "export const b = 1\n",
  });
  write(dir, "lib/b.ts", "export const b = 2\n");
  for (const paths of [undefined, ["."], ["src", "lib"]]) {
    const s = await run(
      createSeal({
        repo: dir,
        mode: "full",
        target: { kind: "paths", paths },
        owner: lead,
      })
    );
    const keep = s.regions.find((r) => r.file === "src/keep.ts")!;
    const { text, shown } = await run(renderRegions(s, [keep]));
    assert.match(
      text,
      /1 export const keep = 1\n\s+2 export const two = 2/,
      `rendered for paths=${JSON.stringify(paths)}`
    );
    assert.equal(shown[0].complete, true);
    assert.equal(
      s.files.find((f) => f.path === "src/keep.ts")!.status,
      "unchanged"
    );
    assert.match(
      await run(readLines(s, "src/keep.ts", "new")),
      /export const two = 2/
    );
    assert.ok(
      await run(checkQuote(s, at("src/keep.ts", 2), "export const two = 2"))
    );
    assert.match(
      (await run(sealedFile(s, "lib/b.ts")))!,
      /b = 2/,
      "changed files come from the snapshot"
    );
  }
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
  ])
    assert.ok(isSecret(p), p);
  for (const p of [
    "src/secrets.ts",
    "app/models/secret.rb",
    "lib/client_secret.go",
    "src/auth/credentials.ts",
    "tests/secret.spec.ts",
    ".env.example",
  ])
    assert.ok(!isSecret(p), p);
  const dir = repo({
    "src/secrets.ts": "export const x = 1\n",
    "config/secrets.yaml": "a: 1\n",
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
  assert.match(a.reasons.join(), /secret-like file was withheld/);
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
    assess(m, { entries: [], notes: [] }, {}, "normal").reasons.join(),
    /1 changed secret-like file was withheld/
  );
});

test("history: directory paths and pathspec magic cannot reach withheld files", async () => {
  const dir = repo({
    "config/secrets.yaml": "token: abc123\n",
    "config/app.ts": "x\n",
  });
  write(dir, "config/secrets.yaml", "token: zzz999\n");
  write(dir, "config/app.ts", "y\n");
  g(dir, "commit", "-qam", "rotate");
  const seal = await run(
    createSeal({
      repo: dir,
      mode: "default",
      target: { kind: "commit", commit: "HEAD" },
      owner: lead,
    })
  );
  await assert.rejects(
    run(history(seal, { kind: "show", rev: "HEAD", path: "config" })),
    /not a file/
  );
  await assert.rejects(
    run(history(seal, { kind: "show", rev: "HEAD", path: "config/*" })),
    /not a file/
  );
  const stat = await run(history(seal, { kind: "show", rev: "HEAD" }));
  assert.ok(!stat.includes("zzz999") && !stat.includes("abc123"));
  assert.ok(
    !/secrets\.yaml/.test(stat),
    "withheld names are dropped from the file list"
  );
  assert.match(
    await run(
      history(seal, { kind: "show", rev: "HEAD", path: "config/app.ts" })
    ),
    /\+y/
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
    readFileSync(await run(diffFile(r.seal)), "utf8"),
    /new mode 100755/
  );
  assert.equal(
    (await run(currentFingerprint(r.seal))).fingerprint,
    r.seal.fingerprint
  );
});

test("refresh uses the captured generation to reopen dependent findings", async () => {
  const dir = repo({
    "src/math.ts": MATH,
    "src/guard.ts": "export const checked = false\n",
    "src/caller.ts": "export const call = () => div(1, 0)\n",
  });
  write(dir, "src/math.ts", `${MATH}// first edit\n`);
  const seal = await local(dir);
  write(dir, "src/math.ts", `${MATH}// second edit\n`);
  const ledger = {
    entries: [
      entry("F1", {
        status: "confirmed",
        anchor: at("src/caller.ts", 1),
        quote: "export const call = () => div(1, 0)",
        evidence: ["src/guard.ts:1"],
      }),
    ],
    notes: [],
  };
  let attempt = 0;
  const result = await run(
    refreshSeal(seal, ledger, () =>
      Effect.sync(() => {
        if (attempt++ === 0)
          write(dir, "src/guard.ts", "export const checked = true\n");
      })
    )
  );
  assert.equal(attempt, 2);
  assert.deepEqual(result.reopened, ["F1"]);
  assert.match(
    (await run(sealedFile(result.seal, "src/guard.ts")))!,
    /checked = true/
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
  assert.ok(r.seal.regions.find((x) => x.file === "b.ts")!.ownerRead);
  assert.ok(
    await run(checkQuote(r.seal, at("a.ts", 2, "old"), "const removed = 2")),
    "a line removed after the seal anchors on the base side"
  );
  await assert.rejects(
    run(checkQuote(r.seal, at("a.ts", 2), "const removed = 2")),
    /not found/
  );
  assert.doesNotMatch(
    readFileSync(await run(diffFile(r.seal)), "utf8"),
    /# directorate: refresh/,
    "one coherent base→post-image diff"
  );
});

test("lead cannot launder severity through duplicates; refuting a target reopens its duplicates", () => {
  const F1 = entry("F1", {
    status: "confirmed",
    verdicts: [
      {
        by: lead,
        verdict: "confirmed",
        rationale: "",
        evidence: ["a:1"],
        severity: "minor",
        at: T0,
      },
    ],
  });
  const F2 = entry("F2", { severity: "blocking", raisedBy: lead });
  const ledger: any = { entries: [F1, F2], notes: [] };
  assert.match(
    verdictError(
      F2 as any,
      lead,
      { verdict: "duplicate", of: "F1", evidence: ["a:1"] },
      ledger
    )!,
    /hide the higher claim/
  );
  const F3 = entry("F3", { severity: "important" });
  const F4 = entry("F4", {
    status: "duplicate",
    verdicts: [
      {
        by: refuter,
        verdict: "duplicate",
        of: "F3",
        rationale: "",
        evidence: ["a:1"],
        at: T0,
      },
    ],
  });
  const r = decide(
    { entries: [F3, F4], notes: [] } as Ledger,
    { ...F3, status: "refuted" } as Ledger["entries"][number]
  );
  assert.deepEqual(r.reopened, ["F4"]);
  assert.deepEqual(
    r.ledger.entries.map((e) => e.status),
    ["refuted", "open"]
  );
  assert.deepEqual(
    decide(
      { entries: [F3, F4], notes: [] } as Ledger,
      { ...F3, status: "confirmed" } as Ledger["entries"][number]
    ).reopened,
    [],
    "only a refutation reopens them"
  );
});

test("quote snapping prefers the nearest match, not the first one above", async () => {
  const dir = repo();
  write(dir, "y.ts", "  return cached\nconst a = 1\n  return cached\n");
  const s2 = await local(dir);
  assert.equal(
    (await run(checkQuote(s2, at("y.ts", 3), "  return cached"))).line,
    3
  );
  assert.equal(
    (await run(checkQuote(s2, at("y.ts", 2), "  return cached"))).line,
    3,
    "ties go to the line below (distance order 0, +1, -1)"
  );
});

test("interrupting a mutation releases its lock", async () => {
  const seal = await local(repo());
  await run(
    Effect.gen(function* () {
      const locked = yield* Deferred.make<void>();
      const st = yield* Store;
      const first = yield* st
        .withLock(
          seal.id,
          Deferred.succeed(locked, undefined).pipe(Effect.andThen(Effect.never))
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
    Effect.flatMap(store, (st) =>
      st.withLock(
        seal.id,
        Effect.tryPromise(() => probe(150))
      )
    )
  );
  assert.equal(result.stdout.trim(), "waiting");
  assert.equal((await probe(2000)).stdout.trim(), "acquired");
});

test("PR freshness with a fake gh: unfetched base move is unverified; unfetched head move is stale", async () => {
  const dir = repo();
  g(dir, "checkout", "-q", "-b", "feat");
  write(dir, "src/math.ts", MATH + "// pr\n");
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
        number: 7,
        title: "t",
        url: "u",
        headRefOid: h,
        baseRefOid: b,
        baseRefName: "main",
        headRefName: "feat",
      })
    );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    writeFileSync(json, "{}");
    await assert.rejects(
      run(
        createSeal({
          repo: dir,
          mode: "default",
          target: { kind: "pr", pr: "7" },
          owner: lead,
        })
      ),
      /Invalid GitHub CLI response/
    );
    meta(head, base);
    const seal = await run(
      createSeal({
        repo: dir,
        mode: "default",
        target: { kind: "pr", pr: "7" },
        owner: lead,
      })
    );
    assert.equal(
      (await run(currentFingerprint(seal))).fingerprint,
      seal.fingerprint
    );
    meta(head, "1".repeat(40));
    await assert.rejects(
      run(currentFingerprint(seal)),
      /base moved .* not fetched/
    );
    meta("2".repeat(40), base);
    const cur = await run(currentFingerprint(seal));
    assert.match(cur.unfetched!, /PR head moved/);
    const { md } = await run(
      finalize(
        await run(loadSeal(seal.id)),
        { entries: [], notes: [] },
        { cur: Result.succeed(cur) }
      )
    );
    assert.match(md, /status: \*\*stale\*\*/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("budget lines are written for each role", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const s: any = {
    createdAt: DateTime.makeUnsafe(now - 9 * 60_000),
    deadline: DateTime.makeUnsafe(now + 60_000),
    budgetMinutes: 10,
  };
  assert.match(
    budgetLine(s, now, "directorate_auditor"),
    /file surviving candidates now and hand off/
  );
  assert.match(
    budgetLine(s, now, "directorate_compliance"),
    /finish the entry in hand/
  );
  assert.match(
    budgetLine(s, now, "directorate_liaison"),
    /call directorate_report/
  );
  assert.doesNotMatch(
    budgetLine(s, now, "directorate_auditor"),
    /directorate_report/
  );
});

// ---------- re-checks ----------
const confirmedBy = (by: any, evidence: string[]) => ({
  by,
  verdict: "confirmed",
  rationale: "",
  evidence,
  severity: "important",
  at: T0,
});

test("re-check: keeps the base and unchanged reads, carries verified findings and leads, reopens what the fixes touched", async () => {
  const dir = repo({
    "src/math.ts": MATH,
    "src/other.ts": "export const other = 1\n",
  });
  write(dir, "src/math.ts", MATH + "export const z = 1\n");
  write(dir, "src/other.ts", "export const other = 2\n");
  const sealed = await local(dir);
  const ledger: any = {
    entries: [
      entry("F1", {
        severity: "important",
        status: "confirmed",
        verdicts: [confirmedBy(refuter, ["src/math.ts:2"])],
      }),
      entry("F2", {
        severity: "important",
        status: "confirmed",
        anchor: at("src/other.ts", 1),
        quote: "export const other = 2",
        evidence: ["src/other.ts:1"],
        verdicts: [confirmedBy(refuter, ["src/other.ts:1"])],
      }),
      entry("F3", { status: "refuted" }),
      entry("F4"),
      entry("F5", {
        status: "duplicate",
        verdicts: [
          {
            by: refuter,
            verdict: "duplicate",
            of: "F1",
            rationale: "",
            evidence: ["src/math.ts:2"],
            at: T0,
          },
        ],
      }),
    ],
    notes: [
      {
        kind: "unanswered",
        text: "is div ever called with 0?",
        by: lead,
        at: T0,
      },
    ],
  };
  const prior = {
    ...regions(sealed, () => ({ ownerRead: true, readBy: ["owner"] })),
    reportedAt: T0,
  };
  await run(Effect.flatMap(store, (st) => st.saveBoth(prior, ledger)));

  await assert.rejects(
    run(recheckSeal({ prior: sealed, ledger, owner: lead })),
    /has not been reported/
  );

  // The fix touches math.ts only, and everything is committed: the base stays where the earlier review had it.
  write(dir, "src/math.ts", MATH + "export const z = 2\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "fix");
  const r = await run(recheckSeal({ prior, ledger, owner: lead }));

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
    r.ledger.entries[0].staleReason!,
    /changed since .*src\/math\.ts/
  );
  assert.equal(
    r.ledger.entries[0]!.verdicts.length,
    0,
    "a reopened finding's verdicts move to its history"
  );
  assert.deepEqual(r.unanswered, ["is div ever called with 0?"]);
  assert.deepEqual(r.ledger.notes, []);

  assert.equal((await run(loadSeal(r.seal.id))).recheckOf, sealed.id);
  assert.equal((await run(loadLedger(r.seal.id))).entries.length, 3);
  assert.ok(
    (await run(loadSeal(sealed.id))).reportedAt,
    "the earlier seal stays reported"
  );
});

test("re-check verdicts: only carried entries resolve, only Compliance decides carried verified findings, nobody resolves their own", () => {
  const verified = entry("F1", {
    carried: { id: "F7", status: "confirmed" },
  });
  const unverified = entry("F2", {
    carried: { id: "F8", status: "unverified" },
  });
  const own = entry("F3", {
    raisedBy: lead,
    carried: { id: "F9", status: "unverified" },
  });
  const fresh = entry("F4");
  const ledger: any = {
    entries: [verified, unverified, own, fresh],
    notes: [],
  };
  const v = (e: any, by: any, verdict: any, evidence = ["a:1"]) =>
    verdictError(e, by, { verdict, evidence }, ledger);
  assert.match(v(fresh, refuter, "resolved")!, /new in this review/);
  assert.match(
    v(verified, lead, "resolved")!,
    /route it to directorate_compliance/
  );
  assert.match(
    v(verified, lead, "refuted")!,
    /route it to directorate_compliance/,
    "the lead cannot drop a verified finding"
  );
  assert.equal(v(verified, refuter, "resolved"), undefined);
  assert.equal(v(verified, refuter, "confirmed"), undefined);
  assert.match(v(verified, refuter, "resolved", [])!, /lines that fix it/);
  assert.equal(
    v(unverified, lead, "resolved"),
    undefined,
    "minor unverified leads by others follow the usual rules"
  );
  assert.match(v(own, lead, "resolved")!, /different session must resolve/);
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
        by: refuter,
        verdict: "duplicate",
        of: "F1",
        rationale: "",
        evidence: ["a:1"],
        at: T0,
      },
    ],
  });
  const { ledger, reopened } = decide(
    { entries: [F1, F2], notes: [] } as any,
    { ...F1, status: "resolved" } as any
  );
  assert.deepEqual(reopened, ["F2"]);
  assert.match(ledger.entries[1]!.staleReason!, /was resolved/);
});

test("re-check Directive: names the earlier seal, marks findings still present or new, and lists what was resolved", () => {
  const earlier = "directorate-20260101000000-aaaaaa";
  const seal: any = {
    id: "directorate-20260101000000-bbbbbb",
    recheckOf: earlier,
    mode: "default",
    description: "d",
    fingerprint: "f",
    refreshes: 0,
    regions: [],
    files: [],
    children: [],
    deleted: [],
  };
  const still = entry("F1", {
    title: "still broken",
    severity: "important",
    status: "confirmed",
    carried: { id: "F3", status: "confirmed" },
    verdicts: [confirmedBy(refuter, ["src/math.ts:2"])],
  });
  const fresh = entry("F2", {
    title: "introduced by the fix",
    status: "confirmed",
    verdicts: [
      { ...confirmedBy(refuter, ["src/math.ts:2"]), severity: "minor" },
    ],
  });
  const fixed = entry("F3", {
    title: "was broken",
    status: "resolved",
    carried: { id: "F5", status: "confirmed" },
    verdicts: [
      {
        by: refuter,
        verdict: "resolved",
        rationale: "guarded now",
        evidence: ["src/math.ts:1"],
        at: T0,
      },
    ],
  });
  const render = (entries: any[], status: any = "complete") =>
    renderReport({ seal, ledger: { entries, notes: [] }, status, reasons: [] });
  const md = render([still, fresh, fixed]);
  assert.match(md, new RegExp(`re-check of \`${earlier}\``));
  assert.match(md, /2 verified, 1 resolved, 0 refuted/);
  assert.match(
    md,
    new RegExp(
      `still broken\\*\\* .* · still present \\(F3 in \`${earlier}\`\\)`
    )
  );
  assert.match(md, /introduced by the fix\*\* .* · new$/m);
  assert.match(
    md,
    new RegExp(
      `### Resolved Since \`${earlier}\`\\n- was broken — was \`src/math\\.ts:2\` \\(minor, F5\\); resolved by directorate_compliance: guarded now \`src/math\\.ts:1\``
    )
  );
  assert.match(
    render([fixed]),
    /<Approved\/Tolerated> — Prior Findings Resolved/
  );
  assert.match(
    render([{ ...still, status: "open", verdicts: [] }], "partial"),
    new RegExp(`verified as F3 in \`${earlier}\`, not re-checked`)
  );
});
