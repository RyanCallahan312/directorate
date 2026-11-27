// Directorate views of a seal: diff regions with line numbers, file reads, search, listings, and history, each paged to fit one
// tool result.
import { Effect, FileSystem, Match, Option, Path, Schema } from "effect";

import { inScope, isSecret, scopeOf } from "../exclusions.ts";
import {
  Git,
  IO_CONCURRENCY,
  isDeletedSignature,
  isDirectory,
} from "../platform/platform.ts";
import { encodeUtf8 } from "../platform/utf8.ts";
import { Records } from "../records/records.ts";
import {
  fromSecrets,
  inDependencyDir,
  insideRoot,
  installed,
  isWithheld,
  linesOf,
  NotInSeal,
  outsideWorktreeScope,
  readable,
  sealedFile,
  Withheld,
} from "./content.ts";
import { Shown } from "./coverage.ts";
import { onNewSide, onOldSide, patchLine } from "./diff.ts";
import type { Seal } from "./record.ts";
import { isBaseSide } from "./region.ts";
import type { Reader, Region, Side } from "./region.ts";

/**
 * OpenCode cuts any tool result over 2,000 lines or 50 KiB and shows the model only a preview, so The Directorate pages its own
 * output well inside both, leaving room for headers and the budget line.
 */
export const OUTPUT_MAX_BYTES = 40 * 1024;
export const OUTPUT_MAX_LINES = 1500;
const LINE_MAX_CHARS = 1000;
const READ_MAX_LINES = 400;

const lineSize = (line: string) => encodeUtf8(line).byteLength + 1;

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

/** Numbers the region's hunk lines from its stored old- and new-side counters. */
const appendHunkLines = (
  body: string[],
  lines: readonly string[],
  r: Region
) => {
  let o = r.oldLine ?? 0;
  let n = r.newLine ?? 0;

  for (let p = r.patchStart; p <= r.patchEnd; p += 1) {
    const l = lines[p - 1] ?? "";

    if (l.startsWith("@@")) {
      body.push(l);

      continue;
    }

    const kind = patchLine(l);
    const old = onOldSide(kind);
    const now = onNewSide(kind);

    body.push(
      ...(old || now
        ? splitLong(`${pad(old ? o : "")} ${pad(now ? n : "")} `, l)
        : [`${pad("")} ${pad("")} ${l}`])
    );

    o += Number(old);
    n += Number(now);
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

  // A metadata-only chunk is its section: it stores no section or hunk header line of its own.
  const hdr = r.sectionStart ?? r.patchStart;
  const isHunk = r.hunkStart !== undefined;
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
    appendHunkLines(body, lines, r);
  }

  return { body, title };
});

/** What a region that did not fit says: a reported seal saves no offset, so it names the line to pass back as from. */
const continuation = (
  reported: boolean,
  id: string,
  left: number,
  next: number
) =>
  `[${id} continues: ${left} more lines; ${reported ? `call directorate_diff again with regions ["${id}"] and from ${next + 1}` : "call directorate_diff again"}]`;

/** A region loaded for a page: its title and body lines, where its reader's last page ended, or missing at the seal. */
const LoadedRegionSchema = Schema.Struct({
  body: Schema.Array(Schema.String),
  id: Schema.String,
  missing: Schema.optional(Schema.Boolean),
  offset: Schema.Finite,
  title: Schema.String,
});

/**
 * Fits loaded regions, in order, into one output page. The first region starts at body line `start` when given and
 * shows at least one line; every other region starts at its offset, and paging stops before a region whose title or
 * first line does not fit. A region is complete only when all of it was shown, and paging stops after one that is not.
 * A reported seal saves no offsets, so its continuation names the line to pass back.
 */
export const pageRegions = (
  regions: readonly (typeof LoadedRegionSchema.Type)[],
  start: number | undefined,
  reported: boolean
) => {
  const parts: string[] = [];
  const shown = Array.of<Shown>();
  const page = outputPage();

  for (const r of regions) {
    if (shown.length && page.room([r.title, ""]) < 2) {
      break;
    }

    page.take(r.title);
    page.take("");

    if (r.missing) {
      const note =
        "[content unavailable at the seal; not counted as read. Record a directorate_coverage disposition.]";

      page.take(note);
      parts.push(`${r.title}\n${note}`);
      shown.push(
        Shown.make({ complete: false, id: r.id, missing: true, next: 0 })
      );
      continue;
    }

    const from = shown.length ? r.offset : (start ?? r.offset);
    const out: string[] = [];
    let i = from;

    for (; i < r.body.length; i += 1) {
      const line = r.body[i] ?? "";

      if (!page.fits(line) && (shown.length || out.length)) {
        break;
      }

      page.take(line);
      out.push(line);
    }

    if (!out.length && shown.length) {
      break;
    }

    const complete = i >= r.body.length;
    parts.push(
      `${r.title}${from ? ` (continued from body line ${from + 1})` : ""}\n${out.join("\n")}${complete ? "" : `\n${continuation(reported, r.id, r.body.length - i, i)}`}`
    );
    shown.push(Shown.make({ complete, id: r.id, next: complete ? 0 : i }));

    if (!complete) {
      break;
    }
  }

  return { shown, text: parts.join("\n\n") };
};

/**
 * Renders regions from the reader's offset (or, for the first region, from body offset `start`) within one output page
 * (see pageRegions).
 */
export const renderRegions = Effect.fn("Directorate.renderRegions")(
  function* renderRegions(
    seal: Seal,
    regions: readonly Region[],
    reader: Reader,
    start?: number
  ) {
    const lines = (yield* (yield* Records).readDiff(seal)).split("\n");

    const loaded = yield* Effect.forEach(
      regions,
      (r) =>
        regionBody(seal, r, lines).pipe(
          Effect.map(({ body, missing, title }) => ({
            body,
            id: r.id,
            missing,
            offset: r.offsets?.[reader.key] ?? 0,
            title,
          }))
        ),
      { concurrency: IO_CONCURRENCY }
    );

    return pageRegions(loaded, start, Boolean(seal.reportedAt));
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

  if (isBaseSide(side)) {
    return `base ${seal.baseSha.slice(0, 10)}`;
  }

  if (seal.pinsCommit) {
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
  const all = linesOf(r.content);
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

/** Where and how directorate_grep searches: these paths, a fixed string rather than a regex, ignoring case. */
const GrepSearchSchema = Schema.Struct({
  fixed: Schema.optional(Schema.Boolean),
  ignoreCase: Schema.optional(Schema.Boolean),
  paths: Schema.optional(Schema.Array(Schema.String)),
});

export const grepSealed = Effect.fn("Directorate.grepSealed")(
  function* grepSealed(
    seal: Seal,
    pattern: string,
    opts: typeof GrepSearchSchema.Type = {}
  ) {
    const scope = scopeOf(opts.paths) ?? [];
    const translate = !opts.fixed && /\\\|/u.test(pattern);
    const commit = seal.pinsCommit;

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
    const copied = fromSecrets(seal);

    const rows = out
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        const [name = "", line = "", ...text] = l.split("\0");
        const file = commit ? name.slice(seal.headSha.length + 1) : name;

        return isWithheld(seal, file, "new", copied)
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
    const { abs, rel, missing, root } = yield* installed(seal, dir);

    const names = (yield* fs.readDirectory(abs).pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.fail(new NotInSeal({ message: missing }))
      ),
      Effect.catchReason("PlatformError", "BadResource", () =>
        Effect.fail(new NotInSeal({ message: `${dir} is not a directory` }))
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

        const shown = `${name}${isDirectory(info?.type) ? "/" : ""}`;

        if (link === undefined) {
          return shown;
        }

        const target = Option.getOrUndefined(
          yield* Effect.option(fs.realPath(entry))
        );

        const linkTarget =
          target === undefined
            ? "(broken link)"
            : Option.getOrElse(
                insideRoot(paths, root, target),
                () => "(outside the repository)"
              );

        return `${shown} -> ${linkTarget}`;
      }),
      { concurrency: IO_CONCURRENCY }
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

  const names = seal.pinsCommit
    ? yield* tree(seal.headSha)
    : [
        ...new Set([
          ...(yield* tree(seal.baseSha)),
          ...Object.entries(seal.sigs ?? {}).flatMap(([p, sig]) =>
            isDeletedSignature(sig) ? [] : [p]
          ),
          ...seal.files.flatMap((f) => (f.isDeleted ? [] : [f.path])),
        ]),
      ]
        .filter((p) => inScope(p, scope) && !gone.has(p))
        .toSorted();

  if (!names.length && dir && inDependencyDir(dir)) {
    return yield* listInstalled(seal, dir);
  }

  const copied = fromSecrets(seal);

  const marked = names.map((p) =>
    isWithheld(seal, p, "new", copied) ? `${p}  (withheld)` : p
  );

  const shown = marked.slice(0, fitting(marked));

  return `${names.length} files${scope.length ? ` under ${scope.join(", ")}` : ""} at the seal\n${shown.join("\n")}${marked.length > shown.length ? `\n… ${marked.length - shown.length} more; pass a directory` : ""}`;
});

/** A read request missing what it needs, asking for what it may not, or naming no such revision or file. */
export class InvalidRead extends Schema.TaggedError<
  InvalidRead,
  { readonly brand: unique symbol }
>()("InvalidRead", { message: Schema.String }) {}

/** git's object type for a file (`cat-file -t`). */
const isBlob = Schema.is(Schema.Literal("blob"));

const REV = /^(?!-)[0-9A-Za-z._/~^@{}-]+$/u;

/** A history command git refuses (a bad range, a path it does not know) is a bad request, told in git's own words. */
const gitRefused = <A, R>(
  self: Effect.Effect<A, Effect.Error<ReturnType<Git["Service"]["run"]>>, R>
) =>
  self.pipe(
    Effect.catchTag("GitFailed", (e) =>
      Effect.fail(new InvalidRead({ message: e.message }))
    )
  );

const historyShow = Effect.fnUntraced(function* historyShow(
  repo: string,
  rev: string,
  inputRev: string | undefined,
  path: string | undefined
) {
  if (!inputRev) {
    return yield* new InvalidRead({ message: "show needs rev" });
  }

  const git = yield* Git;

  if (path) {
    const isFile = (commit: string) =>
      git
        .run(repo, ["cat-file", "-t", `${commit}:${path}`], [0, 128])
        .pipe(Effect.map((type) => isBlob(type.trim())));

    if (!(yield* isFile(rev)) && !(yield* isFile(`${rev}^`))) {
      return yield* new InvalidRead({
        message: `${path} is not a file at ${inputRev} or its parent; pass a file path.`,
      });
    }
  }

  const out = yield* git
    .run(repo, [
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
    ])
    .pipe(gitRefused);

  if (path) {
    return out;
  }

  return out
    .split("\n")
    .filter((l) => !isSecret(l.trim().split(/\s+\|/u)[0]?.trim() ?? ""))
    .join("\n");
});

/** What directorate_history shows: a log, a blame, or one commit. */
export const HistoryKindSchema = Schema.Literals(["log", "blame", "show"]);

/** Blame and show print a file's content; a log prints only commits. */
const printsContent = Schema.is(HistoryKindSchema.pick(["blame", "show"]));

/** A directorate_history request: what to show, and for which file, revision, lines, or number of commits. */
const HistoryRequestSchema = Schema.Struct({
  end: Schema.optionalKey(Schema.Finite),
  kind: HistoryKindSchema,
  limit: Schema.optionalKey(Schema.Finite),
  path: Schema.optionalKey(Schema.String),
  rev: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(Schema.Finite),
});

export const history = Effect.fn("Directorate.history")(function* history(
  seal: Seal,
  input: typeof HistoryRequestSchema.Type
) {
  const git = yield* Git;
  const { path } = input;

  if (path && isSecret(path)) {
    return yield* new Withheld({
      message: `${path} is a secret-like path; withheld.`,
    });
  }

  // Blame and show would print the content it was renamed or copied from.
  if (path && printsContent(input.kind) && isWithheld(seal, path)) {
    return yield* new Withheld({
      message: `${path} was renamed or copied from a secret-like path; withheld.`,
    });
  }

  if (input.rev && !REV.test(input.rev)) {
    return yield* new InvalidRead({
      message: `Invalid revision ${input.rev}.`,
    });
  }

  // Before the first commit, the seal's head is the empty tree, which has no history.
  const head = (yield* git.hasCommit(seal.repo, seal.headSha))
    ? seal.headSha
    : undefined;

  const rev = input.rev ? yield* git.revParse(seal.repo, input.rev) : head;

  if (!rev) {
    return "(no committed history)";
  }

  const blame = () => {
    if (!path) {
      return Effect.fail(new InvalidRead({ message: "blame needs path" }));
    }

    const s = input.start ?? 1;
    const e = input.end ?? s + 80;

    return git
      .run(seal.repo, ["blame", "--date=short", `-L${s},${e}`, rev, "--", path])
      .pipe(gitRefused);
  };

  const out = yield* Match.value(input.kind).pipe(
    Match.when("log", () =>
      git
        .run(seal.repo, [
          "log",
          "--no-color",
          "--no-ext-diff",
          "--date=short",
          "--format=%h %ad %an %s",
          `-n${Math.min(input.limit ?? 30, 200)}`,
          rev,
          "--",
          ...(path ? [path] : []),
        ])
        .pipe(gitRefused)
    ),
    Match.when("blame", blame),
    Match.when("show", () => historyShow(seal.repo, rev, input.rev, path)),
    Match.exhaustive
  );

  const lines = out
    .replace(/\n$/u, "")
    .split("\n")
    .map((l) => clip(l));

  const n = fitting(lines);

  return n < lines.length
    ? `${lines.slice(0, n).join("\n")}\n… truncated; narrow with path, rev, or lines`
    : lines.join("\n") || "(no output)";
});
