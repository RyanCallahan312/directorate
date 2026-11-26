// Directorate targets: what a review compares (a base and a post-image), resolved from the user's target and re-resolved later
// to tell whether the sealed code moved.
import { Effect, Match, Schema } from "effect";

import { scopeOf } from "../exclusions.ts";
import { Git, sha256, Worktree } from "../platform/platform.ts";
import type { Seal } from "./record.ts";
import {
  PostImageSchema,
  ResolvedKindSchema,
  Target,
  TargetKindSchema,
} from "./target.ts";

/** A review target that cannot be resolved to two ends to compare. */
class InvalidTarget extends Schema.TaggedError<
  InvalidTarget,
  { readonly brand: unique symbol }
>()("InvalidTarget", { message: Schema.String }) {}

/** Whether the sealed target moved could not be told. */
export class FreshnessUnchecked extends Schema.TaggedError<
  FreshnessUnchecked,
  { readonly brand: unique symbol }
>()("FreshnessUnchecked", { message: Schema.String }) {}

const opt = Schema.optional;

/** A target resolved to the two ends a review compares, and how it describes them. */
class Ends extends Schema.Class<Ends, { readonly brand: unique symbol }>(
  "directorate/Ends"
)({
  baseSha: Schema.String,
  baseTip: opt(Schema.String),
  description: Schema.String,
  headSha: Schema.String,
  kind: ResolvedKindSchema,
  postImage: PostImageSchema,
  scope: opt(Schema.Array(Schema.String)),
  target: Target,
}) {}

const localEnds = Effect.fnUntraced(function* localEnds(
  repo: string,
  target: Target
) {
  const git = yield* Git;
  const head = yield* git.head(repo);

  return Ends.make({
    baseSha: head,
    description: `local changes (staged, unstaged, untracked) vs HEAD ${head.slice(0, 10)}`,
    headSha: head,
    kind: "local",
    postImage: "worktree",
    scope: scopeOf(target.paths),
    target,
  });
});

const autoEnds = Effect.fnUntraced(function* autoEnds(repo: string) {
  const git = yield* Git;
  const head = yield* git.head(repo);
  const dirty = (yield* git.changedNames(repo, head)).length > 0;

  // Before the first commit, HEAD is the empty tree and nothing is ahead of anything.
  if (!(yield* git.hasCommit(repo, head))) {
    if (!dirty) {
      return yield* new InvalidTarget({
        message:
          "No local changes, and HEAD has no commits yet. Ask the user what to review.",
      });
    }

    return yield* localEnds(repo, Target.make({ kind: "local" }));
  }

  // Without a known base, the branch's commits cannot be found: sealing local-only would silently drop them.
  const def = yield* git.defaultBranch(repo).pipe(
    Effect.mapError(
      (e) =>
        new InvalidTarget({
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
    return yield* new InvalidTarget({
      message: `No local changes, and HEAD has no commits beyond ${def}. Ask the user what to review.`,
    });
  }

  if (ahead) {
    return Ends.make({
      baseSha: mb,
      description: `branch ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${def}${dirty ? " plus local changes" : ""} (merge-base ${mb.slice(0, 10)} → working tree)`,
      headSha: head,
      kind: "local",
      postImage: "worktree",
      target: Target.make({ kind: "local" }),
    });
  }

  return yield* localEnds(repo, Target.make({ kind: "local" }));
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

/** The target kinds that take paths: a scoped working tree, or whole files. */
const takesPaths = Schema.is(TargetKindSchema.pick(["local", "paths"]));

const rejectsPaths = (target: Target) =>
  target.paths?.length && !takesPaths(target.kind);

const pathsEnds = Effect.fnUntraced(function* pathsEnds(
  repo: string,
  target: Target
) {
  const head = yield* (yield* Git).head(repo);
  const scope = scopeOf(target.paths);

  return Ends.make({
    baseSha: head,
    description: `files under ${(scope ?? ["the whole repository"]).join(", ")} at HEAD ${head.slice(0, 10)} plus working-tree edits`,
    headSha: head,
    kind: "paths",
    postImage: "worktree",
    scope,
    target,
  });
});

const commitEnds = Effect.fnUntraced(function* commitEnds(
  repo: string,
  target: Target
) {
  const git = yield* Git;
  const c = yield* git.revParse(repo, target.commit || target.head || "HEAD");
  const parent = yield* git.parentOf(repo, c);

  return Ends.make({
    baseSha: parent,
    description: `commit ${c.slice(0, 10)}`,
    headSha: c,
    kind: "commit",
    postImage: "commit",
    target: Target.make({ ...target, commit: c }),
  });
});

const rangeEnds = Effect.fnUntraced(function* rangeEnds(
  repo: string,
  target: Target
) {
  if (!target.base) {
    return yield* new InvalidTarget({
      message:
        "range target needs base (and optional head, default HEAD); base may be @default",
    });
  }

  const git = yield* Git;

  const base =
    target.base === "@default" ? yield* git.defaultBranch(repo) : target.base;

  const h = yield* git.revParse(repo, target.head || "HEAD");
  const b = yield* git.revParse(repo, base);

  const mb = yield* git.mergeBase(repo, b, h, {
    base,
    head: target.head || "HEAD",
  });

  return Ends.make({
    baseSha: mb,
    description: `${base}...${target.head || "HEAD"} (merge-base ${mb.slice(0, 10)} → ${h.slice(0, 10)})`,
    headSha: h,
    kind: "range",
    postImage: "commit",
    target: Target.make({ ...target, base }),
  });
});

const prEnds = Effect.fnUntraced(function* prEnds(
  repo: string,
  target: Target
) {
  if (!target.pr) {
    return yield* new InvalidTarget({
      message: "pr target needs pr (number or URL)",
    });
  }

  const m = yield* (yield* Git).pr(repo, target.pr);

  if (!m.headFetched) {
    return yield* new InvalidTarget({
      message: `Head commit ${m.headRefOid} of PR #${m.number} is not in the local repo. Ask the user to run \`git fetch origin pull/${m.number}/head\`, then seal again.`,
    });
  }

  if (!m.baseFetched) {
    return yield* new InvalidTarget({
      message: `Base commit ${m.baseRefOid} of PR #${m.number} is not in the local repo. Ask the user to run \`git fetch origin ${m.baseRefName}\`, then seal again.`,
    });
  }

  const mb = yield* prMergeBase(repo, m);

  return Ends.make({
    baseSha: mb,
    baseTip: m.baseRefOid,
    description: `PR #${m.number} "${m.title}" ${m.baseRefName}...${m.headRefName} (${mb.slice(0, 10)} → ${m.headRefOid.slice(0, 10)}) ${m.url}`,
    headSha: m.headRefOid,
    kind: "pr",
    postImage: "commit",
    target,
  });
});

export const resolveEnds = Effect.fn("Directorate.resolveEnds")(
  function* resolveTarget(repo: string, target: Target) {
    if (rejectsPaths(target)) {
      return yield* new InvalidTarget({
        message: `The ${target.kind} target does not support paths. Use local for scoped working-tree changes or paths for whole files.`,
      });
    }

    return yield* Match.value(target.kind).pipe(
      Match.when("auto", () => autoEnds(repo)),
      Match.when("local", () => localEnds(repo, target)),
      Match.when("paths", () => pathsEnds(repo, target)),
      Match.when("commit", () => commitEnds(repo, target)),
      Match.when("range", () => rangeEnds(repo, target)),
      Match.when("pr", () => prEnds(repo, target)),
      Match.exhaustive
    );
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

/** A sealed target's ends as they are now, and their fingerprint; `unfetched` when the PR head moved out of reach. */
export class Current extends Schema.Class<
  Current,
  { readonly brand: unique symbol }
>("directorate/Current")({
  baseSha: Schema.String,
  baseTip: opt(Schema.String),
  fingerprint: Schema.String,
  headSha: Schema.String,
  unfetched: opt(Schema.String),
}) {}

/** Current ends for a sealed target (re-resolving moving refs) and its fingerprint. */
const currentEnds = Effect.fn("Directorate.currentEnds")(function* currentEnds(
  seal: Seal
) {
  const t = seal.target;

  if (seal.postImage === "worktree") {
    return Current.make({
      baseSha: seal.baseSha,
      fingerprint: yield* endsFingerprint(seal.repo, {
        baseSha: seal.baseSha,
        headSha: seal.headSha,
        postImage: seal.postImage,
        scope: scopeOf(t.paths),
      }),
      headSha: seal.headSha,
    });
  }

  if (t.kind === "pr" && t.pr) {
    const m = yield* (yield* Git).pr(seal.repo, t.pr);

    if (!m.headFetched) {
      return Current.make({
        baseSha: seal.baseSha,
        baseTip: m.baseRefOid,
        fingerprint: yield* commitPrint("?", m.headRefOid),
        headSha: m.headRefOid,
        unfetched: `PR head moved to ${m.headRefOid.slice(0, 10)} (not fetched)`,
      });
    }

    // An unfetched base still verifies when neither end moved since sealing.
    const unmoved =
      m.headRefOid === seal.headSha && m.baseRefOid === seal.baseTip;

    if (!m.baseFetched && !unmoved) {
      return yield* new FreshnessUnchecked({
        message: `the PR base moved to ${m.baseRefOid.slice(0, 10)}, which is not fetched (git fetch origin ${m.baseRefName})`,
      });
    }

    const baseSha = m.baseFetched
      ? yield* prMergeBase(seal.repo, m)
      : seal.baseSha;

    return Current.make({
      baseSha,
      baseTip: m.baseRefOid,
      fingerprint: yield* commitPrint(baseSha, m.headRefOid),
      headSha: m.headRefOid,
    });
  }

  // A commit is fixed; a range re-resolves its refs.
  const e = t.kind === "range" ? yield* resolveEnds(seal.repo, t) : seal;

  return Current.make({
    baseSha: e.baseSha,
    fingerprint: yield* commitPrint(e.baseSha, e.headSha),
    headSha: e.headSha,
  });
});

/** The sealed target's current ends, bounded in time. */
export const currentFingerprint = (seal: Seal, timeoutMs = 20_000) =>
  Effect.timeoutOrElse(currentEnds(seal), {
    duration: timeoutMs,
    orElse: () =>
      Effect.fail(
        new FreshnessUnchecked({
          message: `freshness check timed out after ${timeoutMs / 1000}s`,
        })
      ),
  });
