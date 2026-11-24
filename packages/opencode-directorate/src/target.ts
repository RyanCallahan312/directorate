// Directorate targets: what a review compares (a base and a post-image), resolved from the user's target and re-resolved later
// to tell whether the sealed code moved.
import { Effect } from "effect";

import { failure, type ReviewError } from "./error.ts";
import { scopeOf } from "./exclusions.ts";
import { Git } from "./git.ts";
import { sha256 } from "./hash.ts";
import type { Seal, Target, TargetKind } from "./model.ts";
import { Worktree } from "./worktree.ts";

export type Ends = {
  readonly kind: Exclude<TargetKind, "auto">;
  readonly description: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseTip?: string;
  readonly postImage: "worktree" | "commit";
  readonly scope?: readonly string[];
  readonly target: Target;
};

export const resolveEnds = Effect.fn("Directorate.resolveEnds")(function* (
  repo: string,
  target: Target
): Effect.fn.Return<Ends, ReviewError, Git> {
  const git = yield* Git;
  if (
    target.paths?.length &&
    target.kind !== "local" &&
    target.kind !== "paths"
  )
    return yield* failure(
      `The ${target.kind} target does not support paths. Use local for scoped working-tree changes or paths for whole files.`
    );
  switch (target.kind) {
    case "auto": {
      const head = yield* git.head(repo);
      const def = yield* git
        .defaultBranch(repo)
        .pipe(Effect.orElseSucceed(() => undefined));
      // Before the first commit, HEAD is the empty tree and nothing is ahead of anything.
      const mb =
        def && (yield* git.hasCommit(repo, head))
          ? (yield* git.run(repo, ["merge-base", def, head], [0, 1])).trim() ||
            undefined
          : undefined;
      const ahead =
        mb && mb !== head
          ? Number(
              (yield* git.run(repo, [
                "rev-list",
                "--count",
                `${mb}..${head}`,
              ])).trim()
            )
          : 0;
      const dirty = (yield* git.changedNames(repo, head)).length > 0;
      if (!dirty && !ahead)
        return yield* failure(
          `No local changes, and HEAD has no commits beyond ${def ?? "the default branch"}. Ask the user what to review.`
        );
      if (ahead)
        return {
          kind: "local",
          target: { kind: "local" },
          description: `branch ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${def}${dirty ? " plus local changes" : ""} (merge-base ${mb!.slice(0, 10)} → working tree)`,
          baseSha: mb!,
          headSha: head,
          postImage: "worktree",
        };
      return yield* resolveEnds(repo, { kind: "local" });
    }
    case "local": {
      const head = yield* git.head(repo);
      return {
        kind: "local",
        target,
        description: `local changes (staged, unstaged, untracked) vs HEAD ${head.slice(0, 10)}`,
        baseSha: head,
        headSha: head,
        postImage: "worktree",
        scope: scopeOf(target.paths),
      };
    }
    case "paths": {
      const head = yield* git.head(repo);
      const scope = scopeOf(target.paths);
      return {
        kind: "paths",
        target,
        description: `files under ${(scope ?? ["the whole repository"]).join(", ")} at HEAD ${head.slice(0, 10)} plus working-tree edits`,
        baseSha: head,
        headSha: head,
        postImage: "worktree",
        scope,
      };
    }
    case "commit": {
      const c = yield* git.revParse(
        repo,
        target.commit || target.head || "HEAD"
      );
      const parent = yield* git.parentOf(repo, c);
      return {
        kind: "commit",
        target: { ...target, commit: c },
        description: `commit ${c.slice(0, 10)}`,
        baseSha: parent,
        headSha: c,
        postImage: "commit",
      };
    }
    case "range": {
      if (!target.base)
        return yield* failure(
          "range target needs base (and optional head, default HEAD); base may be @default"
        );
      const base =
        target.base === "@default"
          ? yield* git.defaultBranch(repo)
          : target.base;
      const h = yield* git.revParse(repo, target.head || "HEAD");
      const b = yield* git.revParse(repo, base);
      const mb =
        (yield* git.run(repo, ["merge-base", b, h], [0, 1])).trim() || b;
      return {
        kind: "range",
        target: { ...target, base },
        description: `${base}...${target.head || "HEAD"} (merge-base ${mb.slice(0, 10)} → ${h.slice(0, 10)})`,
        baseSha: mb,
        headSha: h,
        postImage: "commit",
      };
    }
    case "pr": {
      if (!target.pr)
        return yield* failure("pr target needs pr (number or URL)");
      const m = yield* git.pr(repo, target.pr);
      if (!m.headFetched)
        return yield* failure(
          `Head commit ${m.headRefOid} of PR #${m.number} is not in the local repo. Ask the user to run \`git fetch origin pull/${m.number}/head\`, then seal again.`
        );
      if (!m.mb)
        return yield* failure(
          `Base commit ${m.baseRefOid} of PR #${m.number} is not in the local repo. Ask the user to run \`git fetch origin ${m.baseRefName}\`, then seal again.`
        );
      return {
        kind: "pr",
        target,
        description: `PR #${m.number} "${m.title}" ${m.baseRefName}...${m.headRefName} (${m.mb.slice(0, 10)} → ${m.headRefOid.slice(0, 10)}) ${m.url}`,
        baseSha: m.mb,
        headSha: m.headRefOid,
        baseTip: m.baseRefOid,
        postImage: "commit",
      };
    }
  }
});

const commitPrint = (base: string, head: string) =>
  sha256(`commit:${base}:${head}`);
/** The fingerprint of a pair of ends: the worktree's signatures, or the commit pair. */
export const endsFingerprint = (
  repo: string,
  e: Pick<Ends, "postImage" | "baseSha" | "headSha" | "scope">
) =>
  e.postImage === "worktree"
    ? Effect.flatMap(Worktree, (wt) => wt.fingerprint(repo, e.baseSha, e.scope))
    : commitPrint(e.baseSha, e.headSha);

export type Current = {
  readonly fingerprint: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseTip?: string;
  readonly unfetched?: string;
};
/** Current ends for a sealed target (re-resolving moving refs) and its fingerprint. */
const currentEnds = Effect.fn("Directorate.currentEnds")(function* (
  seal: Seal
) {
  const t = seal.target;
  if (seal.postImage === "worktree")
    return {
      fingerprint: yield* endsFingerprint(seal.repo, {
        ...seal,
        scope: scopeOf(t.paths),
      }),
      baseSha: seal.baseSha,
      headSha: seal.headSha,
    } satisfies Current;
  if (t.kind === "pr" && t.pr) {
    const m = yield* (yield* Git).pr(seal.repo, t.pr);
    if (!m.headFetched)
      return {
        fingerprint: yield* commitPrint("?", m.headRefOid),
        baseSha: seal.baseSha,
        headSha: m.headRefOid,
        baseTip: m.baseRefOid,
        unfetched: `PR head moved to ${m.headRefOid.slice(0, 10)} (not fetched)`,
      } satisfies Current;
    const baseSha =
      m.mb ??
      (m.headRefOid === seal.headSha && m.baseRefOid === seal.baseTip
        ? seal.baseSha
        : undefined);
    if (!baseSha)
      return yield* failure(
        `the PR base moved to ${m.baseRefOid.slice(0, 10)}, which is not fetched (git fetch origin ${m.baseRefName})`
      );
    return {
      fingerprint: yield* commitPrint(baseSha, m.headRefOid),
      baseSha,
      headSha: m.headRefOid,
      baseTip: m.baseRefOid,
    } satisfies Current;
  }
  // A commit is fixed; a range re-resolves its refs.
  const e = t.kind === "range" ? yield* resolveEnds(seal.repo, t) : seal;
  return {
    fingerprint: yield* commitPrint(e.baseSha, e.headSha),
    baseSha: e.baseSha,
    headSha: e.headSha,
  } satisfies Current;
});

/** The sealed target's current ends, bounded in time. */
export const currentFingerprint = (seal: Seal, timeoutMs = 20_000) =>
  Effect.timeoutOrElse(currentEnds(seal), {
    duration: timeoutMs,
    orElse: () =>
      failure(`freshness check timed out after ${timeoutMs / 1000}s`),
  });
