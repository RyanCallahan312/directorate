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

const lineSize = (line: string) => Buffer.byteLength(line) + 1;

/** One page of tool output, filled line by line within OUTPUT_MAX_BYTES and OUTPUT_MAX_LINES. */
const outputPage = () => {
  let bytes = 0;
  let lines = 0;

  /** How many of `next` still fit, in order. */
  const room = (next: readonly string[]) => {
    let b = bytes;
    let n = 0;

    for (const line of next) {
      const needed = lineSize(line);

      if (b + needed > OUTPUT_MAX_BYTES || lines + n >= OUTPUT_MAX_LINES) {
        break;
      }

      b += needed;
      n += 1;
    }

    return n;
  };

  const take = (line: string) => {
    bytes += lineSize(line);
    lines += 1;
  };

  return { fits: (line: string) => room([line]) === 1, room, take };
};

/** How many leading lines fit one page. */
const fitting = (lines: readonly string[]) => outputPage().room(lines);

const clip = (line: string, max = LINE_MAX_CHARS) =>
  line.length > max ? `${line.slice(0, max)} …` : line;

const pad = (n: number | string) => String(n).padStart(5);

/** Long lines are split, never cut: continuation segments follow on marked lines. */
const splitLong = (prefix: string, line: string): string[] => {
  if (line.length <= LINE_MAX_CHARS) {
    return [`${prefix}${line}`];
  }

  const out = [`${prefix}${line.slice(0, LINE_MAX_CHARS)}`];
  const cont = `${" ".repeat(Math.max(0, prefix.length - 2))}↪ `;

  for (let i = LINE_MAX_CHARS; i < line.length; i += LINE_MAX_CHARS) {
    out.push(`${cont}${line.slice(i, i + LINE_MAX_CHARS)}`);
  }

  return out;
};

const regionTitle = (r: Region, isHunk: boolean): string => {
  if (!isHunk) {
    return `### ${r.id} ${r.file} (metadata only)`;
  }

  const suffix = r.newEnd
    ? ` (new lines ${r.newStart}-${r.newEnd})`
    : " (removed lines only)";

  return `### ${r.id} ${r.file}${suffix}`;
};

const appendHunkLines = (
  body: string[],
  lines: readonly string[],
  hunkHeader: string,
  hunkAt: number,
  r: Region
) => {
  const m = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<new>\d+)/u.exec(hunkHeader);
  let o = m ? Number(m[1]) : 0;
  let n = m ? Number(m[2]) : 0;

  for (let p = hunkAt; p <= r.patchEnd; p += 1) {
    const l = lines[p - 1] ?? "";
    const show = p >= r.patchStart;

    if (l.startsWith("@@")) {
      if (show) {
        body.push(l);
      }

      continue;
    }

    if (l.startsWith("+")) {
      if (show) {
        body.push(...splitLong(`${pad("")} ${pad(n)} `, l));
      }

      n += 1;
    } else if (l.startsWith(" ")) {
      if (show) {
        body.push(...splitLong(`${pad(o)} ${pad(n)} `, l));
      }

      o += 1;
      n += 1;
    } else if (l.startsWith("-")) {
      if (show) {
        body.push(...splitLong(`${pad(o)} ${pad("")} `, l));
      }

      o += 1;
    } else if (show) {
      body.push(`${pad("")} ${pad("")} ${l}`);
    }
  }
};

const regionBody = Effect.fnUntraced(function* regionBody(
  seal: Seal,
  r: Region,
  lines: readonly string[]
) {
  if (r.patchStart === 0) {
    const content = yield* sealedFile(seal, r.file);
    const title = `### ${r.id} ${r.file}:${r.newStart}-${r.newEnd} (whole file)`;

    if (content === undefined) {
      return { body: [], missing: true, title };
    }

    return {
      body: content
        .split("\n")
        .slice(r.newStart - 1, r.newEnd)
        .flatMap((l, i) => splitLong(`${pad(r.newStart + i)} `, l)),
      title,
    };
  }

  let hdr = r.patchStart;

  while (hdr > 1 && !lines[hdr - 1]?.startsWith("diff --git ")) {
    hdr -= 1;
  }

  let hunkAt = r.patchStart;

  while (hunkAt > hdr && !lines[hunkAt - 1]?.startsWith("@@")) {
    hunkAt -= 1;
  }

  const hunkHeader = lines[hunkAt - 1];
  const isHunk = hunkHeader?.startsWith("@@") ?? false;
  const title = regionTitle(r, isHunk);
  const body: string[] = [];

  for (let p = hdr; p <= lines.length; p += 1) {
    const l = lines[p - 1] ?? "";

    if (p > hdr && (l.startsWith("@@") || l.startsWith("diff --git "))) {
      break;
    }

    if (!l.startsWith("index ")) {
      body.push(...splitLong("", l));
    }
  }

  if (isHunk) {
    appendHunkLines(body, lines, hunkHeader ?? "", hunkAt, r);
  }

  return { body, title };
});

/** Renders regions from the reader's offset within one output page. A region is complete only when all of it was shown. */
export const renderRegions = Effect.fn("Directorate.renderRegions")(
  function* renderRegions(
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

      if (shown.length && page.room([title, ""]) < 2) {
        break;
      }

      page.take(title);
      page.take("");

      if (missing) {
        const note =
          "[content unavailable at the seal; not counted as read. Record a directorate_coverage disposition.]";

        page.take(note);
        parts.push(`${title}\n${note}`);
        shown.push({ complete: false, id: r.id, missing: true, next: 0 });
        continue;
      }

      const from = r.offsets?.[reader] ?? 0;
      const out: string[] = [];
      let i = from;

      for (; i < body.length; i += 1) {
        const line = body[i] ?? "";

        if (!page.fits(line) && (shown.length || out.length)) {
          break;
        }

        page.take(line);
        out.push(line);
      }

      if (!out.length && shown.length) {
        break;
      }

      const complete = i >= body.length;
      parts.push(
        `${title}${from ? ` (continued from body line ${from + 1})` : ""}\n${out.join("\n")}${complete ? "" : `\n[${r.id} continues: ${body.length - i} more lines; call directorate_diff again]`}`
      );
      shown.push({ complete, id: r.id, next: complete ? 0 : i });

      if (!complete) {
        break;
      }
    }

    return { shown, text: parts.join("\n\n") };
  }
);

const readSourceLabel = (
  seal: Seal,
  path: string,
  side: Side,
  live: boolean
): string => {
  if (live) {
    return "installed dependency on disk (not part of the sealed change)";
  }

  if (side === "old") {
    return `base ${seal.baseSha.slice(0, 10)}`;
  }

  if (seal.postImage === "commit") {
    return `head ${seal.headSha.slice(0, 10)}`;
  }

  if (outsideWorktreeScope(seal, path)) {
    return `base ${seal.baseSha.slice(0, 10)} (outside the sealed scope; working tree not captured)`;
  }

  return "sealed post-image";
};

export const readLines = Effect.fn("Directorate.readLines")(function* readLines(
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

  for (let i = s; i <= e0; i += 1) {
    const line = all[i - 1] ?? "";
    const segs = splitLong(`${pad(i)} `, line);
    const n = page.room(segs);

    if (n < segs.length) {
      if (out.length) {
        break;
      }

      // A single line too long for a page: show what fits and say so.
      const part = segs.slice(0, n);
      out.push(...part);
      cut = `\n[line ${i} is ${line.length} characters; only the first ${part.reduce((a, x) => a + x.length, 0)} are shown. Its changed parts are in directorate_diff.]`;
      e = i;
      break;
    }

    for (const seg of segs) {
      page.take(seg);
    }

    out.push(...segs);
    e = i;
  }

  const src = readSourceLabel(seal, path, side, Boolean(r.live));

  return `${path}:${s}-${e} of ${all.length} · ${src}\n${out.join("\n")}${cut}${e < all.length ? `\n… ${all.length - e} more lines (pass start: ${e + 1})` : ""}`;
});

export const grepSealed = Effect.fn("Directorate.grepSealed")(
  function* grepSealed(
    seal: Seal,
    pattern: string,
    opts: {
      paths?: readonly string[] | undefined;
      fixed?: boolean | undefined;
      ignoreCase?: boolean | undefined;
    } = {}
  ) {
    const scope = scopeOf(opts.paths) ?? [];
    const translate = !opts.fixed && /\\\|/u.test(pattern);
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
      translate ? pattern.replaceAll("\\|", "|") : pattern,
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
  }
);

/** One level of an installed dependency directory on disk, with each link's resolved target, so agents need not guess paths. */
const listInstalled = Effect.fn("Directorate.listInstalled")(
  function* listInstalled(seal: Seal, dir: string) {
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
      )).toSorted();

    const rows = yield* Effect.forEach(
      names,
      Effect.fnUntraced(function* rows(name) {
        const entry = paths.join(abs, name);

        if (isSecret(`${rel}/${name}`)) {
          return `${name}  (withheld)`;
        }

        const info = Option.getOrUndefined(
          yield* Effect.option(fs.stat(entry))
        );

        const link = Option.getOrUndefined(
          yield* Effect.option(fs.readLink(entry))
        );

        const shown = `${name}${info?.type === "Directory" ? "/" : ""}`;

        if (link === undefined) {
          return shown;
        }

        const target = Option.getOrUndefined(
          yield* Effect.option(fs.realPath(entry))
        );

        const relTarget =
          target && paths.relative(root, target).split(paths.sep).join("/");

        let linkTarget: string;

        if (relTarget === undefined) {
          linkTarget = "(broken link)";
        } else if (relTarget.startsWith("../") || paths.isAbsolute(relTarget)) {
          linkTarget = "(outside the repository)";
        } else {
          linkTarget = relTarget;
        }

        return `${shown} -> ${linkTarget}`;
      }),
      { concurrency: 16 }
    );

    const shown = rows.slice(0, fitting(rows));

    return `${names.length} entries in ${dir}${rel === dir ? "" : ` (resolves to ${rel})`} · installed dependency directory on disk, not part of the sealed change; one level\n${shown.join("\n")}${rows.length > shown.length ? `\n… ${rows.length - shown.length} more; list a subdirectory` : ""}`;
  }
);

/**
 * File names at the seal: the head tree for commit targets; for worktree targets, the base tree with the changes captured
 * at sealing (what directorate_read reads), not the live tree. A dependency directory with nothing sealed is listed from
 * disk instead (see listInstalled).
 */
export const listFiles = Effect.fn("Directorate.listFiles")(function* listFiles(
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
          .toSorted();

  if (!names.length && dir && inDependencyDir(dir)) {
    return yield* listInstalled(seal, dir);
  }

  const marked = names.map((p) => (isSecret(p) ? `${p}  (withheld)` : p));
  const shown = marked.slice(0, fitting(marked));

  return `${names.length} files${scope.length ? ` under ${scope.join(", ")}` : ""} at the seal\n${shown.join("\n")}${marked.length > shown.length ? `\n… ${marked.length - shown.length} more; pass a directory` : ""}`;
});

const REV = /^(?!-)[0-9A-Za-z._/~^@{}-]+$/u;

const historyShow = Effect.fnUntraced(function* historyShow(
  repo: string,
  rev: string,
  inputRev: string | undefined,
  path: string | undefined
) {
  if (!inputRev) {
    return yield* failure("show needs rev");
  }

  const git = yield* Git;

  if (path) {
    const isFile = (commit: string) =>
      git
        .run(repo, ["cat-file", "-t", `${commit}:${path}`], [0, 128])
        .pipe(Effect.map((type) => type.trim() === "blob"));

    if (!(yield* isFile(rev)) && !(yield* isFile(`${rev}^`))) {
      return yield* failure(
        `${path} is not a file at ${inputRev} or its parent; pass a file path.`
      );
    }
  }

  const out = yield* git.run(
    repo,
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

  if (path) {
    return out;
  }

  return out
    .split("\n")
    .filter((l) => !isSecret(l.trim().split(/\s+\|/u)[0]?.trim() ?? ""))
    .join("\n");
});

export const history = Effect.fn("Directorate.history")(function* history(
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
  const { path } = input;

  if (path && isSecret(path)) {
    return yield* failure(`${path} is a secret-like path; withheld.`);
  }

  if (input.rev && !REV.test(input.rev)) {
    return yield* failure(`Invalid revision ${input.rev}.`);
  }

  // Before the first commit, the seal's head is the empty tree, which has no history.
  const head = (yield* git.hasCommit(seal.repo, seal.headSha))
    ? seal.headSha
    : undefined;

  const rev = input.rev ? yield* git.revParse(seal.repo, input.rev) : head;

  if (!rev) {
    return "(no committed history)";
  }

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
    if (!path) {
      return yield* failure("blame needs path");
    }

    const s = input.start ?? 1;
    const e = input.end ?? s + 80;
    out = yield* git.run(
      seal.repo,
      ["blame", "--date=short", `-L${s},${e}`, rev, "--", path],
      [0, 128]
    );
  } else {
    out = yield* historyShow(seal.repo, rev, input.rev, path);
  }

  const lines = out
    .replace(/\n$/u, "")
    .split("\n")
    .map((l) => clip(l));

  const n = fitting(lines);

  return n < lines.length
    ? `${lines.slice(0, n).join("\n")}\n… truncated; narrow with path, rev, or lines`
    : lines.join("\n") || "(no output)";
});
