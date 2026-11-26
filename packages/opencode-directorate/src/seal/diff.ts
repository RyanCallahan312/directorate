// Directorate diff parsing: git's raw-and-patch output decoded into per-file pieces, assembled into the stored diff, and cut
// into review regions.
import { Effect, Schema, SchemaGetter, SchemaTransformation } from "effect";

import { exclusionReason } from "../exclusions.ts";
import { sha256 } from "../platform/platform.ts";
import { Count, invalid } from "../platform/stored.ts";
import { FileEntry, FileStatusSchema, Region } from "./region.ts";

const REGION_MAX_PATCH_LINES = 400;

/** One file's part of a diff. Its names come from git's NUL-separated raw record (or ls-files), never from patch text. */
const PieceSchema = Schema.Struct({
  code: Schema.String,
  lines: Schema.Array(Schema.String),
  oldPath: Schema.optional(Schema.String),
  path: Schema.String,
});

export type Piece = typeof PieceSchema.Type;

/** Patch sections a raw record owns: a typechange (a file that became a symlink, or back) has two. */
const sectionsOf = (code: string) => (code === "T" ? 2 : 1);

/**
 * `git diff --raw -z -p` as one piece per file, after OpenCode's own split (packages/core/src/vcs/patch.ts). The raw
 * records come first, NUL-separated and unquoted; after an empty field, the patch has one `diff --git` section per
 * record in the same order. Decoding fails when the two disagree. The Directorate never writes this format, so encoding is refused.
 */
export const RawDiff = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(PieceSchema),
    SchemaTransformation.makeTransformation({
      decode: SchemaGetter.transformEffect<readonly Piece[], string>(
        (out, options) => {
          const end = out.indexOf("\0\0");
          const fields = (end === -1 ? out : out.slice(0, end)).split("\0");
          const records: Omit<Piece, "lines">[] = [];

          let i = 0;
          let field = fields[i];

          while (field?.startsWith(":")) {
            const code = field.split(" ")[4]?.[0] ?? "M";
            const renamed = code === "R" || code === "C";
            const path = fields[i + (renamed ? 2 : 1)];
            const oldPath = renamed ? fields[i + 1] : undefined;

            if (!path || (renamed && !oldPath)) {
              return invalid(
                field,
                options,
                "git raw diff record is missing a path"
              );
            }

            records.push(oldPath ? { code, oldPath, path } : { code, path });
            i += renamed ? 3 : 2;
            field = fields[i];
          }

          const patch =
            end === -1
              ? []
              : out
                  .slice(end + 2)
                  .replace(/\n$/u, "")
                  .split("\n");

          // Hunk lines start with a space, +, -, or \, so a line starting `diff --git ` is always a section header.
          const sections = patch.flatMap((line, index) =>
            line.startsWith("diff --git ") ? [index] : []
          );

          const expected = records.reduce((n, r) => n + sectionsOf(r.code), 0);

          if (sections.length !== expected) {
            return invalid(
              out.slice(0, 200),
              options,
              `git listed ${expected} patch sections but wrote ${sections.length}`
            );
          }

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
  [...p].some(
    (char) => char <= " " || char === "\u007F" || char === '"' || char === "\\"
  )
    ? JSON.stringify(p)
    : p;

/** A hunk of the assembled diff: where its new-side lines start, and where it sits in the diff text. */
class Hunk extends Schema.Class<Hunk, { readonly brand: unique symbol }>(
  "directorate/Hunk"
)({
  newLines: Count,
  newStart: Count,
  patchEnd: Count,
  patchStart: Count,
  /** The line of this hunk's own `diff --git` header: a typechange's second section has its own. */
  sectionStart: Count,
}) {}

/** A file of the assembled diff: its entry's fields, and where it and its hunks sit in the diff text. */
class ParsedFile extends Schema.Class<
  ParsedFile,
  { readonly brand: unique symbol }
>("directorate/ParsedFile")({
  ...FileEntry.fields,
  hunks: Schema.Array(Hunk),
  patchEnd: Count,
  patchStart: Count,
}) {
  /** The file as the seal stores it. */
  get entry() {
    return FileEntry.make({
      added: this.added,
      excluded: this.excluded,
      oldPath: this.oldPath,
      path: this.path,
      removed: this.removed,
      status: this.status,
    });
  }
}

/** The raw-record status letters git writes for a changed file, other than those it never writes for a diff. */
const ChangeCodeSchema = Schema.Literals(["A", "C", "D", "M", "R", "T"]);

const isChangeCode = Schema.is(ChangeCodeSchema);

const STATUS = Schema.Record(ChangeCodeSchema, FileStatusSchema).make({
  A: "added",
  C: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "modified",
});

/** A raw record's status; any other letter reads as modified. */
const statusOf = (code: string) =>
  isChangeCode(code) ? STATUS[code] : "modified";

const patchStats = (lines: readonly string[]) => {
  let added = 0;
  let removed = 0;
  let binary = false;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk) {
      added += Number(line.startsWith("+"));
      removed += Number(line.startsWith("-"));
    } else if (
      line.startsWith("Binary files ") ||
      line === "GIT binary patch"
    ) {
      binary = true;
    }
  }

  return { added, binary, removed };
};

/** The stored diff text and its files, with line offsets: withheld and binary files as stubs, the rest verbatim. */
export const assemble = (pieces: readonly Piece[]) => {
  const out: string[] = [];

  const files = pieces.map((piece) => {
    const { added, binary, removed } = patchStats(piece.lines);

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
      sectionStart: number;
    }[] = [];

    let sectionStart = patchStart;

    for (const line of kept) {
      const n = out.push(line);

      if (!line.startsWith("diff --git ") && !line.startsWith("@@")) {
        continue;
      }

      marks.push(n);

      if (line.startsWith("diff --git ")) {
        sectionStart = n;
      }

      const m = line.startsWith("@@")
        ? /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,(?<count>\d+))? @@/u.exec(line)
        : undefined;

      if (line.startsWith("@@")) {
        opened.push({
          newLines: m && m[2] !== undefined ? Number(m[2]) : 1,
          newStart: m ? Number(m[1]) : 0,
          next: marks.length,
          patchStart: n,
          sectionStart,
        });
      }
    }

    const patchEnd = out.length;

    const hunks = opened.map(({ next, ...h }) =>
      Hunk.make({ ...h, patchEnd: (marks[next] ?? patchEnd + 1) - 1 })
    );

    const status = binary ? "binary" : statusOf(piece.code);

    return ParsedFile.make({
      added,
      excluded,
      hunks,
      oldPath: piece.oldPath,
      patchEnd,
      patchStart,
      path: piece.path,
      removed,
      status: status === "modified" && !hunks.length ? "mode" : status,
    });
  });

  return { files, text: out.length ? `${out.join("\n")}\n` : "" };
};

/** Regions of at most REGION_MAX_PATCH_LINES patch lines per hunk; withheld and binary files have none. */
export const buildRegions = Effect.fn("Directorate.buildRegions")(
  function* buildRegions(files: readonly ParsedFile[], text: string) {
    const lines = text.split("\n");
    const regions: Region[] = [];
    let k = 0;

    for (const f of files) {
      if (f.status === "binary" || f.excluded) {
        continue;
      }

      // A section's header as the reviewer sees it, without index IDs: a mode change alters the key, a re-hash does not.
      const headerOf = (start: number, end: number) =>
        lines
          .slice(start - 1, end - 1)
          .filter((line) => !line.startsWith("index "))
          .join("\n");

      const key = (header: string, start: number, end: number, hunk = "") =>
        sha256(`${header}\0${hunk}\0${lines.slice(start - 1, end).join("\n")}`);

      if (!f.hunks.length) {
        regions.push(
          Region.make({
            file: f.path,
            id: `R${(k += 1)}`,
            key: yield* key(
              headerOf(f.patchStart, f.patchEnd + 1),
              f.patchStart,
              f.patchEnd
            ),
            newEnd: 0,
            newStart: 0,
            patchEnd: f.patchEnd,
            patchStart: f.patchStart,
            readBy: [],
          })
        );
        continue;
      }

      for (const h of f.hunks) {
        const hunkHeader = lines[h.patchStart - 1] ?? "";

        // The section's prologue only, up to its first hunk: editing an earlier hunk leaves later hunks' keys alone.
        const first = f.hunks.find((x) => x.sectionStart === h.sectionStart);

        const header = headerOf(
          h.sectionStart,
          first?.patchStart ?? h.patchStart
        );

        let oldLine = Number(/^@@ -(?<old>\d+)/u.exec(hunkHeader)?.[1] ?? 0);
        let next = h.newStart;

        for (
          let s = h.patchStart;
          s <= h.patchEnd;
          s += REGION_MAX_PATCH_LINES
        ) {
          const e = Math.min(h.patchEnd, s + REGION_MAX_PATCH_LINES - 1);
          const body = lines.slice(Math.max(s, h.patchStart + 1) - 1, e);

          // New-side lines in this chunk (the @@ line is not one); a removal-only chunk anchors at the hunk start.
          const count = body.filter(
            (l) => l.startsWith("+") || l.startsWith(" ")
          ).length;

          const oldCount = body.filter(
            (l) => l.startsWith("-") || l.startsWith(" ")
          ).length;

          regions.push(
            Region.make({
              file: f.path,
              hunkStart: h.patchStart,
              id: `R${(k += 1)}`,
              key: yield* key(header, s, e, hunkHeader),
              newEnd: count ? next + count - 1 : h.newStart,
              newLine: next,
              newStart: count ? next : h.newStart,
              oldLine,
              patchEnd: e,
              patchStart: s,
              readBy: [],
              sectionStart: h.sectionStart,
            })
          );
          next += count;
          oldLine += oldCount;
        }
      }
    }

    return regions;
  }
);
