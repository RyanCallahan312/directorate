// Whether a review was interrupted, judged from the host's record of its turns: review policy over platform's readers.
import type { SessionMessage } from "@opencode/schema/session-message";
import { DateTime } from "effect";

import { createdAt, isInterrupted, turns } from "../../platform/platform.ts";
import type { Seal } from "../../seal/record.ts";

/** On resume, ignore old interruptions, not later ones. Older manually resumed seals lack the resume time. */
export const interruptedReview = (
  seal: Pick<Seal, "createdAt" | "halted" | "resumedAt">,
  messages: readonly SessionMessage.Info[]
) => {
  if (seal.halted || (!seal.resumedAt && seal.halted === false)) {
    return seal.halted === true;
  }

  const since = DateTime.toEpochMillis(seal.resumedAt ?? seal.createdAt);

  return turns(messages).some(
    (turn) =>
      isInterrupted(turn.outcome) &&
      (seal.resumedAt ? createdAt(turn) > since : createdAt(turn) >= since)
  );
};
