// Directorate coverage: which regions the Liaison and each reader have read, and the dispositions recorded for the rest.
import { Schema } from "effect";

import { Count } from "../platform/stored.ts";
import type { Seal } from "./record.ts";
import type { Disposition, Region } from "./region.ts";

const CHUNK_MAX_LINES = 600;

/** How a region was shown to a reader: complete, or where the next call continues. */
export class Shown extends Schema.Class<
  Shown,
  { readonly brand: unique symbol }
>("directorate/Shown")({
  complete: Schema.Boolean,
  id: Schema.String,
  /** Its content was unavailable at the seal: it is not counted as read. */
  missing: Schema.optionalKey(Schema.Boolean),
  next: Count,
}) {}

const regionSize = (r: Region) =>
  r.patchStart === 0
    ? r.newEnd - r.newStart + 1
    : r.patchEnd - r.patchStart + 1;

export const coverageSummary = (seal: Seal) => {
  const total = seal.regions.length;
  const skipped = seal.regions.filter((r) => r.disposition === "skipped");
  const skimmed = seal.regions.filter((r) => r.disposition === "skimmed");

  const assessed = seal.regions.filter(
    (r) => r.disposition === "reviewed" && !r.ownerRead
  );

  const read = seal.regions.filter((r) => r.isRead);
  const unread = seal.regions.filter((r) => !r.disposition && !r.ownerRead);

  return {
    assessed: assessed.length,
    read: read.length,
    skimmed,
    skipped,
    total,
    unread,
  };
};

/**
 * The next chunk for a reader (its session, or "owner" for the lead): the requested regions, else what that reader has
 * not read, within CHUNK_MAX_LINES.
 */
export const nextRegions = (
  seal: Seal,
  opts: {
    ids?: readonly string[] | undefined;
    file?: string | undefined;
    reader: string;
    owner: boolean;
  }
) => {
  const { ids, file, owner, reader } = opts;
  const explicit = Boolean(ids?.length || file);

  const pool = seal.regions.filter((r) => {
    if (ids?.length) {
      return ids.includes(r.id);
    }

    if (file) {
      return r.file === file;
    }

    return owner ? !r.ownerRead && !r.disposition : !r.readBy.includes(reader);
  });

  const picked: Region[] = [];
  let size = 0;

  for (const r of pool) {
    if (picked.length && size + regionSize(r) > CHUNK_MAX_LINES) {
      break;
    }

    picked.push(r);
    size += regionSize(r);
  }

  return {
    omitted: explicit ? pool.slice(picked.length).map((r) => r.id) : [],
    picked,
  };
};

/** Records what a reader was shown: where it continues in each region, and which regions it read completely. */
export const markShown = (
  seal: Seal,
  shown: readonly Shown[],
  reader: { key: string; owner: boolean }
) => {
  const byId = new Map(
    shown.flatMap((s) => (s.missing ? [] : [[s.id, s] as const]))
  );

  return seal.withContainment({
    regions: seal.regions.map((r) => {
      const s = byId.get(r.id);

      return s ? r.shown(reader, s.next, s.complete) : r;
    }),
  });
};

/** Records a disposition for regions; "reviewed" needs someone to have read the region through directorate_diff, else it is skimmed. */
export const dispose = (
  seal: Seal,
  ids: readonly string[],
  disposition: Disposition,
  note: string
) => {
  const coerced: string[] = [];

  const regions = seal.regions.map((r) => {
    if (!ids.includes(r.id)) {
      return r;
    }

    const unread = disposition === "reviewed" && !r.readBy.length;

    if (unread) {
      coerced.push(r.id);
    }

    return r.disposed(unread ? "skimmed" : disposition, note);
  });

  return { coerced, seal: seal.withContainment({ regions }) };
};

/**
 * Regions just captured, carrying the receipts and dispositions of the `from` regions (those `keep` accepts) whose content
 * they repeat.
 */
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

  return onto.map((r) => {
    const p = matches.get(r);

    return p ? r.carrying(p) : r;
  });
};

/** A fresh capture of `seal`, carrying the coverage marks of `earlier`'s regions (those `keep` accepts) onto it. */
export const carryMarks = (
  seal: Seal,
  earlier: Seal,
  keep?: (r: Region) => boolean
) =>
  seal.withContainment({
    regions: carryRegions(earlier.regions, seal.regions, keep),
  });
