// What a review seals: the target kinds and the stored target.
import { Schema } from "effect";

const opt = Schema.optional;

export const TargetKindSchema = Schema.Literals([
  "auto",
  "local",
  "commit",
  "range",
  "pr",
  "paths",
]);

export type TargetKind = typeof TargetKindSchema.Type;

/** The kinds a target resolves to: auto picks one of the others. */
export const ResolvedKindSchema = TargetKindSchema.pick([
  "local",
  "commit",
  "range",
  "pr",
  "paths",
]);

/** What the review's post-image is: the working tree (snapshotted at sealing) or a commit. */
export const PostImageSchema = Schema.Literals(["worktree", "commit"]);

export type PostImage = typeof PostImageSchema.Type;

/** A post-image pinned at a commit, rather than the working tree snapshotted at sealing. */
export const isCommitImage = Schema.is(PostImageSchema.pick(["commit"]));

const isCommitKind = Schema.is(TargetKindSchema.pick(["commit"]));

const isPathsKind = Schema.is(TargetKindSchema.pick(["paths"]));

const isPrKind = Schema.is(TargetKindSchema.pick(["pr"]));

const isRangeKind = Schema.is(TargetKindSchema.pick(["range"]));

/** What a review seals, as stored. The directorate_seal tool input declares its own keys with optionalKey: Schema.optional renders as anyOf-null for the model. */
export class Target extends Schema.Class<
  Target,
  { readonly brand: unique symbol }
>("directorate/Target")({
  base: opt(Schema.String),
  commit: opt(Schema.String),
  head: opt(Schema.String),
  kind: TargetKindSchema,
  paths: opt(Schema.Array(Schema.String)),
  pr: opt(Schema.String),
}) {
  /** Whole files, every line of them, rather than a diff. */
  get wholeFiles() {
    return isPathsKind(this.kind);
  }

  /** One fixed commit, whose snapshot never moves. */
  get isCommit() {
    return isCommitKind(this.kind);
  }

  /** A pull request, whose ends GitHub names. */
  get isPullRequest() {
    return isPrKind(this.kind);
  }

  /** A range of refs, which re-resolve when they move. */
  get isRange() {
    return isRangeKind(this.kind);
  }
}
