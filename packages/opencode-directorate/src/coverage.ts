// Directorate coverage: which regions the Liaison and each reader have read, and the dispositions recorded for the rest.
import type { Seal } from "./seal/record.ts";
import type { Disposition, Region } from "./seal/region.ts";

const CHUNK_MAX_LINES = 600;

/** How a region was shown to a reader: complete, or where the next call continues. */
export interface Shown {
  id: string;
  complete: boolean;
  next: number;
  missing?: boolean;
}

const regionSize = (r: Region) =>
  r.patchStart === 0
    ? r.newEnd - r.newStart + 1
    : r.patchEnd - r.patchStart + 1;

/** Read by the lead, or reviewed by disposition: a region that counts as observed. */
export const isRead = (r: Region) =>
  (!r.disposition && Boolean(r.ownerRead)) || r.disposition === "reviewed";

export const coverageSummary = (seal: Seal) => {
  const total = seal.regions.length;
  const skipped = seal.regions.filter((r) => r.disposition === "skipped");
  const skimmed = seal.regions.filter((r) => r.disposition === "skimmed");

  const assessed = seal.regions.filter(
    (r) => r.disposition === "reviewed" && !r.ownerRead
  );

  const read = seal.regions.filter(isRead);
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
): Seal => {
  const byId = new Map(
    shown.flatMap((s) => (s.missing ? [] : [[s.id, s] as const]))
  );

  return {
    ...seal,
    regions: seal.regions.map((r) => {
      const s = byId.get(r.id);

      if (!s) {
        return r;
      }

      const offsets = { ...r.offsets, [reader.key]: s.next };

      if (!s.complete) {
        return { ...r, offsets };
      }

      return {
        ...r,
        offsets,
        ownerRead: reader.owner || r.ownerRead,
        readBy: r.readBy.includes(reader.key)
          ? r.readBy
          : [...r.readBy, reader.key],
      };
    }),
  };
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

    return { ...r, disposition: unread ? "skimmed" : disposition, note };
  });

  return { coerced, seal: { ...seal, regions } };
};
