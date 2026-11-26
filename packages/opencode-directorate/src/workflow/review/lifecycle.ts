// Directorate review lifecycle: create a seal from a target, refresh it into its next generation when the code moves, and
// re-check a reported review as a new seal. Capture itself is seal/'s; this orchestrates it with the ledger.
import { DateTime, Effect, Option } from "effect";
import { SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

import { scopeOf } from "../../exclusions.ts";
import { Liaison } from "../../feature/agents/agent.ts";
import type { Actor } from "../../feature/agents/agent.ts";
import { unansweredQuestions } from "../../feature/dispatch/lifecycle.ts";
import { reopen, unresolved } from "../../feature/ledger/decide.ts";
import type { Entry, Ledger } from "../../feature/ledger/entry.ts";
import { failure, ReviewError } from "../../platform/error.ts";
import { Git, Host, ProcessIdentity } from "../../platform/platform.ts";
import { emptyLedger, Store } from "../../records/records.ts";
import { isRead } from "../../seal/coverage.ts";
import type { Seal } from "../../seal/record.ts";
import type { Region } from "../../seal/region.ts";
import {
  capture,
  changedBetween,
  currentFingerprint,
  depsOf,
  inDependencyDir,
  readable,
  resolveEnds,
  settled,
} from "../../seal/seal.ts";
import type { Current } from "../../seal/seal.ts";
import type { Target } from "../../seal/target.ts";
import type { Mode } from "./request.ts";
import { DEFAULT_BUDGET, PANEL_BUDGET_FACTOR, Window } from "./window.ts";

const IO_CONCURRENCY = 16;

/** A new seal's id: its creation time, and a random suffix. */
const sealId = Effect.fnUntraced(function* sealId(createdAt: DateTime.Utc) {
  const suffix = Hex.encode(
    yield* (yield* SecureRandom.SecureRandom).randomBytes(3)
  );

  return `directorate-${DateTime.formatIso(createdAt)
    .replaceAll(/[-:TZ.]/gu, "")
    .slice(0, 14)}-${suffix}`;
});

/** A commit pair's description with the ends it moved to; a worktree's description does not name them. */
const describedAt = (seal: Seal, cur: Pick<Current, "baseSha" | "headSha">) =>
  seal.postImage === "commit"
    ? seal.description.replace(
        /\((?<prefix>[^()]*?)[0-9a-f]{10} → [0-9a-f]{10}\)/u,
        `($1${cur.baseSha.slice(0, 10)} → ${cur.headSha.slice(0, 10)})`
      )
    : seal.description;

/** The sealing OpenCode instance's directory, if sealed inside one. */
const hostDirectory = Effect.serviceOption(Host).pipe(
  Effect.map((h) => Option.getOrUndefined(h)?.location.directory)
);

export const createSeal = Effect.fn("Directorate.createSeal")(
  function* createSeal(input: {
    repo: string;
    mode: Mode;
    target: Target;
    owner?: Actor;
    budgetMinutes?: number | undefined;
    question?: string | undefined;
    panel?: readonly string[] | undefined;
    lensesOff?: readonly string[] | undefined;
    beforeCapture?: () => Effect.Effect<void>;
  }) {
    const store = yield* Store;
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
    return yield* store.create(
      id,
      Effect.gen(function* attempt() {
        const ends = yield* resolveEnds(top, input.target);

        const seal = yield* capture(
          {
            baseSha: ends.baseSha,
            baseTip: ends.baseTip,
            ...window.toStored(),
            children: [],
            deleted: [],
            description: ends.description,
            files: [],
            fingerprint: "",
            gates: {},
            gen: 0,
            headSha: ends.headSha,
            host,
            id,
            lensesOff: input.lensesOff,
            mode: input.mode,
            owner: input.owner?.agent ?? Liaison.id,
            ownerSession: input.owner?.session ?? "",
            panel,
            pid,
            postImage: ends.postImage,
            question: input.question,
            refreshes: 0,
            regions: [],
            repo: top,
            target: ends.target,
          },
          ends.scope,
          input.beforeCapture
        );

        yield* store.saveBoth(seal, emptyLedger);

        return seal;
      }).pipe(
        settled(
          "Files kept changing while sealing (3 attempts). Wait until edits stop, then seal again."
        )
      )
    );
  }
);

/** What `next` changed in the files an entry rests on, judged against `before`; undefined when nothing it rests on moved. */
const movedUnder = (before: Seal, next: Seal, changed: ReadonlySet<string>) => {
  const inChange = new Set(
    next.files.filter((f) => f.status !== "unchanged").map((f) => f.path)
  );

  return (e: Entry) => {
    const hit = [...depsOf(e)].filter((d) => changed.has(d));

    const gone =
      e.anchor.side === "new" &&
      before.files.some(
        (f) => f.path === e.anchor.path && f.status !== "unchanged"
      ) &&
      !inChange.has(e.anchor.path);

    const baseMoved = e.anchor.side === "old" && changed.has("(base moved)");

    return hit.length || gone || baseMoved
      ? { files: hit.join(", ") || "base moved", gone, hit: hit.length > 0 }
      : undefined;
  };
};

/** Captured regions, with the receipts and dispositions of the `from` regions (those `keep` accepts) whose content they repeat. */
const carryRegions = (
  from: readonly Region[],
  onto: readonly Region[],
  keep: (r: Region) => boolean = () => true
) => {
  const byKey = Map.groupBy(from, (r) => r.key);
  const matches = new Map<Region, Region>();

  for (const [key, regions] of Map.groupBy(onto, (r) => r.key)) {
    const previous = key ? byKey.get(key) : undefined;

    // Identical chunks have the same key. Pair occurrences in order, including unread ones;
    // if their counts changed, none can be matched unambiguously.
    if (previous?.length === regions.length) {
      for (const [i, r] of regions.entries()) {
        const p = previous[i];

        if (p && keep(p)) {
          matches.set(r, p);
        }
      }
    }
  }

  return onto.map((r): Region => {
    const p = matches.get(r);

    return p
      ? {
          ...r,
          disposition: p.disposition,
          note: p.note,
          ownerRead: p.ownerRead,
          readBy: p.readBy,
        }
      : r;
  });
};

interface RefreshResult {
  files: string[];
  ledger: Ledger;
  newRegions: Region[];
  reopened: string[];
  seal: Seal;
}

/**
 * Re-pins a moved target into the seal's next generation. Regions whose content did not change keep their read receipts
 * and dispositions; entries whose anchor or evidence changed reopen. Both are saved, and returned.
 */
export const refreshSeal = Effect.fn("Directorate.refreshSeal")(
  function* refreshSeal(
    seal: Seal,
    ledger: Ledger,
    beforeCapture?: () => Effect.Effect<void>
  ) {
    const unchanged: RefreshResult = {
      files: [],
      ledger,
      newRegions: [],
      reopened: [],
      seal,
    };

    const cur = yield* currentFingerprint(seal).pipe(
      Effect.mapError(
        (e) =>
          new ReviewError({ message: `Cannot check freshness: ${e.message}` })
      )
    );

    if (cur.unfetched) {
      return yield* failure(
        `${cur.unfetched}. Ask the user to fetch it, or call directorate_report to report the review as stale.`
      );
    }

    if (cur.fingerprint === seal.fingerprint) {
      return unchanged;
    }

    const captured = yield* capture(
      {
        ...seal,
        baseSha: cur.baseSha,
        baseTip: cur.baseTip ?? seal.baseTip,
        description: describedAt(seal, cur),
        gates: {},
        gen: seal.gen + 1,
        headSha: cur.headSha,
        refreshes: seal.refreshes + 1,
        staleFiles: undefined,
      },
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

    const changed = new Set(yield* changedBetween(seal, captured));
    const regions = carryRegions(seal.regions, captured.regions);
    const moved = movedUnder(seal, captured, changed);
    const reopened: string[] = [];

    const entries = ledger.entries.map((e) => {
      const why = moved(e);

      if (!why || (e.status === "refuted" && !why.hit)) {
        return e;
      }

      reopened.push(e.id);

      return reopen(
        e,
        why.gone
          ? `${e.anchor.path} is no longer part of the change; re-verify or refute`
          : `code changed after the seal (${why.files}); re-verify and re-anchor`
      );
    });

    const next = { ...captured, regions };
    const nextLedger = { ...ledger, entries };
    yield* (yield* Store).saveBoth(next, nextLedger);

    return {
      files: [...changed],
      ledger: nextLedger,
      newRegions: regions.filter((r) => !r.ownerRead && !r.disposition),
      reopened,
      seal: next,
    };
  }
);

/** A re-check's budget when the caller names none: half its mode's default, at least RECHECK_MIN_MINUTES. */
const RECHECK_MIN_MINUTES = 10;

/** Only a reported review can be re-checked; an unreported one is resumed. */
export const recheckable = (prior: Seal) =>
  prior.reportedAt
    ? Effect.void
    : failure(
        `${prior.id} has not been reported. Resume it with resume: "${prior.id}" instead of re-checking it.`
      );

/**
 * A new review of a reported seal's target as it stands now, while the reported Directive is left as it was. The base is
 * kept, so committing fixes is not a new change. Regions read in the earlier review whose content did not change keep
 * their receipts; skimmed and skipped ones are read again. Its verified findings and unverified leads carry over as new
 * entries: open again where the code they rest on changed (or always, for leads), still confirmed where it did not. A
 * re-check runs without a panel: it is a targeted pass, not a second independent review.
 */
export const recheckSeal = Effect.fn("Directorate.recheckSeal")(
  function* recheckSeal(input: {
    prior: Seal;
    ledger: Ledger;
    owner?: Actor;
    budgetMinutes?: number | undefined;
    question?: string | undefined;
    beforeCapture?: () => Effect.Effect<void>;
  }) {
    const { prior } = input;
    yield* recheckable(prior);
    const store = yield* Store;
    const host = yield* hostDirectory;
    const { pid } = yield* ProcessIdentity;
    const createdAt = yield* DateTime.now;
    const id = yield* sealId(createdAt);

    const window = Window.open(
      createdAt,
      input.budgetMinutes ??
        Math.max(
          RECHECK_MIN_MINUTES,
          Math.round(DEFAULT_BUDGET[prior.mode] / 2)
        )
    );

    return yield* store.create(
      id,
      Effect.gen(function* attempt() {
        // A worktree seal keeps its base (committed fixes are not a new change) but records the HEAD it now sits on;
        // only commit pairs re-resolve both ends.
        const cur: Pick<Current, "baseSha" | "headSha" | "baseTip"> =
          prior.postImage === "worktree"
            ? {
                baseSha: prior.baseSha,
                headSha: yield* (yield* Git).head(prior.repo),
              }
            : yield* currentFingerprint(prior).pipe(
                Effect.mapError(
                  (e) =>
                    new ReviewError({
                      message: `Cannot re-resolve ${prior.id}'s target: ${e.message}`,
                    })
                ),
                Effect.filterOrElse(
                  (c) => !c.unfetched,
                  (c) =>
                    failure(
                      `${c.unfetched}. Ask the user to fetch it, then re-check again.`
                    )
                )
              );

        const captured = yield* capture(
          {
            baseSha: cur.baseSha,
            baseTip: cur.baseTip ?? prior.baseTip,
            ...window.toStored(),
            children: [],
            deleted: [],
            description: describedAt(prior, cur),
            files: [],
            fingerprint: "",
            gates: {},
            gen: 0,
            headSha: cur.headSha,
            host,
            id,
            lensesOff: prior.lensesOff,
            mode: prior.mode,
            owner: input.owner?.agent ?? Liaison.id,
            ownerSession: input.owner?.session ?? "",
            pid,
            postImage: prior.postImage,
            question: input.question ?? prior.question,
            recheckOf: prior.id,
            refreshes: 0,
            regions: [],
            repo: prior.repo,
            target: prior.target,
          },
          scopeOf(prior.target.paths),
          input.beforeCapture
        );

        const changed = new Set(yield* changedBetween(prior, captured));

        const seal: Seal = {
          ...captured,
          regions: carryRegions(prior.regions, captured.regions, isRead),
        };

        const moved = movedUnder(prior, captured, changed);
        const open = new Set(unresolved(input.ledger));
        const reopened: string[] = [];
        const kept: string[] = [];

        // Installed dependencies are read live from disk, outside any seal, so Git cannot say whether they changed:
        // a confirmed finding that cites one is re-decided. One that is gone now counts as changed.
        const live = new Set(
          yield* Effect.filter(
            new Set(
              input.ledger.entries
                .filter((e) => e.status === "confirmed")
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
        const entries = input.ledger.entries.flatMap((e): Entry[] => {
          let status: "confirmed" | "unverified" | undefined;

          if (e.status === "confirmed") {
            status = "confirmed";
          } else if (open.has(e)) {
            status = "unverified";
          }

          if (!status) {
            return [];
          }

          const carried: Entry = {
            ...e,
            carried: { id: e.id, status },
            id: `F${reopened.length + kept.length + 1}`,
          };

          const why = moved(e);
          const onDisk = [...depsOf(e)].filter((d) => live.has(d));

          if (status === "confirmed" && !why && !onDisk.length) {
            kept.push(carried.id);

            return [carried];
          }

          reopened.push(carried.id);

          let reason: string;

          if (status === "unverified") {
            reason = `unverified in ${prior.id}; decide it on the current code`;
          } else if (why?.gone) {
            reason = `${e.anchor.path} is no longer part of the change since ${prior.id}; decide whether it is resolved`;
          } else if (why) {
            reason = `code it rests on changed since ${prior.id} (${why.files}); decide whether it is still present (re-anchor) or resolved`;
          } else {
            reason = `it rests on installed dependencies read from disk (${onDisk.join(", ")}), which may have changed since ${prior.id}; decide whether it is still present (re-anchor) or resolved`;
          }

          return [reopen(carried, reason)];
        });

        const ledger: Ledger = { entries, notes: [] };
        yield* store.saveBoth(seal, ledger);

        return {
          files: [...changed],
          kept,
          ledger,
          reopened,
          seal,
          // Explicit notes, and Auditor questions the earlier review left without an answer.
          unanswered: [
            ...new Set([
              ...input.ledger.notes
                .filter((n) => n.kind === "unanswered")
                .map((n) => n.text),
              ...unansweredQuestions(prior, input.ledger),
            ]),
          ],
        };
      }).pipe(
        settled(
          "Files kept changing while sealing (3 attempts). Wait until edits stop, then seal again."
        )
      )
    );
  }
);
