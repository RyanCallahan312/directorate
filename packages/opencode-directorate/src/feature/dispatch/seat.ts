// Directorate Seats: the models a panel review assigns, one per seat.
import { Schema } from "effect";

/** The seats of a panel review when the caller names no models, as "providerID/modelID#variant". */
export const DEFAULT_PANEL = [
  "openai/gpt-6.2-astra#xhigh",
  "claude-agent/claude-fable-5-2#high",
  "claude-agent/opus#high",
  "openai/gpt-6.2-sol#high",
  "github-copilot/gemini-4-neon#high",
];

/** A model as the subagent tool takes it; whether it is available is checked when the Directorate SeatSchema launches. */
export const ModelRef = Schema.String.check(
  Schema.makeFilter(
    (m: string) =>
      /^[^/\s#]+\/[^\s#]+(?<path>#[^\s#]+)?$/u.test(m) ||
      `Model ${m} must be "providerID/modelID" or "providerID/modelID#variant".`
  )
);

/** A Directorate Seat (panel seat): a chat model and its thinking level. */
export const SeatSchema = Schema.Struct({
  model: Schema.String.check(
    Schema.makeFilter(
      (m: string) =>
        /^[^/\s#]+\/[^\s#]+$/u.test(m) ||
        `Model ${m} must be "providerID/modelID"; put the thinking level in variant.`
    )
  ).annotate({ description: "providerID/modelID" }),
  variant: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Thinking level: one of the model's variant ids, such as high or xhigh.",
    })
  ),
});

export type Seat = typeof SeatSchema.Type;

export const seatRef = (s: Seat) =>
  s.variant ? `${s.model}#${s.variant}` : s.model;
