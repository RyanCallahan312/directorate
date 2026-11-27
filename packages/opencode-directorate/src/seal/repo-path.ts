import { Effect, Option, Schema, SchemaTransformation } from "effect";

import { invalid } from "../platform/stored.ts";

/**
 * The repository-relative form of `input`, or none if it is absolute or climbs out; the root itself is "". POSIX only:
 * "/" is the one separator, so a backslash is part of a name.
 */
const inRepo = (input: string) => {
  const trimmed = input.trim();
  const parts: string[] = [];

  if (trimmed.startsWith("/")) {
    return Option.none<string>();
  }

  for (const part of trimmed.split("/")) {
    if (part === "..") {
      if (parts.length === 0) {
        return Option.none<string>();
      }

      parts.pop();
    } else if (part !== "" && part !== ".") {
      parts.push(part);
    }
  }

  return Option.some(parts.join("/"));
};

/** A directory scope in the repository, in git's form; "." (the whole repository) decodes to "". */
export const RepoScope = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (input, options) =>
        Option.match(inRepo(input), {
          onNone: () =>
            invalid(
              input,
              options,
              `Path ${input} must be relative to the repository and stay inside it.`
            ),
          onSome: Effect.succeed,
        }),
      encode: Effect.succeed,
    })
  )
);

/** A file in the repository, in git's form. */
export const RepoPath = RepoScope.check(
  Schema.makeFilter(
    (p: string) => p !== "" || "Expected a file path, not the repository root."
  )
);

const LINE_REF = /^(?<path>.+?):(?<start>\d+)(?:-(?<end>\d+))?$/u;

/** An evidence reference other than a URL: path:line or path:start-end, decoded to its parts and encoded back. */
export const LineRef = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({ end: Schema.Int, path: Schema.String, start: Schema.Int }),
    SchemaTransformation.transformEffect({
      decode: (input, options) => {
        const m = LINE_REF.exec(input.trim());

        const path = m?.[1];

        if (!m || path === undefined) {
          return invalid(
            input,
            options,
            'use a bare path:line, path:start-end, or URL, with no side marker such as (old) and no prose; both sides are checked, and notes such as "none: searched …" go in trigger, brief, or rationale'
          );
        }

        const start = Number(m[2]);
        const end = Number(m[3] ?? m[2]);

        if (start < 1 || end < start) {
          return invalid(input, options, "invalid line range");
        }

        return Option.match(inRepo(path), {
          onNone: () =>
            invalid(
              input,
              options,
              `Path ${m[1]} must be relative to the repository and stay inside it.`
            ),
          onSome: (relative) =>
            relative
              ? Effect.succeed({ end, path: relative, start })
              : invalid(
                  input,
                  options,
                  "Expected a file path, not the repository root."
                ),
        });
      },
      encode: (r) =>
        Effect.succeed(
          r.start === r.end
            ? `${r.path}:${r.start}`
            : `${r.path}:${r.start}-${r.end}`
        ),
    })
  )
);
