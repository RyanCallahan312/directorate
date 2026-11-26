// Directorate review requests: what /directorate-review and /directorate-ship send the session to start a review, built
// from the user's words and a leading --scope flag.
import { Effect, Result, Schema } from "effect";

import type { TargetKind } from "../../seal/target.ts";

export const ModeSchema = Schema.Literals(["default", "code-quality", "full"]);

export type Mode = typeof ModeSchema.Type;

/** The mode of a review when neither the request nor directorate.json names one. */
export const DEFAULT_MODE = "default" satisfies Mode;

export const ReviewScopeSchema = Schema.Literals([
  "branch",
  "local",
  "repository",
]);

export type ReviewScope = typeof ReviewScopeSchema.Type;

export const DEFAULT_REVIEW_SCOPE: ReviewScope = "branch";

export const REVIEW_SCOPE_TARGET = {
  branch: "auto",
  local: "local",
  repository: "paths",
} as const satisfies Record<ReviewScope, TargetKind>;

const SCOPE_FLAG = /^\s*--scope(?=\s|=|$)(?:(?:=|\s+)(?<value>\S+))?/u;

/** A review request the command or tool cannot act on, with how to ask instead. */
export class InvalidRequest extends Schema.TaggedError<
  InvalidRequest,
  { readonly brand: unique symbol }
>()("InvalidRequest", { message: Schema.String }) {}

/** A review request: the user's words without the flag, and the scope the flag selected. */
export interface ReviewRequest {
  readonly body: string;
  readonly scope?: ReviewScope | undefined;
}

/** The request in a command's text, or why its --scope flag is unusable. */
export const parseRequest = (
  text: string
): Result.Result<ReviewRequest, string> => {
  const flag = SCOPE_FLAG.exec(text);

  if (!flag) {
    return Result.succeed({ body: text });
  }

  const scope = flag.groups?.value;

  return Schema.is(ReviewScopeSchema)(scope)
    ? Result.succeed({ body: text.slice(flag[0].length).trim(), scope })
    : Result.fail("Use --scope branch, --scope local, or --scope repository.");
};

/**
 * What the session is told to start the review. `bare` is what a request with no words and no scope does: `ask` offers
 * the mode and panel first (/directorate-review); `defaults` starts with the configured defaults (/directorate-ship,
 * whose loop must not stop for questions).
 */
export const requestText = (
  request: ReviewRequest,
  bare: "ask" | "defaults"
) => {
  const { body, scope } = request;
  const hasBody = body.trim().length > 0;
  const hasRequest = Boolean(scope) || hasBody;

  let start =
    "Start a Directorate code review with the configured defaults. Do not ask about mode or panel.";

  if (hasRequest) {
    start = `Start a Directorate code review${hasBody ? " using the <user_request> above" : ""}. Interpret it as natural language and carry through the requested target, scope, mode, model preferences, time limit, and any focus or constraints. Use configured defaults for details the user didn't specify. Ask only if a missing or conflicting detail prevents you from honoring the request. Do not silently drop a constraint or widen the target.`;
  } else if (bare === "ask") {
    start =
      "Start a Directorate code review. Before dispatching, use the question tool to offer the mode (configured default, default, code-quality, or full) and panel preference (configured default, single model, or Directorate Seats). If the user cancels, do not start a review.";
  }

  return [
    hasBody ? `<user_request>\n${body}\n</user_request>` : "",
    start,
    "Dispatch directorate_liaison with the user's request and any clarified options. Leave configured defaults unset rather than guessing them. Wait for the Liaison and relay its final Directive verbatim. Do not run the review yourself.",
    "Reviewing everything in named files or directories uses a whole-file target (kind: paths, with repository-relative paths), including unchanged files. A request for changes only is a diff review, not a whole-file review.",
    scope
      ? `The --scope flag selects ${scope}. Tell the Liaison to pass scope: "${scope}" to directorate_seal, without a target. If the request also names a conflicting target, ask which to use.`
      : "If no target or scope was requested, do not ask what to review: omit both target and scope so directorate_seal uses the configured default.",
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** The text that starts a review for a command's request; fails with the message the user sees on a bad flag. */
export const reviewRequest = (text: string, bare: "ask" | "defaults") =>
  Result.match(parseRequest(text), {
    onFailure: (message) => Effect.fail(new InvalidRequest({ message })),
    onSuccess: (request) => Effect.succeed(requestText(request, bare)),
  });
