// Directorate views of a seal: diff regions with line numbers, file reads, search, listings, and history, each paged to fit one
// tool result.
import { Effect, FileSystem, Option, Path } from "effect";

import {
  inDependencyDir,
  installed,
  outsideWorktreeScope,
  readable,
  sealedFile,
} from "./content.ts";
import type { Shown } from "./coverage.ts";
import { failure } from "./error.ts";
import { inScope, isSecret, scopeOf } from "./exclusions.ts";
import { Git } from "./git.ts";
import type { Region, Seal, Side } from "./model.ts";
import { Store } from "./store.ts";

/**
 * OpenCode cuts any tool result over 2,000 lines or 50 KiB and shows the model only a preview, so The Directorate pages its own
 * output well inside both, leaving room for headers and the budget line.
 */
export const OUTPUT_MAX_BYTES = 40 * 1024;
export const OUTPUT_MAX_LINES = 1500;
const LINE_MAX_CHARS = 1000;
const READ_MAX_LINES = 400;

/** One page of tool output, filled line by line within OUTPUT_MAX_BYTES and OUTPUT_MAX_LINES. */
function outputPage() {
  let bytes = 0;
  let lines = 0;
  const size = (line: string) => Buffer.byteLength(line) + 1;
  /** How many of `next` still fit, in order. */
  const room = (next: readonly string[]) => {
    let b = bytes;
    let n = 0;
    while (
      n < next.length &&
      b + size(next[n]) <= OUTPUT_MAX_BYTES &&
      lines + n < OUTPUT_MAX_LINES
    )
      b += size(next[n++]);
    return n;
  };
  const take = (line: string) => {
    bytes += size(line);
    lines++;
  };
  return { room, fits: (line: string) => room([line]) === 1, take };
}
/** How many leading lines fit one page. */
const fitting = (lines: readonly string[]) => outputPage().room(lines);
const clip = (line: string, max = LINE_MAX_CHARS) =>
  line.length > max ? `${line.slice(0, max)} …` : line;

const pad = (n: number | string) => String(n).padStart(5);
/** Long lines are split, never cut: continuation segments follow on marked lines. */
function splitLong(prefix: string, line: string): string[] {
  if (line.length <= LINE_MAX_CHARS) return [`${prefix}${line}`];
  const out = [`${prefix}${line.slice(0, LINE_MAX_CHARS)}`];
  const cont = `${" ".repeat(Math.max(0, prefix.length - 2))}↪ `;
  for (let i = LINE_MAX_CHARS; i < line.length; i += LINE_MAX_CHARS)
    out.push(`${cont}${line.slice(i, i + LINE_MAX_CHARS)}`);
  return out;
}

const regionBody = Effect.fnUntraced(function* (
  seal: Seal,
  r: Region,
  lines: readonly string[]
) {
  if (r.patchStart === 0) {
    const content = yield* sealedFile(seal, r.file);
    const title = `### ${r.id} ${r.file}:${r.newStart}-${r.newEnd} (whole file)`;
    if (content === undefined) return { title, body: [], missing: true };
    return {
      title,
      body: content
        .split("\n")
        .slice(r.newStart - 1, r.newEnd)
        .flatMap((l, i) => splitLong(`${pad(r.newStart + i)} `, l)),
    };
  }
  let hdr = r.patchStart;
  while (hdr > 1 && !lines[hdr - 1].startsWith("diff --git ")) hdr--;
  let hunkAt = r.patchStart;
  while (hunkAt > hdr && !lines[hunkAt - 1].startsWith("@@")) hunkAt--;
  const isHunk = lines[hunkAt - 1]?.startsWith("@@") ?? false;
  const title = `### ${r.id} ${r.file}${!isHunk ? " (metadata only)" : r.newEnd ? ` (new lines ${r.newStart}-${r.newEnd})` : " (removed lines only)"}`;
  const body: string[] = [];
  for (let p = hdr; p <= lines.length; p++) {
    const l = lines[p - 1];
    if (p > hdr && (l.startsWith("@@") || l.startsWith("diff --git "))) break;
    if (!l.startsWith("index ")) body.push(...splitLong("", l));
  }
  if (isHunk) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(lines[hunkAt - 1]);
    let o = m ? Number(m[1]) : 0;
    let n = m ? Number(m[2]) : 0;
    for (let p = hunkAt; p <= r.patchEnd; p++) {
      const l = lines[p - 1] ?? "";
      const show = p >= r.patchStart;
      if (l.startsWith("@@")) {
        if (show) body.push(l);
        continue;
      }
      if (l.startsWith("+")) {
        if (show) body.push(...splitLong(`${pad("")} ${pad(n)} `, l));
        n++;
      } else if (l.startsWith(" ")) {
        if (show) body.push(...splitLong(`${pad(o)} ${pad(n)} `, l));
        o++;
        n++;
      } else if (l.startsWith("-")) {
        if (show) body.push(...splitLong(`${pad(o)} ${pad("")} `, l));
        o++;
      } else if (show) body.push(`${pad("")} ${pad("")} ${l}`);
    }
  }
  return { title, body };
});

/** Renders regions from the reader's offset within one output page. A region is complete only when all of it was shown. */
export const renderRegions = Effect.fn("Directorate.renderRegions")(function* (
  seal: Seal,
  regions: readonly Region[],
  reader = "owner"
) {
  const lines = (yield* (yield* Store).readDiff(seal)).split("\n");
  const parts: string[] = [];
  const shown: Shown[] = [];
  const page = outputPage();
  for (const r of regions) {
    const { title, body, missing } = yield* regionBody(seal, r, lines);
    if (shown.length && page.room([title, ""]) < 2) break;
    page.take(title);
    page.take("");
    if (missing) {
      const note =
        "[content unavailable at the seal; not counted as read. Record a directorate_coverage disposition.]";
      page.take(note);
      parts.push(`${title}\n${note}`);
      shown.push({ id: r.id, complete: false, next: 0, missing: true });
      continue;
    }
    const from = r.offsets?.[reader] ?? 0;
    const out: string[] = [];
    let i = from;
    for (; i < body.length; i++) {
      if (!page.fits(body[i]) && (shown.length || out.length)) break;
      page.take(body[i]);
      out.push(body[i]);
    }
    if (!out.length && shown.length) break;
    const complete = i >= body.length;
    parts.push(
      `${title}${from ? ` (continued from body line ${from + 1})` : ""}\n${out.join("\n")}${complete ? "" : `\n[${r.id} continues: ${body.length - i} more lines; call directorate_diff again]`}`
    );
    shown.push({ id: r.id, complete, next: complete ? 0 : i });
    if (!complete) break;
  }
  return { text: parts.join("\n\n"), shown };
});

export const readLines = Effect.fn("Directorate.readLines")(function* (
  seal: Seal,
  path: string,
  side: Side,
  start = 1,
  end?: number
) {
  const r = yield* readable(seal, path, side);
  const all = r.content.split("\n");
  const s = Math.max(1, start);
  const e0 = Math.min(
    all.length,
    end ?? s + READ_MAX_LINES - 1,
    s + READ_MAX_LINES - 1
  );
  const out: string[] = [];
  const page = outputPage();
  let e = s - 1;
  let cut = "";
  for (let i = s; i <= e0; i++) {
    const segs = splitLong(`${pad(i)} `, all[i - 1]);
    const n = page.room(segs);
    if (n < segs.length) {
      if (out.length) break;
      // A single line too long for a page: show what fits and say so.
      const part = segs.slice(0, n);
      out.push(...part);
      cut = `\n[line ${i} is ${all[i - 1].length} characters; only the first ${part.reduce((a, x) => a + x.length, 0)} are shown. Its changed parts are in directorate_diff.]`;
      e = i;
      break;
    }
    segs.forEach(page.take);
    out.push(...segs);
    e = i;
  }
  const src = r.live
    ? "installed dependency on disk (not part of the sealed change)"
    : side === "old"
      ? `base ${seal.baseSha.slice(0, 10)}`
      : seal.postImage === "commit"
        ? `head ${seal.headSha.slice(0, 10)}`
        : outsideWorktreeScope(seal, path)
          ? `base ${seal.baseSha.slice(0, 10)} (outside the sealed scope; working tree not captured)`
          : "sealed post-image";
  return `${path}:${s}-${e} of ${all.length} · ${src}\n${out.join("\n")}${cut}${e < all.length ? `\n… ${all.length - e} more lines (pass start: ${e + 1})` : ""}`;
});

export const grepSealed = Effect.fn("Directorate.grepSealed")(function* (
  seal: Seal,
  pattern: string,
  opts: {
    paths?: readonly string[];
    fixed?: boolean;
    ignoreCase?: boolean;
  } = {}
) {
  const scope = scopeOf(opts.paths) ?? [];
  const translate = !opts.fixed && /\\\|/.test(pattern);
  const commit = seal.postImage === "commit";
  // --null ends each file name with NUL, so names containing ":" are split correctly.
  const args = [
    "grep",
    "-n",
    "--null",
    "-I",
    "--no-color",
    "--no-textconv",
    opts.fixed ? "-F" : "-E",
    ...(opts.ignoreCase ? ["-i"] : []),
    "-e",
    translate ? pattern.replace(/\\\|/g, "|") : pattern,
    commit ? seal.headSha : "--untracked",
    "--",
    ...scope,
  ];
  const out = yield* (yield* Git).run(seal.repo, args, [0, 1]);
  const rows = out
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      const [name = "", line = "", ...text] = l.split("\0");
      const file = commit ? name.slice(seal.headSha.length + 1) : name;
      return isSecret(file)
        ? []
        : [clip(`${file}:${line}:${text.join("\0")}`, 300)];
    });
  const shown = rows.slice(0, Math.min(300, fitting(rows)));
  return `${commit ? `searched head ${seal.headSha.slice(0, 10)}` : "searched the live working tree (equals the seal unless files changed since; confirm deciding lines with directorate_read)"} · ${rows.length} matches${translate ? " · translated \\| to | (patterns are extended regex)" : ""}\n${shown.join("\n")}${rows.length > shown.length ? `\n… ${rows.length - shown.length} more; narrow the pattern or paths` : ""}`;
});

/**
 * File names at the seal: the head tree for commit targets; for worktree targets, the base tree with the changes captured
 * at sealing (what directorate_read reads), not the live tree. A dependency directory with nothing sealed is listed from
 * disk instead (see listInstalled).
 */
export const listFiles = Effect.fn("Directorate.listFiles")(function* (
  seal: Seal,
  dir?: string
) {
  const git = yield* Git;
  const scope = scopeOf(dir ? [dir] : undefined) ?? [];
  const tree = (rev: string) =>
    git
      .run(seal.repo, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        rev,
        "--",
        ...scope,
      ])
      .pipe(Effect.map((out) => out.split("\0").filter(Boolean)));
  const gone = new Set(seal.deleted);
  const names =
    seal.postImage === "commit"
      ? yield* tree(seal.headSha)
      : [
          ...new Set([
            ...(yield* tree(seal.baseSha)),
            ...Object.entries(seal.sigs ?? {}).flatMap(([p, sig]) =>
              sig === "deleted" ? [] : [p]
            ),
            ...seal.files.flatMap((f) =>
              f.status === "deleted" ? [] : [f.path]
            ),
          ]),
        ]
          .filter((p) => inScope(p, scope) && !gone.has(p))
          .sort();
  if (!names.length && dir && inDependencyDir(dir))
    return yield* listInstalled(seal, dir);
  const marked = names.map((p) => (isSecret(p) ? `${p}  (withheld)` : p));
  const shown = marked.slice(0, fitting(marked));
  return `${names.length} files${scope.length ? ` under ${scope.join(", ")}` : ""} at the seal\n${shown.join("\n")}${marked.length > shown.length ? `\n… ${marked.length - shown.length} more; pass a directory` : ""}`;
});

/** One level of an installed dependency directory on disk, with each link's resolved target, so agents need not guess paths. */
const listInstalled = Effect.fn("Directorate.listInstalled")(function* (
  seal: Seal,
  dir: string
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const { abs, rel, missing } = yield* installed(seal, dir);
  const root = yield* fs
    .realPath(seal.repo)
    .pipe(Effect.catchTag("PlatformError", () => failure(missing)));
  const names = (yield* fs
    .readDirectory(abs)
    .pipe(
      Effect.catchTag("PlatformError", () =>
        failure(`${dir} is not a directory`)
      )
    )).sort();
  const rows = yield* Effect.forEach(
    names,
    Effect.fnUntraced(function* (name) {
      const entry = paths.join(abs, name);
      if (isSecret(`${rel}/${name}`)) return `${name}  (withheld)`;
      const info = Option.getOrUndefined(yield* Effect.option(fs.stat(entry)));
      const link = Option.getOrUndefined(
        yield* Effect.option(fs.readLink(entry))
      );
      const shown = `${name}${info?.type === "Directory" ? "/" : ""}`;
      if (link === undefined) return shown;
      const target = Option.getOrUndefined(
        yield* Effect.option(fs.realPath(entry))
      );
      const relTarget =
        target && paths.relative(root, target).split(paths.sep).join("/");
      return `${shown} -> ${relTarget === undefined ? "(broken link)" : relTarget.startsWith("../") || paths.isAbsolute(relTarget) ? "(outside the repository)" : relTarget}`;
    }),
    { concurrency: 16 }
  );
  const shown = rows.slice(0, fitting(rows));
  return `${names.length} entries in ${dir}${rel !== dir ? ` (resolves to ${rel})` : ""} · installed dependency directory on disk, not part of the sealed change; one level\n${shown.join("\n")}${rows.length > shown.length ? `\n… ${rows.length - shown.length} more; list a subdirectory` : ""}`;
});

const REV = /^(?!-)[0-9A-Za-z._\/~^@{}-]+$/;
export const history = Effect.fn("Directorate.history")(function* (
  seal: Seal,
  input: {
    kind: "log" | "blame" | "show";
    path?: string;
    rev?: string;
    start?: number;
    end?: number;
    limit?: number;
  }
) {
  const git = yield* Git;
  const path = input.path;
  if (path && isSecret(path))
    return yield* failure(`${path} is a secret-like path; withheld.`);
  if (input.rev && !REV.test(input.rev))
    return yield* failure(`Invalid revision ${input.rev}.`);
  // Before the first commit, the seal's head is the empty tree, which has no history.
  const head = (yield* git.hasCommit(seal.repo, seal.headSha))
    ? seal.headSha
    : undefined;
  const rev = input.rev ? yield* git.revParse(seal.repo, input.rev) : head;
  if (!rev) return "(no committed history)";
  let out: string;
  if (input.kind === "log") {
    out = yield* git.run(
      seal.repo,
      [
        "log",
        "--no-color",
        "--no-ext-diff",
        "--date=short",
        "--format=%h %ad %an %s",
        `-n${Math.min(input.limit ?? 30, 200)}`,
        rev,
        "--",
        ...(path ? [path] : []),
      ],
      [0, 128]
    );
  } else if (input.kind === "blame") {
    if (!path) return yield* failure("blame needs path");
    const s = input.start ?? 1;
    const e = input.end ?? s + 80;
    out = yield* git.run(
      seal.repo,
      ["blame", "--date=short", `-L${s},${e}`, rev, "--", path],
      [0, 128]
    );
  } else {
    if (!input.rev) return yield* failure("show needs rev");
    if (path) {
      const isFile = (commit: string) =>
        git
          .run(seal.repo, ["cat-file", "-t", `${commit}:${path}`], [0, 128])
          .pipe(Effect.map((type) => type.trim() === "blob"));
      if (!(yield* isFile(rev)) && !(yield* isFile(`${rev}^`)))
        return yield* failure(
          `${path} is not a file at ${input.rev} or its parent; pass a file path.`
        );
    }
    out = yield* git.run(
      seal.repo,
      [
        "show",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        "--format=fuller",
        ...(path ? ["--patch"] : []),
        rev,
        "--",
        ...(path ? [path] : []),
      ],
      [0, 128]
    );
    if (!path)
      out = out
        .split("\n")
        .filter((l) => !isSecret(l.trim().split(/\s+\|/)[0]?.trim() ?? ""))
        .join("\n");
  }
  const lines = out
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => clip(l));
  const n = fitting(lines);
  return n < lines.length
    ? `${lines.slice(0, n).join("\n")}\n… truncated; narrow with path, rev, or lines`
    : lines.join("\n") || "(no output)";
});
