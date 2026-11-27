import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Option, Path, Schema } from "effect";

import { SessionIdSchema } from "../src/platform/host-id.ts";
import { encodeUtf8 } from "../src/platform/utf8.ts";
import { LiveEntry } from "../src/platform/worktree.ts";
import { insideRoot, looksBinary } from "../src/seal/content.ts";
import {
  assemble,
  buildRegions,
  hunkHeader,
  onNewSide,
  onOldSide,
  patchLine,
  RawDiff,
} from "../src/seal/diff.ts";
import { endsPair, repinDescription } from "../src/seal/ends.ts";
import { Changes, readerOf } from "../src/seal/region.ts";
import { LineRef } from "../src/seal/repo-path.ts";
import { OUTPUT_MAX_LINES, pageRegions } from "../src/seal/views.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const decodeRaw = Schema.decodeSync(RawDiff);

test("hunk headers: old and new starts, with or without counts; anything else is not one", () => {
  assert.deepEqual(hunkHeader("@@ -12,7 +14,9 @@ function f() {"), {
    newStart: 14,
    oldStart: 12,
  });
  assert.deepEqual(hunkHeader("@@ -1 +1 @@"), { newStart: 1, oldStart: 1 });
  assert.deepEqual(hunkHeader("@@ -0,0 +1,3 @@"), {
    newStart: 1,
    oldStart: 0,
  });
  assert.equal(hunkHeader("+@@ -1 +1 @@"), undefined);
  assert.equal(hunkHeader("diff --git a/x b/x"), undefined);
});

test("patch lines: added, removed, and context lines count on their sides; anything else on neither", () => {
  const kinds = ["+a", "-b", " c", "\\ No newline at end of file", ""].map(
    patchLine
  );

  assert.deepEqual(kinds, ["added", "removed", "context", "other", "other"]);
  assert.deepEqual(kinds.map(onNewSide), [true, false, true, false, false]);
  assert.deepEqual(kinds.map(onOldSide), [false, true, true, false, false]);
});

test("raw diff: rename and copy records name both paths; a typechange owns two patch sections", () => {
  const patch = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 90%",
    "rename from old.ts",
    "rename to new.ts",
    "diff --git a/src.ts b/copy.ts",
    "similarity index 75%",
    "copy from src.ts",
    "copy to copy.ts",
    "diff --git a/link b/link",
    "deleted file mode 120000",
    "diff --git a/link b/link",
    "new file mode 100644",
    "",
  ].join("\n");

  const records = [
    ":100644 100644 1 2 R090",
    "old.ts",
    "new.ts",
    ":100644 100644 1 3 C075",
    "src.ts",
    "copy.ts",
    ":120000 100644 4 5 T",
    "link",
  ];

  const pieces = decodeRaw([...records, "", patch].join("\0"));

  assert.deepEqual(
    pieces.map((p) => [p.code, p.oldPath, p.path, p.lines.length]),
    [
      ["R", "old.ts", "new.ts", 4],
      ["C", "src.ts", "copy.ts", 4],
      ["T", undefined, "link", 4],
    ]
  );
  assert.deepEqual(pieces[2]?.lines, [
    "diff --git a/link b/link",
    "deleted file mode 120000",
    "diff --git a/link b/link",
    "new file mode 100644",
  ]);

  // A typechange with one section disagrees with its record.
  assert.throws(
    () =>
      decodeRaw(
        [
          ":120000 100644 4 5 T",
          "link",
          "",
          "diff --git a/link b/link\nnew file mode 100644\n",
        ].join("\0")
      ),
    /git listed 2 patch sections but wrote 1/u
  );
});

test("regions: a hunk longer than a chunk splits with continuous old and new line numbers", async () => {
  const adds = Array.from({ length: 500 }, (_, i) => `+add ${i}`);

  const lines = [
    "diff --git a/f.ts b/f.ts",
    "index 1..2 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -10,3 +10,502 @@",
    " before",
    "-old",
    ...adds,
    " after",
  ];

  const { files, text } = assemble([{ code: "M", lines, path: "f.ts" }]);

  const regions = await runPromise(
    buildRegions(files, text).pipe(Effect.provide(NodeCrypto.layer))
  );

  assert.deepEqual(
    regions.map((r) => [
      r.patchStart,
      r.patchEnd,
      r.oldLine,
      r.newLine,
      r.newStart,
      r.newEnd,
    ]),
    [
      // The @@ line and 399 body lines: one context, one removal, 397 additions.
      [5, 404, 10, 10, 10, 407],
      // The other 103 additions and the trailing context line.
      [405, 508, 12, 408, 408, 511],
    ]
  );
  assert.ok(regions.every((r) => r.hunkStart === 5 && r.sectionStart === 1));
});

test("line refs: decode and encode round-trip, including a path with a colon", async () => {
  const decode = Schema.decodeUnknownEffect(LineRef);
  const encode = Schema.encodeEffect(LineRef);

  const refs = ["src/a:b.ts:3-7", "src/a.ts:12", "dir/x:1:3"];

  const decoded = await Promise.all(refs.map((r) => runPromise(decode(r))));

  assert.deepEqual(decoded, [
    { end: 7, path: "src/a:b.ts", start: 3 },
    { end: 12, path: "src/a.ts", start: 12 },
    { end: 3, path: "dir/x:1", start: 3 },
  ]);
  assert.deepEqual(
    await Promise.all(decoded.map((d) => runPromise(encode(d)))),
    refs
  );

  assert.equal(
    await runPromise(encode({ end: 4, path: "a:b", start: 4 })),
    "a:b:4"
  );
});

test("page regions: the first region shows at least a line and alone takes start", () => {
  const two = pageRegions(
    [
      { body: ["a", "b", "c"], id: "R1", offset: 0, title: "### R1" },
      { body: ["x", "y"], id: "R2", offset: 1, title: "### R2" },
    ],
    1,
    false
  );

  assert.equal(
    two.text,
    "### R1 (continued from body line 2)\nb\nc\n\n### R2 (continued from body line 2)\ny"
  );
  assert.deepEqual(
    two.shown.map((s) => [s.id, s.complete, s.next]),
    [
      ["R1", true, 0],
      ["R2", true, 0],
    ]
  );

  // A missing region is noted and comes first, so start does not reach the next one.
  const missing = pageRegions(
    [
      { body: [], id: "R1", missing: true, offset: 0, title: "### R1" },
      { body: ["x", "y"], id: "R2", offset: 0, title: "### R2" },
    ],
    1,
    false
  );

  assert.match(missing.text, /^### R1\n\[content unavailable at the seal/u);
  assert.match(missing.text, /\n\n### R2\nx\ny$/u);
  assert.deepEqual(
    missing.shown.map((s) => [s.id, s.complete, Boolean(s.missing)]),
    [
      ["R1", false, true],
      ["R2", true, false],
    ]
  );

  // A single line too long for the page is still shown; nothing follows it.
  const huge = pageRegions(
    [
      { body: ["y".repeat(60_000)], id: "R1", offset: 0, title: "### R1" },
      { body: ["x"], id: "R2", offset: 0, title: "### R2" },
    ],
    undefined,
    false
  );

  assert.deepEqual(
    huge.shown.map((s) => [s.id, s.complete]),
    [["R1", true]]
  );
});

test("page regions: a region cut by the line budget continues, naming from on a reported seal", () => {
  const body = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
  const fits = OUTPUT_MAX_LINES - 2;

  const open = pageRegions(
    [
      { body, id: "R1", offset: 0, title: "### R1" },
      { body: ["x"], id: "R2", offset: 0, title: "### R2" },
    ],
    undefined,
    false
  );

  assert.deepEqual(
    open.shown.map((s) => [s.id, s.complete, s.next]),
    [["R1", false, fits]]
  );
  assert.ok(
    open.text.endsWith(
      `\n[R1 continues: ${2000 - fits} more lines; call directorate_diff again]`
    )
  );

  const reported = pageRegions(
    [{ body, id: "R1", offset: 0, title: "### R1" }],
    undefined,
    true
  );

  assert.ok(
    reported.text.endsWith(
      `call directorate_diff again with regions ["R1"] and from ${fits + 1}]`
    )
  );
});

test("readers: the owner session reads under the owner mark, any other under its session", () => {
  assert.deepEqual(
    readerOf(
      SessionIdSchema.make("ses_lead"),
      SessionIdSchema.make("ses_lead")
    ),
    { key: "owner", owner: true }
  );
  assert.deepEqual(
    readerOf(
      SessionIdSchema.make("ses_scout"),
      SessionIdSchema.make("ses_lead")
    ),
    {
      key: "ses_scout",
      owner: false,
    }
  );
});

test("changes: listed as shown, with the base move among the files or only why the target is out of reach", () => {
  assert.deepEqual(
    Changes.make({ baseMoved: true, files: ["b.ts", "a.ts"] }).listed,
    ["(base moved)", "a.ts", "b.ts"]
  );
  assert.deepEqual(Changes.make({ baseMoved: false, files: ["a.ts"] }).listed, [
    "a.ts",
  ]);
  assert.deepEqual(
    Changes.make({
      baseMoved: false,
      files: [],
      unfetched: "PR head moved to abc (not fetched)",
    }).listed,
    ["(PR head moved to abc (not fetched))"]
  );
});

test("descriptions: each commit-pair format re-pins to new ends; a working-tree one names none", () => {
  const mb = "a".repeat(40);
  const head = "b".repeat(40);
  const base2 = "c".repeat(40);
  const head2 = "d".repeat(40);

  const range = `main...HEAD (merge-base ${endsPair(mb, head)})`;
  const pr = `PR #7 "Fix (it)" main...topic (${endsPair(mb, head)}) https://x/pull/7`;
  const auto = `branch 2 commits ahead of main (merge-base ${endsPair(mb)})`;

  assert.equal(
    range,
    "main...HEAD (merge-base aaaaaaaaaa → bbbbbbbbbb)",
    "the stored format"
  );
  assert.equal(
    repinDescription(range, base2, head2),
    "main...HEAD (merge-base cccccccccc → dddddddddd)"
  );
  assert.equal(
    repinDescription(pr, base2, head2),
    'PR #7 "Fix (it)" main...topic (cccccccccc → dddddddddd) https://x/pull/7'
  );
  assert.equal(
    auto,
    "branch 2 commits ahead of main (merge-base aaaaaaaaaa → working tree)"
  );
  assert.equal(repinDescription(auto, base2, head2), auto);
});

test("live entries: a link's bare target, and nothing for other entries", () => {
  const link = LiveEntry.make({
    buf: encodeUtf8("symlink -> ../lib/a.ts\n"),
    mode: "link",
  });

  assert.ok(link.isLink);
  assert.deepEqual(link.linkTarget, encodeUtf8("../lib/a.ts"));
  assert.equal(link.gitMode, "120000");

  const file = LiveEntry.make({ buf: encodeUtf8("x\n"), mode: "file" });
  assert.ok(!file.isLink);
  assert.equal(file.linkTarget, undefined);
  assert.equal(LiveEntry.make({ mode: "absent" }).linkTarget, undefined);
});

test("content: binary bytes, and paths inside the repository root", () => {
  assert.ok(looksBinary(Uint8Array.of(0x41, 0, 0x42)));
  assert.ok(!looksBinary(encodeUtf8("plain text\n")));
  const late = new Uint8Array(8001).fill(0x41);
  late[8000] = 0;
  assert.ok(!looksBinary(late), "only the first 8,000 bytes are checked");

  const paths = Effect.runSync(
    Path.Path.use(Effect.succeed).pipe(Effect.provide(NodePath.layer))
  );

  assert.deepEqual(
    insideRoot(paths, "/repo", "/repo/node_modules/x/index.js"),
    Option.some("node_modules/x/index.js")
  );
  assert.deepEqual(insideRoot(paths, "/repo", "/repo"), Option.some(""));
  assert.ok(Option.isNone(insideRoot(paths, "/repo", "/elsewhere/x")));
  assert.ok(Option.isNone(insideRoot(paths, "/repo", "/")));
  assert.deepEqual(
    insideRoot(paths, "/repo", "/repo/..x"),
    Option.some("..x"),
    "a name starting with two dots stays inside"
  );
});
