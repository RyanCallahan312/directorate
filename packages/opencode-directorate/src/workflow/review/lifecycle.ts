// Directorate review lifecycle: create a seal from a target, refresh it into its next generation when the code moves, and
// re-check a reported review as a new seal. Capture itself is seal/'s; this orchestrates it with the ledger.
import { DateTime, Effect, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

import { scopeOf } from "../../exclusions.ts";
import { Actor } from "../../feature/agents/agent.ts";
import { unansweredQuestions } from "../../feature/dispatch/lifecycle.ts";
import { reopen, unresolved } from "../../feature/ledger/decide.ts";
import {
  CarriedStatusSchema,
  isUnverifiedCarry,
  Ledger,
  nthEntryId,
} from "../../feature/ledger/entry.ts";
import type { CarriedStatus, Entry } from "../../feature/ledger/entry.ts";
import { driftCleared } from "../../feature/report/directive.ts";
import {
  Git,
  Host,
  IO_CONCURRENCY,
  ProcessIdentity,
} from "../../platform/platform.ts";
import { emptyLedger } from "../../records/records.ts";
import { carryMarks, coverageSummary } from "../../seal/coverage.ts";
import { Seal } from "../../seal/record.ts";
import { isBaseSide, isSealedSide, Region } from "../../seal/region.ts";
import type { Changes } from "../../seal/region.ts";
import { SealIdSchema } from "../../seal/seal-id.ts";
import type { SealId } from "../../seal/seal-id.ts";
import {
  capture,
  changedBetween,
  currentFingerprint,
  depsOf,
  inDependencyDir,
  openReview,
  readable,
  repinned,
  resolveEnds,
  Sessions,
  settled,
  ShipLink,
} from "../../seal/seal.ts";
import { Target } from "../../seal/target.ts";
import { started } from "./custody.ts";
import {
  DEFAULT_BUDGET,
  ModeSchema,
  PANEL_BUDGET_FACTOR,
  recheckMinutes,
} from "./request.ts";
import { shipped } from "./ship-link.ts";
import type { ShipId } from "./ship-link.ts";
import { Window } from "./window.ts";

/** What the review's state does not allow: a second active seal, re-checking an open review, resuming a reported one. */
export class ReviewConflict extends Schema.TaggedError<
  ReviewConflict,
  { readonly brand: unique symbol }
>()("ReviewConflict", { message: Schema.String }) {}

/** The target's current ends cannot be told or are not fetched, so the review cannot be refreshed or re-checked. */
class TargetUnresolved extends Schema.TaggedError<
  TargetUnresolved,
  { readonly brand: unique symbol }
>()("TargetUnresolved", { message: Schema.String }) {}

/** A new seal's id: its creation time, and a random suffix. */
export const sealId = Effect.fnUntraced(function* sealId(
  createdAt: DateTime.Utc
) {
  const suffix = Hex.encode(
    yield* (yield* SecureRandom.SecureRandom).randomBytes(3)
  );

  return SealIdSchema.make(
    `directorate-${DateTime.formatIso(createdAt)
      .replaceAll(/[-:TZ.]/gu, "")
      .slice(0, 14)}-${suffix}`
  );
});

/** The sealing OpenCode instance's directory, if sealed inside one. */
const hostDirectory = Effect.serviceOption(Host).pipe(
  Effect.map((h) => Option.getOrUndefined(h)?.location.directory)
);

/** What a new review is asked to seal: the repository and target, its mode, and what the request set. */
const SealRequestSchema = Schema.Struct({
  budgetMinutes: Schema.optional(Schema.Finite),
  lensesOff: Schema.optional(Schema.Array(Schema.String)),
  mode: ModeSchema,
  owner: Schema.optionalKey(Actor),
  panel: Schema.optional(Schema.Array(Schema.String)),
  question: Schema.optional(Schema.String),
  repo: Schema.String,
  target: Schema.toEncoded(Target),
});

/** `beforeCapture` runs before each capture attempt. */
export const createSeal = Effect.fn("Directorate.createSeal")(
  function* createSeal(
    input: typeof SealRequestSchema.Type,
    beforeCapture?: () => Effect.Effect<void>
  ) {
    const top = yield* (yield* Git).root(input.repo);
    const host = yield* hostDirectory;
    const { pid } = yield* ProcessIdentity;
    const createdAt = yield* DateTime.now;
    const id = yield* sealId(createdAt);
    const panel = input.panel?.length ? [...new Set(input.panel)] : undefined;

    const window = Window.open(
      createdAt,
      input.budgetMinutes ??
        DEFAULT_BUDGET[input.mode] * (panel ? PANEL_BUDGET_FACTOR : 1)
    );

    // Each attempt re-resolves the ends, then captures; files changing mid-capture retry the whole attempt.
    return yield* openReview(
      id,
      Effect.gen(function* attempt() {
        const ends = yield* resolveEnds(top, Target.make(input.target));

        const seal = yield* capture(
          Seal.open(
            {
              baseSha: ends.baseSha,
              baseTip: ends.baseTip,
              description: ends.description,
              headSha: ends.headSha,
              id,
              lensesOff: input.lensesOff,
              mode: input.mode,
              panel,
              postImage: ends.postImage,
              question: input.question,
              repo: top,
              target: ends.target,
            },
            window,
            started(input.owner, host, pid)
          ),
          ends.scope,
          beforeCapture
        );

        return { ledger: emptyLedger, out: seal, seal };
      }).pipe(
        settled(
          "Files kept changing while sealing (3 attempts). Wait until edits stop, then seal again."
        )
      )
    );
  }
);

/** What `next` changed in the files an entry rests on, judged against `before`; undefined when nothing it rests on moved. */
const movedUnder = (before: Seal, next: Seal, changes: Changes) => {
  const changed = new Set(changes.files);

  const inChange = new Set(
    next.files.filter((f) => f.isChanged).map((f) => f.path)
  );

  return (e: Entry) => {
    const hit = [...depsOf(e)].filter((d) => changed.has(d));

    const gone =
      isSealedSide(e.anchor.side) &&
      before.files.some((f) => f.path === e.anchor.path && f.isChanged) &&
      !inChange.has(e.anchor.path);

    const baseMoved = isBaseSide(e.anchor.side) && changes.baseMoved;

    return hit.length || gone || baseMoved
      ? { files: hit.join(", ") || "base moved", gone, hit: hit.length > 0 }
      : undefined;
  };
};

/** What a refresh did: the files that changed, the regions left to read, the entries it reopened, and the next seal and ledger. */
const RefreshSchema = Schema.Struct({
  files: Schema.Array(Schema.String),
  ledger: Ledger,
  newRegions: Schema.Array(Region),
  reopened: Schema.Array(Schema.String),
  seal: Seal,
});

/**
 * Re-pins a moved target into the seal's next generation. Regions whose content did not change keep their read receipts
 * and dispositions; entries whose anchor or evidence changed reopen. Both are returned, for the door to save.
 */
export const refreshSeal = Effect.fn("Directorate.refreshSeal")(
  function* refreshSeal(
    seal: Seal,
    ledger: Ledger,
    beforeCapture?: () => Effect.Effect<void>
  ) {
    const unchanged = RefreshSchema.make({
      files: [],
      ledger,
      newRegions: [],
      reopened: [],
      seal,
    });

    const cur = yield* currentFingerprint(seal).pipe(
      Effect.mapError(
        (e) =>
          new TargetUnresolved({
            message: `Cannot check freshness: ${e.message}`,
          })
      )
    );

    if (cur.unfetched) {
      return yield* new TargetUnresolved({
        message: `${cur.unfetched}. Ask the user to fetch it, or call directorate_report to report the review as stale.`,
      });
    }

    if (cur.fingerprint === seal.fingerprint) {
      return unchanged;
    }

    const captured = yield* capture(
      driftCleared(
        repinned(seal, {
          baseSha: cur.baseSha,
          baseTip: cur.baseTip ?? seal.baseTip,
          description: cur.describing(seal),
          headSha: cur.headSha,
        })
      ),
      scopeOf(seal.target.paths),
      beforeCapture
    ).pipe(
      settled(
        "Files kept changing during refresh (3 attempts). Wait until edits stop, then call directorate_refresh again."
      )
    );

    if (captured.fingerprint === seal.fingerprint) {
      return unchanged;
    }

    const changes = yield* changedBetween(seal, captured);
    const next = carryMarks(captured, seal);
    const moved = movedUnder(seal, captured, changes);

    const entries = ledger.entries.map((e) => {
      const why = moved(e);

      if (!why || (e.isRefuted && !why.hit)) {
        return { entry: e, reopened: false };
      }

      return {
        entry: reopen(
          e,
          why.gone
            ? `${e.anchor.path} is no longer part of the change; re-verify or refute`
            : `code changed after the seal (${why.files}); re-verify and re-anchor`
        ),
        reopened: true,
      };
    });

    return RefreshSchema.make({
      files: changes.listed,
      ledger: ledger.withEntries(entries.map((r) => r.entry)),
      newRegions: coverageSummary(next).unread,
      reopened: entries.flatMap((r) => (r.reopened ? [r.entry.id] : [])),
      seal: next,
    });
  }
);

/** Only a reported review can be re-checked; an unreported one is resumed. */
export const recheckable = (prior: Seal) =>
  prior.reportedAt
    ? Effect.void
    : Effect.fail(
        new ReviewConflict({
          message: `${prior.id} has not been reported. Resume it with resume: "${prior.id}" instead of re-checking it.`,
        })
      );

/** What a re-check is asked to start from: the reported seal and its ledger, and what the request set. */
const RecheckRequestSchema = Schema.Struct({
  budgetMinutes: Schema.optional(Schema.Finite),
  ledger: Ledger,
  owner: Schema.optionalKey(Actor),
  prior: Seal,
  question: Schema.optional(Schema.String),
});

/**
 * A new review of a reported seal's target as it stands now, while the reported Directive is left as it was. The base is
 * kept, so committing fixes is not a new change. Regions read in the earlier review whose content did not change keep
 * their receipts; skimmed and skipped ones are read again. Its verified findings and unverified leads carry over as new
 * entries: open again where the code they rest on changed (or always, for leads), still confirmed where it did not. A
 * re-check runs without a panel: it is a targeted pass, not a second independent review.
 */
export const recheckSeal = Effect.fn("Directorate.recheckSeal")(
  function* recheckSeal(
    input: typeof RecheckRequestSchema.Type,
    beforeCapture?: () => Effect.Effect<void>
  ) {
    const { prior } = input;
    yield* recheckable(prior);
    const host = yield* hostDirectory;
    const { pid } = yield* ProcessIdentity;
    const createdAt = yield* DateTime.now;
    const id = yield* sealId(createdAt);

    const window = Window.open(
      createdAt,
      input.budgetMinutes ?? recheckMinutes(prior.mode)
    );

    return yield* openReview(
      id,
      Effect.gen(function* attempt() {
        // A worktree seal keeps its base (committed fixes are not a new change) but records the HEAD it now sits on;
        // only commit pairs re-resolve both ends.
        const pinned = prior.pinsCommit
          ? yield* currentFingerprint(prior).pipe(
              Effect.mapError(
                (e) =>
                  new TargetUnresolved({
                    message: `Cannot re-resolve ${prior.id}'s target: ${e.message}`,
                  })
              ),
              Effect.filterOrElse(
                (c) => !c.unfetched,
                (c) =>
                  Effect.fail(
                    new TargetUnresolved({
                      message: `${c.unfetched}. Ask the user to fetch it, then re-check again.`,
                    })
                  )
              )
            )
          : undefined;

        const headSha =
          pinned?.headSha ?? (yield* (yield* Git).head(prior.repo));

        const captured = yield* capture(
          Seal.open(
            {
              baseSha: pinned?.baseSha ?? prior.baseSha,
              baseTip: pinned?.baseTip ?? prior.baseTip,
              description: pinned?.describing(prior) ?? prior.description,
              headSha,
              id,
              lensesOff: prior.lensesOff,
              mode: prior.mode,
              postImage: prior.postImage,
              question: input.question ?? prior.question,
              recheckOf: prior.id,
              repo: prior.repo,
              target: prior.target,
            },
            window,
            started(input.owner, host, pid)
          ),
          scopeOf(prior.target.paths),
          beforeCapture
        );

        const changes = yield* changedBetween(prior, captured);

        const seal = carryMarks(captured, prior, (r) => r.isRead);

        const moved = movedUnder(prior, captured, changes);
        const open = new Set(unresolved(input.ledger));

        // Installed dependencies are read live from disk, outside any seal, so Git cannot say whether they changed:
        // a confirmed finding that cites one is re-decided. One that is gone now counts as changed.
        const live = new Set(
          yield* Effect.filter(
            new Set(
              input.ledger.entries
                .filter((e) => e.isConfirmed)
                .flatMap((e) => [...depsOf(e)].filter(inDependencyDir))
            ),
            (d) =>
              readable(seal, d).pipe(
                Effect.map((r) => r.live),
                Effect.orElseSucceed(() => true)
              ),
            { concurrency: IO_CONCURRENCY }
          )
        );

        // What the earlier review left behind: verified findings, and entries filed but never cleared.
        const carriedStatus = (e: Entry) => {
          if (e.isConfirmed) {
            return CarriedStatusSchema.make("confirmed");
          }

          return open.has(e)
            ? CarriedStatusSchema.make("unverified")
            : undefined;
        };

        /** Why a carried entry is decided again, or undefined for a confirmed one nothing it rests on moved under. */
        const reopenReason = (e: Entry, status: CarriedStatus) => {
          const why = moved(e);
          const onDisk = [...depsOf(e)].filter((d) => live.has(d));

          if (isUnverifiedCarry(status)) {
            return `unverified in ${prior.id}; decide it on the current code`;
          }

          if (why?.gone) {
            return `${e.anchor.path} is no longer part of the change since ${prior.id}; decide whether it is resolved`;
          }

          if (why) {
            return `code it rests on changed since ${prior.id} (${why.files}); decide whether it is still present (re-anchor) or resolved`;
          }

          return onDisk.length
            ? `it rests on installed dependencies read from disk (${onDisk.join(", ")}), which may have changed since ${prior.id}; decide whether it is still present (re-anchor) or resolved`
            : undefined;
        };

        const carried = input.ledger.entries
          .flatMap((e) => {
            const status = carriedStatus(e);

            return status ? [{ entry: e, status }] : [];
          })
          .map(({ entry, status }, i) => {
            const next = entry.carriedAs(nthEntryId(i + 1), status);
            const reason = reopenReason(entry, status);

            return reason === undefined
              ? { entry: next, kept: true }
              : { entry: reopen(next, reason), kept: false };
          });

        const ledger = Ledger.make({
          entries: carried.map((c) => c.entry),
          notes: [],
        });

        return {
          ledger,
          out: {
            files: changes.listed,
            kept: carried.flatMap((c) => (c.kept ? [c.entry.id] : [])),
            ledger,
            reopened: carried.flatMap((c) => (c.kept ? [] : [c.entry.id])),
            seal,
            // Explicit notes, and Auditor questions the earlier review left without an answer.
            unanswered: [
              ...new Set([
                ...input.ledger.notes
                  .filter((n) => n.isUnanswered)
                  .map((n) => n.text),
                ...unansweredQuestions(prior, input.ledger),
              ]),
            ],
          },
          seal,
        };
      }).pipe(
        settled(
          "Files kept changing while sealing (3 attempts). Wait until edits stop, then seal again."
        )
      )
    );
  }
);

/**
 * Stamps a review with the ship that owns it, through the door as the ship link: review's write, at the point the ship
 * hands over its id. The ship never writes the seal.
 */
export const shipStamp = Effect.gen(function* shipStamp() {
  const sessions = yield* Sessions;

  return (sealID: SealId, shipID: ShipId) =>
    sessions.mutate(sealID, ShipLink.make({}), (review) =>
      Effect.succeed({ out: undefined, seal: shipped(review.seal, shipID) })
    );
});
