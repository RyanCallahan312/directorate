// Directorate targets: what a review compares (a base and a post-image), resolved from the user's target and re-resolved later
// to tell whether the sealed code moved.
import { Effect } from "effect";

import { scopeOf } from "../exclusions.ts";
import { failure, ReviewError } from "../platform/error.ts";
import { sha256 } from "../platform/hash.ts";
import { Git, Worktree } from "../platform/platform.ts";
import type { Seal } from "./record.ts";
import type { Target, TargetKind } from "./target.ts";

export interface Ends {
  readonly kind: Exclude<TargetKind, "auto">;
  readonly description: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseTip?: string;
  readonly postImage: "worktree" | "commit";
  readonly scope?: readonly string[] | undefined;
  readonly target: Target;
}

const localEnds = Effect.fnUntraced(function* localEnds(
  repo: string,
  target: Target
) {
  const git = yield* Git;
  const head = yield* git.head(repo);

  return {
    baseSha: head,
    description: `local changes (staged, unstaged, untracked) vs HEAD ${head.slice(0, 10)}`,
    headSha: head,
    kind: "local",
    postImage: "worktree",
    scope: scopeOf(target.paths),
    target,
  } satisfies Ends;
});

const autoEnds = Effect.fnUntraced(function* autoEnds(repo: string) {
  const git = yield* Git;
  const head = yield* git.head(repo);
  const dirty = (yield* git.changedNames(repo, head)).length > 0;

  // Before the first commit, HEAD is the empty tree and nothing is ahead of anything.
  if (!(yield* git.hasCommit(repo, head))) {
    if (!dirty) {
      return yield* failure(
        "No local changes, and HEAD has no commits yet. Ask the user what to review."
      );
    }

    return yield* localEnds(repo, { kind: "local" });
  }

  // Without a known base, the branch's commits cannot be found: sealing local-only would silently drop them.
  const def = yield* git.defaultBranch(repo).pipe(
    Effect.mapError(
      (e) =>
        new ReviewError({
          message: `${e.message} Or use local scope to review only uncommitted changes.`,
        })
    )
  );

  const mb = yield* git.mergeBase(repo, def, head, { base: def, head: "HEAD" });

  const ahead =
    mb === head
      ? 0
      : Number(
          (yield* git.run(repo, [
            "rev-list",
            "--count",
            `${mb}..${head}`,
          ])).trim()
        );

  if (!dirty && !ahead) {
    return yield* failure(
      `No local changes, and HEAD has no commits beyond ${def}. Ask the user what to review.`
    );
  }

  if (ahead) {
    return {
      baseSha: mb,
      description: `branch ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${def}${dirty ? " plus local changes" : ""} (merge-base ${mb.slice(0, 10)} → working tree)`,
      headSha: head,
      kind: "local",
      postImage: "worktree",
      target: { kind: "local" },
    } satisfies Ends;
  }

  return yield* localEnds(repo, { kind: "local" });
});

const prMergeBase = (
  repo: string,
  m: {
    readonly baseRefName: string;
    readonly baseRefOid: string;
    readonly headRefName: string;
    readonly headRefOid: string;
  }
) =>
  Git.use((git) =>
    git.mergeBase(repo, m.baseRefOid, m.headRefOid, {
      base: m.baseRefName,
      head: m.headRefName,
    })
  );

const rejectsPaths = (target: Target) =>
  target.paths?.length && target.kind !== "local" && target.kind !== "paths";

export const resolveEnds = Effect.fn("Directorate.resolveEnds")(
  function* resolveTarget(
    repo: string,
    target: Target
  ): Effect.fn.Return<Ends, ReviewError, Git> {
    const git = yield* Git;

    if (rejectsPaths(target)) {
      return yield* failure(
        `The ${target.kind} target does not support paths. Use local for scoped working-tree changes or paths for whole files.`
      );
    }

    switch (target.kind) {
      case "auto": {
        return yield* autoEnds(repo);
      }

      case "local": {
        return yield* localEnds(repo, target);
      }

      case "paths": {
        const head = yield* git.head(repo);
        const scope = scopeOf(target.paths);

        return {
          baseSha: head,
          description: `files under ${(scope ?? ["the whole repository"]).join(", ")} at HEAD ${head.slice(0, 10)} plus working-tree edits`,
          headSha: head,
          kind: "paths",
          postImage: "worktree",
          scope,
          target,
        };
      }

      case "commit": {
        const c = yield* git.revParse(
          repo,
          target.commit || target.head || "HEAD"
        );

        const parent = yield* git.parentOf(repo, c);

        return {
          baseSha: parent,
          description: `commit ${c.slice(0, 10)}`,
          headSha: c,
          kind: "commit",
          postImage: "commit",
          target: { ...target, commit: c },
        };
      }

      case "range": {
        if (!target.base) {
          return yield* failure(
            "range target needs base (and optional head, default HEAD); base may be @default"
          );
        }

        const base =
          target.base === "@default"
            ? yield* git.defaultBranch(repo)
            : target.base;

        const h = yield* git.revParse(repo, target.head || "HEAD");
        const b = yield* git.revParse(repo, base);

        const mb = yield* git.mergeBase(repo, b, h, {
          base,
          head: target.head || "HEAD",
        });

        return {
          baseSha: mb,
          description: `${base}...${target.head || "HEAD"} (merge-base ${mb.slice(0, 10)} → ${h.slice(0, 10)})`,
          headSha: h,
          kind: "range",
          postImage: "commit",
          target: { ...target, base },
        };
      }

      case "pr": {
        if (!target.pr) {
          return yield* failure("pr target needs pr (number or URL)");
        }

        const m = yield* git.pr(repo, target.pr);

        if (!m.headFetched) {
          return yield* failure(
            `Head commit ${m.headRefOid} of PR #${m.number} is not in the local repo. Ask the user to run \`git fetch origin pull/${m.number}/head\`, then seal again.`
          );
        }

        if (!m.baseFetched) {
          return yield* failure(
            `Base commit ${m.baseRefOid} of PR #${m.number} is not in the local repo. Ask the user to run \`git fetch origin ${m.baseRefName}\`, then seal again.`
          );
        }

        const mb = yield* prMergeBase(repo, m);

        return {
          baseSha: mb,
          baseTip: m.baseRefOid,
          description: `PR #${m.number} "${m.title}" ${m.baseRefName}...${m.headRefName} (${mb.slice(0, 10)} → ${m.headRefOid.slice(0, 10)}) ${m.url}`,
          headSha: m.headRefOid,
          kind: "pr",
          postImage: "commit",
          target,
        };
      }

      default: {
        return yield* failure(
          `Unsupported review target: ${String(target.kind)}`
        );
      }
    }
  }
);

const commitPrint = (base: string, head: string) =>
  sha256(`commit:${base}:${head}`);

/** The fingerprint of a pair of ends: the worktree's signatures, or the commit pair. */
export const endsFingerprint = (
  repo: string,
  e: Pick<Ends, "postImage" | "baseSha" | "headSha" | "scope">
) =>
  e.postImage === "worktree"
    ? Worktree.use((wt) => wt.fingerprint(repo, e.baseSha, e.scope))
    : commitPrint(e.baseSha, e.headSha);

export interface Current {
  readonly fingerprint: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseTip?: string;
  readonly unfetched?: string;
}

/** Current ends for a sealed target (re-resolving moving refs) and its fingerprint. */
const currentEnds = Effect.fn("Directorate.currentEnds")(function* currentEnds(
  seal: Seal
) {
  const t = seal.target;

  if (seal.postImage === "worktree") {
    return {
      baseSha: seal.baseSha,
      fingerprint: yield* endsFingerprint(seal.repo, {
        ...seal,
        scope: scopeOf(t.paths),
      }),
      headSha: seal.headSha,
    } satisfies Current;
  }

  if (t.kind === "pr" && t.pr) {
    const m = yield* (yield* Git).pr(seal.repo, t.pr);

    if (!m.headFetched) {
      return {
        baseSha: seal.baseSha,
        baseTip: m.baseRefOid,
        fingerprint: yield* commitPrint("?", m.headRefOid),
        headSha: m.headRefOid,
        unfetched: `PR head moved to ${m.headRefOid.slice(0, 10)} (not fetched)`,
      } satisfies Current;
    }

    // An unfetched base still verifies when neither end moved since sealing.
    const unmoved =
      m.headRefOid === seal.headSha && m.baseRefOid === seal.baseTip;

    if (!m.baseFetched && !unmoved) {
      return yield* failure(
        `the PR base moved to ${m.baseRefOid.slice(0, 10)}, which is not fetched (git fetch origin ${m.baseRefName})`
      );
    }

    const baseSha = m.baseFetched
      ? yield* prMergeBase(seal.repo, m)
      : seal.baseSha;

    return {
      baseSha,
      baseTip: m.baseRefOid,
      fingerprint: yield* commitPrint(baseSha, m.headRefOid),
      headSha: m.headRefOid,
    } satisfies Current;
  }

  // A commit is fixed; a range re-resolves its refs.
  const e = t.kind === "range" ? yield* resolveEnds(seal.repo, t) : seal;

  return {
    baseSha: e.baseSha,
    fingerprint: yield* commitPrint(e.baseSha, e.headSha),
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
