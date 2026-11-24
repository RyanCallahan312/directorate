// Directorate diff parsing: git's raw-and-patch output decoded into per-file pieces, assembled into the stored diff, and cut
// into review regions.
import { Effect, Schema, SchemaGetter, SchemaTransformation } from "effect";

import { exclusionReason } from "./exclusions.ts";
import { sha256 } from "./hash.ts";
import { type FileEntry, type Region, invalid } from "./model.ts";

const REGION_MAX_PATCH_LINES = 400;

/** One file's part of a diff. Its names come from git's NUL-separated raw record (or ls-files), never from patch text. */
const Piece = Schema.Struct({
  code: Schema.String,
  path: Schema.String,
  oldPath: Schema.optional(Schema.String),
  lines: Schema.Array(Schema.String),
});
export type Piece = typeof Piece.Type;
/** Patch sections a raw record owns: a typechange (a file that became a symlink, or back) has two. */
const sectionsOf = (code: string) => (code === "T" ? 2 : 1);

/**
 * `git diff --raw -z -p` as one piece per file, after OpenCode's own split (packages/core/src/vcs/patch.ts). The raw
 * records come first, NUL-separated and unquoted; after an empty field, the patch has one `diff --git` section per
 * record in the same order. Decoding fails when the two disagree. The Directorate never writes this format, so encoding is refused.
 */
export const RawDiff = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Piece),
    SchemaTransformation.makeTransformation({
      decode: SchemaGetter.transformEffect<readonly Piece[], string>(
        (out, options) => {
          const end = out.indexOf("\0\0");
          const fields = (end < 0 ? out : out.slice(0, end)).split("\0");
          const records: Omit<Piece, "lines">[] = [];
          for (let i = 0; fields[i]?.startsWith(":");) {
            const code = fields[i].split(" ")[4]?.[0] ?? "M";
            const renamed = code === "R" || code === "C";
            records.push(
              renamed
                ? { code, oldPath: fields[i + 1], path: fields[i + 2] }
                : { code, path: fields[i + 1] }
            );
            i += renamed ? 3 : 2;
          }
          const patch =
            end < 0
              ? []
              : out
                  .slice(end + 2)
                  .replace(/\n$/, "")
                  .split("\n");
          // Hunk lines start with a space, +, -, or \, so a line starting `diff --git ` is always a section header.
          const sections = patch.flatMap((line, i) =>
            line.startsWith("diff --git ") ? [i] : []
          );
          const expected = records.reduce((n, r) => n + sectionsOf(r.code), 0);
          if (sections.length !== expected)
            return invalid(
              out.slice(0, 200),
              options,
              `git listed ${expected} patch sections but wrote ${sections.length}`
            );
          let k = 0;
          return Effect.succeed(
            records.map((r) => {
              const from = sections[k];
              k += sectionsOf(r.code);
              return {
                ...r,
                lines: patch.slice(from, sections[k] ?? patch.length),
              };
            })
          );
        }
      ),
      encode: SchemaGetter.forbidden<string, readonly Piece[]>(
        () => "The Directorate never writes git's raw diff format"
      ),
    })
  )
);

/** A name as it appears in a header The Directorate writes; display only, since names are never read back from the text. */
export const shown = (p: string) =>
  /[\x00-\x20"\\\x7f]/.test(p) ? JSON.stringify(p) : p;

type Hunk = {
  readonly newStart: number;
  readonly newLines: number;
  readonly patchStart: number;
  readonly patchEnd: number;
};
type ParsedFile = FileEntry & {
  readonly hunks: readonly Hunk[];
  readonly patchStart: number;
  readonly patchEnd: number;
};
const STATUS: Record<string, FileEntry["status"]> = {
  A: "added",
  C: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "modified",
};

/** The stored diff text and its files, with line offsets: withheld and binary files as stubs, the rest verbatim. */
export function assemble(pieces: readonly Piece[]): {
  text: string;
  files: ParsedFile[];
} {
  const out: string[] = [];
  const files = pieces.map((piece): ParsedFile => {
    let added = 0;
    let removed = 0;
    let binary = false;
    let inHunk = false;
    for (const line of piece.lines) {
      if (line.startsWith("diff --git ")) inHunk = false;
      else if (line.startsWith("@@")) inHunk = true;
      else if (inHunk)
        ((added += Number(line.startsWith("+"))),
          (removed += Number(line.startsWith("-"))));
      else if (line.startsWith("Binary files ") || line === "GIT binary patch")
        binary = true;
    }
    const excluded =
      exclusionReason(piece.path) ??
      (piece.oldPath ? exclusionReason(piece.oldPath) : undefined) ??
      (binary ? "binary" : undefined);
    const kept = excluded
      ? [
          `diff --git ${shown(`a/${piece.oldPath ?? piece.path}`)} ${shown(`b/${piece.path}`)}`,
          `# directorate: content withheld (${excluded})`,
        ]
      : piece.lines;
    const patchStart = out.length + 1;
    // Section and hunk headers, by line number; each hunk ends just before the next one.
    const marks: number[] = [];
    const opened: {
      newStart: number;
      newLines: number;
      patchStart: number;
      next: number;
    }[] = [];
    for (const line of kept) {
      const n = out.push(line);
      if (!line.startsWith("diff --git ") && !line.startsWith("@@")) continue;
      marks.push(n);
      const m = line.startsWith("@@")
        ? /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
        : undefined;
      if (line.startsWith("@@"))
        opened.push({
          newStart: m ? Number(m[1]) : 0,
          newLines: m && m[2] !== undefined ? Number(m[2]) : 1,
          patchStart: n,
          next: marks.length,
        });
    }
    const patchEnd = out.length;
    const hunks = opened.map(({ next, ...h }) => ({
      ...h,
      patchEnd: (marks[next] ?? patchEnd + 1) - 1,
    }));
    const status = binary ? "binary" : (STATUS[piece.code] ?? "modified");
    return {
      path: piece.path,
      oldPath: piece.oldPath,
      status: status === "modified" && !hunks.length ? "mode" : status,
      added,
      removed,
      excluded,
      hunks,
      patchStart,
      patchEnd,
    };
  });
  return { text: out.length ? `${out.join("\n")}\n` : "", files };
}

/** Regions of at most REGION_MAX_PATCH_LINES patch lines per hunk; withheld and binary files have none. */
export const buildRegions = Effect.fn("Directorate.buildRegions")(function* (
  files: readonly ParsedFile[],
  text: string
) {
  const lines = text.split("\n");
  const regions: Region[] = [];
  let k = 0;
  for (const f of files) {
    if (f.status === "binary" || f.excluded) continue;
    const header = lines
      .slice(f.patchStart - 1, (f.hunks[0]?.patchStart ?? f.patchEnd + 1) - 1)
      .filter((line) => !line.startsWith("index "))
      .join("\n");
    const key = (start: number, end: number, hunk = "") =>
      sha256(`${header}\0${hunk}\0${lines.slice(start - 1, end).join("\n")}`);
    if (!f.hunks.length) {
      regions.push({
        id: `R${++k}`,
        file: f.path,
        newStart: 0,
        newEnd: 0,
        patchStart: f.patchStart,
        patchEnd: f.patchEnd,
        readBy: [],
        key: yield* key(f.patchStart, f.patchEnd),
      });
      continue;
    }
    for (const h of f.hunks) {
      let next = h.newStart;
      for (let s = h.patchStart; s <= h.patchEnd; s += REGION_MAX_PATCH_LINES) {
        const e = Math.min(h.patchEnd, s + REGION_MAX_PATCH_LINES - 1);
        // New-side lines in this chunk (the @@ line is not one); a removal-only chunk anchors at the hunk start.
        const count = lines
          .slice(Math.max(s, h.patchStart + 1) - 1, e)
          .filter((l) => l.startsWith("+") || l.startsWith(" ")).length;
        regions.push({
          id: `R${++k}`,
          file: f.path,
          newStart: count ? next : h.newStart,
          newEnd: count ? next + count - 1 : h.newStart,
          patchStart: s,
          patchEnd: e,
          readBy: [],
          key: yield* key(s, e, lines[h.patchStart - 1]),
        });
        next += count;
      }
    }
  }
  return regions;
});
