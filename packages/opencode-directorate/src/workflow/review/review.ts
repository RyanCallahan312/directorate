// The review lifecycle: opening, timing, holding, refreshing, and closing a review. The slice's entry.
// shortcut: only what index.ts and ship.ts already need from this slice; Phase 2c gives it the rest.
export { interruptedReview } from "./interrupted.ts";

export {
  createSeal,
  recheckable,
  recheckSeal,
  refreshSeal,
} from "./lifecycle.ts";
