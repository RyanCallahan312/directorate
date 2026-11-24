// Directorate git and GitHub CLI access. Plugins get no process service from OpenCode, and ctx.vcs is bound to the plugin's own
// location: it cannot diff a pinned commit pair, detect renames, or read blobs, grep, log, or blame, and it empties
// patches past its size budget. Every call goes through the bounded command adapter.
import { Context, Effect, Layer, Predicate, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { command } from "./command.ts";
import { failure, ReviewError } from "./error.ts";

const GIT_ENV = (extra: Record<string, string> = {}) => ({
  GIT_CONFIG_PARAMETERS: "",
  GIT_EXTERNAL_DIFF: "",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  ...extra,
});

const decodePr = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      baseRefName: Schema.String,
      baseRefOid: Schema.String,
      headRefName: Schema.String,
      headRefOid: Schema.String,
      number: Schema.Int,
      title: Schema.String,
      url: Schema.String,
    })
  )
);

const make = Effect.gen(function* make() {
  const spawner = yield* ChildProcessSpawner;

  const exec = (
    name: string,
    args: readonly string[],
    options: Parameters<typeof command>[2]
  ) =>
    command(name, args, options).pipe(
      Effect.provideService(ChildProcessSpawner, spawner)
    );

  /** git's stdout; a nonzero exit fails unless it is listed in `ok`. */
  const run = Effect.fn("Git.run")(function* run(
    repo: string,
    args: readonly string[],
    ok: readonly number[] = [0],
    env: Record<string, string> = {}
  ) {
    const output = yield* exec(
      "git",
      [
        "-c",
        "core.quotepath=off",
        "-c",
        "diff.suppressBlankEmpty=false",
        "-c",
        "diff.submodule=short",
        "-C",
        repo,
        ...args,
      ],
      { env: GIT_ENV(env), timeout: 120_000 }
    ).pipe(
      Effect.catch((error) =>
        error.stdout !== undefined &&
        Predicate.isNumber(error.code) &&
        ok.includes(error.code)
          ? Effect.succeed(error.stdout)
          : failure(`git ${args[0]} failed: ${error.message}`)
      )
    );

    return output.toString("utf-8");
  });

  /** A file's bytes at a revision, or undefined when the revision has no such file (git exits 128). Anything else fails. */
  const blob = (repo: string, rev: string, path: string) =>
    exec("git", ["-C", repo, "cat-file", "blob", `${rev}:${path}`], {
      env: GIT_ENV(),
      timeout: 120_000,
    }).pipe(
      Effect.result,
      Effect.flatMap(
        Result.match({
          onFailure: (err) =>
            err.code === 128
              ? Effect.undefined
              : failure(
                  `Cannot read ${path} at ${rev.slice(0, 10)}: ${err.message}`
                ),
          onSuccess: Effect.succeed,
        })
      )
    );

  const check = (repo: string, args: string[]) =>
    run(repo, args).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    );

  const hasCommit = (repo: string, oid: string) =>
    check(repo, ["cat-file", "-e", `${oid}^{commit}`]);

  const isIgnored = (repo: string, p: string) =>
    // check-ignore checks a pathname and rejects Git's literal pathspec flag.
    run(repo, ["check-ignore", "-q", "--", p], [0], {
      GIT_LITERAL_PATHSPECS: "0",
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    );

  const root = (dir: string) =>
    run(dir, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.map((out) => out.trim())
    );

  /**
   * The empty tree in this repository's object format (its id differs between SHA-1 and SHA-256 repositories). It is the
   * base of a root commit, and stands in for HEAD before the first commit.
   */
  const emptyTree = (repo: string) =>
    run(repo, ["hash-object", "-t", "tree", "/dev/null"]).pipe(
      Effect.map((out) => out.trim())
    );

  /** The commit `rev` names, or else the empty tree. */
  const commitOrEmpty = Effect.fnUntraced(function* commitOrEmpty(
    repo: string,
    rev: string
  ) {
    return (
      (yield* run(repo, ["rev-parse", "--verify", "-q", rev], [0, 1])).trim() ||
      (yield* emptyTree(repo))
    );
  });

  const revParse = Effect.fn("Git.revParse")(function* revParse(
    repo: string,
    ref: string
  ) {
    const out = (yield* run(
      repo,
      ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`],
      [0, 1]
    )).trim();

    if (!out) {
      return yield* failure(
        `Cannot resolve ${ref} to a commit. Ask the user to fetch it (for example \`git fetch origin ${ref}\`), then seal again.`
      );
    }

    return out;
  });

  /** Reads the actual first parent: revision traversal treats shallow boundary commits as roots. */
  const parentOf = Effect.fn("Git.parentOf")(function* parentOf(
    repo: string,
    commit: string
  ) {
    const [, firstHeader] = (yield* run(repo, [
      "cat-file",
      "commit",
      commit,
    ])).split("\n", 2);

    if (!firstHeader?.startsWith("parent ")) {
      return yield* emptyTree(repo);
    }

    const parent = firstHeader.slice("parent ".length);

    if (!(yield* hasCommit(repo, parent))) {
      return yield* failure(
        `Cannot review commit ${commit.slice(0, 10)}: its first parent is not available. Deepen the clone's history and seal again.`
      );
    }

    return parent;
  });

  const defaultBranch = Effect.fn("Git.defaultBranch")(function* defaultBranch(
    repo: string
  ) {
    const sym = (yield* run(
      repo,
      ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
      [0, 1]
    )).trim();

    if (sym) {
      return sym;
    }

    for (const b of ["origin/main", "origin/master", "main", "master"]) {
      if (
        (yield* run(
          repo,
          ["rev-parse", "--verify", "-q", `${b}^{commit}`],
          [0, 1]
        )).trim()
      ) {
        return b;
      }
    }

    return yield* failure(
      "Cannot find the default branch (no origin/HEAD, main, or master). Ask the user which base to review against."
    );
  });

  /**
   * The merge base of two fetched commits. Without one (a shallow clone missing the shared history, or unrelated
   * histories) this fails rather than standing in a tip: a two-tip diff is not the change the branch made.
   */
  const mergeBase = Effect.fn("Git.mergeBase")(function* mergeBase(
    repo: string,
    base: string,
    head: string,
    labels?: { readonly base: string; readonly head: string }
  ) {
    const mb = (yield* run(repo, ["merge-base", base, head], [0, 1])).trim();

    if (mb) {
      return mb;
    }

    const shallow =
      (yield* run(repo, ["rev-parse", "--is-shallow-repository"])).trim() ===
      "true";

    const [b, h] = [labels?.base ?? base, labels?.head ?? head];

    return yield* failure(
      shallow
        ? `Cannot find the merge base of ${b} and ${h}: this shallow clone lacks their shared history. Ask the user to deepen it (\`git fetch --deepen=<n>\` or \`git fetch --unshallow\`), then seal again.`
        : `${b} and ${h} share no history (no merge base). Ask the user which base to review against.`
    );
  });

  /** Untracked files that .gitignore does not exclude. */
  const untracked = (repo: string, paths?: readonly string[]) =>
    run(repo, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...(paths ?? []),
    ]).pipe(Effect.map((out) => out.split("\0").filter(Boolean)));

  /**
   * Tracked files git is told not to check (assume-unchanged, or skip-worktree yet checked out) whose working bytes differ
   * from `base`. git's diff trusts the flag and never lists them, so their bytes are compared here. An absent skip-worktree
   * file is a sparse checkout, not a deletion.
   */
  const unwatched = Effect.fnUntraced(function* unwatched(
    repo: string,
    base: string,
    paths?: readonly string[]
  ) {
    // ls-files -v tags skip-worktree files S (s when also assume-unchanged) and assume-unchanged files in lower case.
    const flagged = (yield* run(repo, [
      "ls-files",
      "-v",
      "-z",
      "--",
      ...(paths ?? []),
    ]))
      .split("\0")
      .filter(Boolean)
      .flatMap((line) => {
        const tag = line.slice(0, 1);
        const sparse = tag === "S" || tag === "s";

        return sparse || tag !== tag.toUpperCase()
          ? [{ path: line.slice(2), sparse }]
          : [];
      });

    if (!flagged.length) {
      return [];
    }

    const baseOids = new Map(
      (yield* run(repo, [
        "ls-tree",
        "-z",
        base,
        "--",
        ...flagged.map((f) => f.path),
      ]))
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");

          return [line.slice(tab + 1), line.slice(0, tab).split(" ")[2]];
        })
    );

    const changed = yield* Effect.filter(
      flagged,
      ({ path, sparse }) =>
        // hash-object hashes the file as `git add` would store it; it exits 128 when the file is missing.
        run(repo, ["hash-object", "--", path], [0, 128]).pipe(
          Effect.map((out) => {
            const oid = out.trim();

            return oid ? oid !== baseOids.get(path) : !sparse;
          })
        ),
      { concurrency: 8 }
    );

    return changed.map((f) => f.path);
  });

  /** Tracked and untracked paths that differ from `base` in the working tree. */
  const changedNames = Effect.fn("Git.changedNames")(function* changedNames(
    repo: string,
    base: string,
    paths?: readonly string[]
  ) {
    const [tracked, extra, hidden] = yield* Effect.all(
      [
        run(repo, [
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          base,
          "--",
          ...(paths ?? []),
        ]),
        untracked(repo, paths),
        unwatched(repo, base, paths),
      ],
      { concurrency: 3 }
    );

    return [
      ...new Set([...tracked.split("\0").filter(Boolean), ...extra, ...hidden]),
    ].toSorted();
  });

  const diffNames = (repo: string, a: string, b: string) =>
    a === b
      ? Effect.succeed([])
      : run(repo, ["diff", "--name-only", "-z", "--no-renames", a, b]).pipe(
          Effect.map((out) => out.split("\0").filter(Boolean))
        );

  const gh = (repo: string, args: string[]) =>
    exec("gh", args, { cwd: repo, timeout: 30_000 }).pipe(
      Effect.map((output) => output.toString("utf-8")),
      Effect.mapError(
        (cause) =>
          new ReviewError({
            message:
              cause.code === "NotFound"
                ? "gh CLI not found; PR targets need GitHub CLI."
                : `gh ${args[0]} failed: ${cause.message}`,
          })
      )
    );

  /** A PR's metadata from GitHub, and whether each end is fetched. */
  const pr = Effect.fn("Git.pr")(function* pr(repo: string, id: string) {
    const response = yield* gh(repo, [
      "pr",
      "view",
      id,
      "--json",
      "number,title,url,headRefOid,baseRefOid,baseRefName,headRefName",
    ]);

    const meta = yield* decodePr(response).pipe(
      Effect.mapError(
        () => new ReviewError({ message: "Invalid GitHub CLI response." })
      )
    );

    const [headFetched, baseFetched] = yield* Effect.all(
      [hasCommit(repo, meta.headRefOid), hasCommit(repo, meta.baseRefOid)],
      { concurrency: 2 }
    );

    return { ...meta, baseFetched, headFetched };
  });

  return {
    blob,
    changedNames,
    defaultBranch,
    diffNames,
    hasCommit,
    /** HEAD, or the empty tree in a repository with no commits yet. */
    head: (repo: string) => commitOrEmpty(repo, "HEAD"),
    isIgnored,
    mergeBase,
    parentOf,
    pr,
    revParse,
    root,
    run,
    untracked,
  };
});

export class Git extends Context.Service<Git, Effect.Success<typeof make>>()(
  "directorate/Git"
) {
  static readonly layer = Layer.effect(Git, make);
}
