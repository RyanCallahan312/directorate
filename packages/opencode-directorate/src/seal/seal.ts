// Containment: the Review aggregate root, what is under review, frozen, and who has read which part of it. The slice's
// entry: Sessions and the door, the read tools, capture and the drift check, sealed content, and repository paths.
export {
  capture,
  changedBetween,
  changedSinceSeal,
  settled,
} from "./capture.ts";

export {
  checkEvidence,
  checkQuote,
  depsOf,
  inDependencyDir,
  readable,
} from "./content.ts";

export { currentFingerprint, FreshnessUnchecked, resolveEnds } from "./ends.ts";

export type { Current } from "./ends.ts";

export { LineRef, RepoPath, RepoScope } from "./repo-path.ts";

export {
  done,
  locked,
  mutate,
  sealLayer,
  Sessions,
  unlocked,
  writable,
} from "./sessions.ts";

export { readTools } from "./tools.ts";
