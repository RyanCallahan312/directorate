// Directorate git and GitHub CLI access. Plugins get no process service from OpenCode, and ctx.vcs is bound to the plugin's own
// location: it cannot diff a pinned commit pair, detect renames, or read blobs, grep, log, or blame, and it empties
// patches past its size budget. Every call goes through the bounded command adapter.
import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { command } from "./command.ts";
import { failure, ReviewError } from "./error.ts";

const GIT_ENV = (extra: Record<string, string> = {}) => ({
  GIT_OPTIONAL_LOCKS: "0",
  GIT_EXTERNAL_DIFF: "",
  GIT_PAGER: "cat",
  GIT_CONFIG_PARAMETERS: "",
  ...extra,
});
const decodePr = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      url: Schema.String,
      headRefOid: Schema.String,
      baseRefOid: Schema.String,
      baseRefName: Schema.String,
      headRefName: Schema.String,
    })
  )
);

const make = Effect.gen(function* () {
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
  const run = Effect.fn("Git.run")(function* (
    repo: string,
    args: readonly string[],
    ok: readonly number[] = [0],
    env: Record<string, string> = {}
  ) {
    const output = yield* exec(
      "git",
      ["-c", "core.quotepath=off", "-C", repo, ...args],
      { env: GIT_ENV(env), timeout: 120_000 }
    ).pipe(
      Effect.catch((error) =>
        error.stdout !== undefined &&
        typeof error.code === "number" &&
        ok.includes(error.code)
          ? Effect.succeed(error.stdout)
          : failure(`git ${args[0]} failed: ${error.message}`)
      )
    );
    return output.toString("utf8");
  });
  /** A file's bytes at a revision, or undefined when the revision has no such file (git exits 128). Anything else fails. */
  const blob = (repo: string, rev: string, path: string) =>
    exec("git", ["-C", repo, "cat-file", "blob", `${rev}:${path}`], {
      env: GIT_ENV(),
      timeout: 120_000,
    }).pipe(
      Effect.catch((error) =>
        error.code === 128
          ? Effect.undefined
          : failure(
              `Cannot read ${path} at ${rev.slice(0, 10)}: ${error.message}`
            )
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
    check(repo, ["check-ignore", "-q", "--", p]);
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
  const commitOrEmpty = Effect.fnUntraced(function* (
    repo: string,
    rev: string
  ) {
    return (
      (yield* run(repo, ["rev-parse", "--verify", "-q", rev], [0, 1])).trim() ||
      (yield* emptyTree(repo))
    );
  });
  const revParse = Effect.fn("Git.revParse")(function* (
    repo: string,
    ref: string
  ) {
    const out = (yield* run(
      repo,
      ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`],
      [0, 1]
    )).trim();
    if (!out)
      return yield* failure(
        `Cannot resolve ${ref} to a commit. Ask the user to fetch it (for example \`git fetch origin ${ref}\`), then seal again.`
      );
    return out;
  });
  const defaultBranch = Effect.fn("Git.defaultBranch")(function* (
    repo: string
  ) {
    const sym = (yield* run(
      repo,
      ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
      [0, 1]
    )).trim();
    if (sym) return sym;
    for (const b of ["origin/main", "origin/master", "main", "master"])
      if (
        (yield* run(
          repo,
          ["rev-parse", "--verify", "-q", `${b}^{commit}`],
          [0, 1]
        )).trim()
      )
        return b;
    return yield* failure(
      "Cannot find the default branch (no origin/HEAD, main, or master). Ask the user which base to review against."
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
  /** Tracked and untracked paths that differ from `base` in the working tree. */
  const changedNames = Effect.fn("Git.changedNames")(function* (
    repo: string,
    base: string,
    paths?: readonly string[]
  ) {
    const [tracked, extra] = yield* Effect.all(
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
      ],
      { concurrency: 2 }
    );
    return [
      ...new Set([...tracked.split("\0").filter(Boolean), ...extra]),
    ].sort();
  });
  const diffNames = (repo: string, a: string, b: string) =>
    a === b
      ? Effect.succeed([])
      : run(repo, ["diff", "--name-only", "-z", "--no-renames", a, b]).pipe(
          Effect.map((out) => out.split("\0").filter(Boolean))
        );

  const gh = (repo: string, args: string[]) =>
    exec("gh", args, { cwd: repo, timeout: 30_000 }).pipe(
      Effect.map((output) => output.toString("utf8")),
      Effect.mapError(
        (error) =>
          new ReviewError({
            message:
              error.code === "NotFound"
                ? "gh CLI not found; PR targets need GitHub CLI."
                : `gh ${args[0]} failed: ${error.message}`,
          })
      )
    );
  /** A PR's metadata from GitHub, with its merge base when both ends are fetched. */
  const pr = Effect.fn("Git.pr")(function* (repo: string, id: string) {
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
    const headFetched = yield* hasCommit(repo, meta.headRefOid);
    let mb: string | undefined;
    if (headFetched && (yield* hasCommit(repo, meta.baseRefOid)))
      mb =
        (yield* run(
          repo,
          ["merge-base", meta.baseRefOid, meta.headRefOid],
          [0, 1]
        )).trim() || meta.baseRefOid;
    return { ...meta, mb, headFetched };
  });

  return {
    run,
    blob,
    hasCommit,
    isIgnored,
    root,
    revParse,
    defaultBranch,
    untracked,
    changedNames,
    diffNames,
    pr,
    /** HEAD, or the empty tree in a repository with no commits yet. */
    head: (repo: string) => commitOrEmpty(repo, "HEAD"),
    /** The commit's parent, or the empty tree for a root commit. */
    parentOf: (repo: string, commit: string) =>
      commitOrEmpty(repo, `${commit}^`),
  };
});

export class Git extends Context.Service<Git, Effect.Success<typeof make>>()(
  "directorate/Git"
) {
  static readonly layer = Layer.effect(Git, make);
}
