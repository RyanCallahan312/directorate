// The watchdog: past the deadline and its grace period it reports for the Liaison; before it, it settles runs missed
// across a reload and wakes a standalone review whose Liaison stalled.
import { SessionMessage } from "@opencode/schema/session-message";
import { Clock, DateTime, Effect, Option, Schedule } from "effect";

import { Liaison } from "../../feature/agents/agent.ts";
import { settleChildren } from "../../feature/dispatch/dispatch.ts";
import { ignore, orWarn, recover } from "../../platform/error.ts";
import {
  activity,
  foreign,
  Git,
  Host,
  idleAt,
  isOrphaned,
  isSucceeded,
  isSynthetic,
  locationKey,
  ProcessIdentity,
} from "../../platform/platform.ts";
import { Records } from "../../records/records.ts";
import type { Seal } from "../../seal/record.ts";
import type { SealId } from "../../seal/seal-id.ts";
import { RecoveryWake, Sessions } from "../../seal/seal.ts";
import { halted, Recovery, waking, woken } from "./custody.ts";
import { interruptedReview } from "./interrupted.ts";
import type { AutoReporter } from "./tools.ts";
import { GRACE_MS } from "./window.ts";

/** Tells the caller of a review the watchdog woke that its Liaison filed the Directive, if the caller is still here. */
export const notifyRecoveredReview = Effect.fnUntraced(
  function* notifyRecoveredReview(seal: Seal, md: string) {
    const host = yield* Host;

    if (!seal.ownerSession) {
      return;
    }

    const { parentID } = yield* host.session.get({
      sessionID: seal.ownerSession,
    });

    if (!parentID) {
      return;
    }

    const parent = yield* host.session.get({ sessionID: parentID });

    if (
      locationKey(parent.location) === locationKey(host.location) &&
      !parent.time.archived &&
      !parent.revert
    ) {
      yield* host.session.synthetic({
        resume: false,
        sessionID: parentID,
        text: `The Directorate finished the recovered review ${seal.id}:\n\n${md}`,
      });
    }
  },
  recover("could not deliver the recovered Directive")
);

/**
 * The deadline sweep, every 30 seconds after the first 30. `loadedAt` is when this plugin instance loaded: only reviews
 * sealed before it are recovered. Each sweep runs `recoverShips` first, so stalled ships recover too.
 */
export const watchdog = Effect.fnUntraced(function* watchdog(
  loadedAt: number,
  autoReport: AutoReporter,
  recoverShips: Effect.Effect<void>
) {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const store = yield* Records;
  const { pid } = yield* ProcessIdentity;

  // Outside a repository there is none to match; any other git failure leaves the watchdog running without one.
  const myRepo = yield* (yield* Git)
    .rootOption(host.location.directory)
    .pipe(
      Effect.map(Option.getOrUndefined),
      orWarn(
        `cannot find the repository of ${host.location.directory}; the watchdog recovers only this instance's reviews`
      )
    );

  // ---------- the budget ----------
  // Past the deadline and its grace period, the watchdog reports for the Liaison. One scoped sweep at a time; reload
  // interrupts both the sweep and the event consumer.
  /** Seals a sweep found reported, never read again: a reported seal never reopens. */
  const reported = new Set<SealId>();

  /**
   * Seals a sweep found another instance's, by the modifiedAt it saw them at: one unchanged since, and not bound here, is
   * not read again. A takeover writes the seal, so it is read again once its host, repository, or owner changes.
   */
  const othersAt = new Map<SealId, number>();

  /** Margin for filesystem mtime granularity: a seal written this close to a sweep's start is read again next sweep. */
  const MTIME_SLACK_MS = 2000;

  /**
   * A standalone review whose Liaison ended a turn without reporting before this instance loaded: wake it once. A review
   * the user stopped, or one a ship owns, is not this sweep's to continue.
   */
  const recoverable = (seal: Seal) =>
    Liaison.is(seal.owner) &&
    !seal.reportedAt &&
    !seal.halted &&
    seal.ship === undefined &&
    DateTime.toEpochMillis(seal.createdAt) < loadedAt;

  const recoverReview = Effect.fn("Directorate.recoverReview")(
    function* recoverReview(seal: Seal) {
      const sealedAt = DateTime.toEpochMillis(seal.createdAt);

      if (!recoverable(seal)) {
        return;
      }

      /**
       * The Liaison's session, if it is here and stalled: left mid-turn by a restart, or idle after a turn of this
       * review that succeeded without reporting.
       */
      const stalledOwner = Effect.gen(function* stalledOwner() {
        const session = seal.ownerSession
          ? yield* sessions.info(seal.ownerSession)
          : undefined;

        if (
          !session ||
          locationKey(session.location) !== locationKey(host.location) ||
          !Liaison.is(session.agent) ||
          session.time.archived ||
          session.revert
        ) {
          return;
        }

        const act = yield* activity(host, session);

        const stalled =
          isOrphaned(act.state) ||
          Option.exists(
            idleAt(act),
            (at) => isSucceeded(act.session.outcome) && at >= sealedAt
          );

        return stalled ? session.id : undefined;
      });

      const sessionID = yield* stalledOwner;

      if (!sessionID || (yield* sessions.recordedSeal(sessionID)) !== seal.id) {
        return;
      }

      yield* sessions.mutate(seal.id, RecoveryWake.make({}), (review) =>
        Effect.gen(function* resumeOwner() {
          const current = review.seal;

          if (
            !recoverable(current) ||
            current.ownerSession !== sessionID ||
            (yield* foreign(current.pid)) ||
            (yield* stalledOwner) !== sessionID
          ) {
            return { out: undefined };
          }

          const messages = yield* host.session.context({ sessionID });

          if (interruptedReview(current, messages)) {
            return { out: undefined, seal: halted(current) };
          }

          const prior =
            current.recovery?.ownerSession === sessionID
              ? current.recovery
              : undefined;

          const delivered =
            prior &&
            messages.some(
              (message) => isSynthetic(message) && message.id === prior.id
            );

          // A still-queued wake does not need a duplicate, nor does one already handled by this instance.
          if (
            prior?.admitted &&
            (!delivered || prior.admittedMillis >= loadedAt)
          ) {
            return { out: undefined };
          }

          const retry = prior?.admitted ? undefined : prior;

          const recovery = Recovery.make({
            id: retry?.id ?? SessionMessage.ID.create(),
            ownerSession: sessionID,
          });

          // The intent is saved before the wake, and the wake's ID is reused until its admission is saved: the host
          // keeps the first admission of an ID, so neither a lost wake nor a lost acknowledgement repeats or drops it.
          if (!retry) {
            yield* review.checkpoint(waking(current, pid, recovery));
          }

          if (!delivered || !retry) {
            yield* host.session.synthetic({
              delivery: "queue",
              id: recovery.id,
              sessionID,
              text: `Continue the existing Directorate review ${seal.id} after OpenCode reloaded or restarted. Use its saved coverage, child runs and ledger, and finish with directorate_report. Do not start a new seal or extend the deadline.`,
            });
          }

          return {
            out: undefined,
            seal: woken(current, pid, recovery, yield* DateTime.now),
          };
        })
      );
    }
  );

  const sweep = Effect.gen(function* sweep() {
    yield* recoverShips.pipe(recover("ship recovery sweep failed"));

    const bound = yield* sessions.boundSeals;
    const now = yield* Clock.currentTimeMillis;
    const skip = new Set(reported);

    for (const [id, at] of othersAt) {
      if (!bound.has(id) && (yield* store.modifiedAt(id)) === at) {
        skip.add(id);
      } else {
        othersAt.delete(id);
      }
    }

    for (const seal of yield* store.listWithout(skip)) {
      if (seal.reportedAt) {
        reported.add(seal.id);
        continue;
      }

      // After a reload no session is bound yet: recover this instance's reviews, wherever their repository is, and any
      // review of this repository.
      if (
        !(
          bound.has(seal.id) ||
          seal.host === host.location.directory ||
          (myRepo !== undefined && seal.repo === myRepo)
        )
      ) {
        // Remembered only if written well before this sweep read it: a write since then shows a newer modifiedAt.
        const at = yield* store.modifiedAt(seal.id);

        if (at !== undefined && at + MTIME_SLACK_MS < now) {
          othersAt.set(seal.id, at);
        }

        continue;
      }

      if (now < DateTime.toEpochMillis(seal.deadline) + GRACE_MS) {
        // Another live server's review is not this one's to settle or wake.
        if (!(yield* foreign(seal.pid))) {
          yield* settleChildren(seal).pipe(
            Effect.andThen(recoverReview(seal)),
            ignore(`could not recover review ${seal.id}`, "Warn")
          );
        }

        continue;
      }

      yield* autoReport(
        seal.id,
        "the Liaison did not report before lockdown; filed automatically"
      ).pipe(
        ignore(`could not save the deadline report for ${seal.id}`, "Warn")
      );
    }
  });

  yield* sweep.pipe(
    recover("deadline sweep failed"),
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.delay("30 seconds"),
    Effect.forkScoped
  );
});
