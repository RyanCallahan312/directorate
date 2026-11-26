// Directorate Seats: the models a panel review assigns, one per seat.
import { Schema } from "effect";

/** A model as the subagent tool takes it; whether it is available is checked when the Directorate Seat launches. */
export const ModelRef = Schema.String.check(
  Schema.makeFilter(
    (m: string) =>
      /^[^/\s#]+\/[^\s#]+(?<path>#[^\s#]+)?$/u.test(m) ||
      `Model ${m} must be "providerID/modelID" or "providerID/modelID#variant".`
  )
);

/**
 * A seat as directorate.json, the directorate_configure tool, and the settings RPC carry it: a plain struct, since a class
 * would change the JSON Schema the model sees and the values the RPC hands the settings dialogs.
 */
export const SeatSpecSchema = Schema.Struct({
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

export type SeatSpec = typeof SeatSpecSchema.Type;

/** A seat as the subagent tool names it: "providerID/modelID", with "#variant" when it sets a thinking level. */
export const seatRef = (s: SeatSpec) =>
  s.variant ? `${s.model}#${s.variant}` : s.model;

/** A Directorate Seat (panel seat): a chat model and its thinking level. */
export class Seat extends Schema.Class<Seat, { readonly brand: unique symbol }>(
  "directorate/Seat"
)(SeatSpecSchema) {
  get ref() {
    return seatRef(this);
  }
}

/** The seats of a panel review when the caller names no models. */
export const DEFAULT_SEATS = [
  Seat.make({ model: "openai/gpt-6.2-astra", variant: "xhigh" }),
  Seat.make({ model: "claude-agent/claude-fable-5-2", variant: "high" }),
  Seat.make({ model: "claude-agent/opus", variant: "high" }),
  Seat.make({ model: "openai/gpt-6.2-sol", variant: "high" }),
  Seat.make({ model: "github-copilot/gemini-4-neon", variant: "high" }),
];

/** The default seats as "providerID/modelID#variant". */
export const DEFAULT_PANEL = DEFAULT_SEATS.map((s) => s.ref);
