import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Option, Path, Schema, SchemaTransformation } from "effect";

import { invalid } from "../platform/stored.ts";

/** The repository-relative form of `input`, or none if it is absolute or climbs out; the root itself is "". */
const inRepo = (input: string) =>
  Path.Path.use((path) => {
    const trimmed = input.trim();
    const parts = trimmed.replaceAll(path.sep, "/").split("/");

    // Win32 stream names and trailing-dot aliases need validation beyond lexical containment.
    if (
      path.sep !== "/" &&
      (trimmed.includes(":") ||
        parts.some(
          (part) => part !== "." && part !== ".." && /[. ]$/u.test(part)
        ))
    ) {
      return Effect.succeed(Option.none<string>());
    }

    return Effect.succeed(
      Option.map(path.resolveWithin("/repo", trimmed), (absolute) =>
        path.relative("/repo", absolute).split(path.sep).join("/")
      )
    );
  }).pipe(Effect.provide(NodePath.layer));

/** A directory scope in the repository, in git's form; "." (the whole repository) decodes to "". */
export const RepoScope = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (input, options) =>
        inRepo(input).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                invalid(
                  input,
                  options,
                  `Path ${input} must be relative to the repository and stay inside it.`
                ),
              onSome: Effect.succeed,
            })
          )
        ),
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

        return inRepo(path).pipe(
          Effect.flatMap(
            Option.match({
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
            })
          )
        );
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
