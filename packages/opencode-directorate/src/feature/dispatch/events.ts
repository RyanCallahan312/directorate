// Dispatch's host-event side: what OpenCode's session records say about the runs a review dispatched.
import type { SessionMessage } from "@opencode/schema/session-message";
import { DateTime } from "effect";

import { createdAt } from "../../platform/platform.ts";
import type { Seal } from "../../seal/record.ts";
import { followUpPrompt, update } from "./lifecycle.ts";

/** A promoted follow-up belongs to the first terminal marker after that exact input. */
export const recoverFollowUps = (
  seal: Seal,
  session: string,
  messages: readonly SessionMessage.Info[]
) =>
  update(seal, (child) => {
    if (
      child.session !== session ||
      !child.followUp ||
      (child.status !== "running" && child.status !== "launching")
    ) {
      return child;
    }

    const { inbox } = child.followUp;

    const input = messages.findIndex(
      (message) =>
        message.type === "user" &&
        (inbox
          ? message.id === inbox
          : message.text === followUpPrompt(child) &&
            createdAt(message) >= DateTime.toEpochMillis(child.startedAt))
    );

    const delivered = messages[input];

    if (!delivered) {
      return child;
    }

    const turn = messages
      .slice(input + 1)
      .find((message) => message.type === "idle");

    if (!turn && child.followUp.delivered) {
      return child;
    }

    const result = {
      ...child,
      followUp: { delivered: true, inbox: delivered.id },
    };

    return turn
      ? {
          ...result,
          endedAt: turn.time.created,
          status: turn.outcome === "succeeded" ? "completed" : "failed",
        }
      : { ...result, status: "running" };
  });
