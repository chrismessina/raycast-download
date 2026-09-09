/**
 * Download history, persisted to Raycast's LocalStorage.
 *
 * The storage backend is injectable so the logic is testable without a Raycast
 * host — and so a consumer with its own persistence can supply it. When omitted,
 * `@raycast/api`'s LocalStorage is loaded lazily (a bare `import` at module load
 * would make this module unusable outside Raycast, including from tests and the
 * detached runner).
 *
 * `meta` is the per-extension payload: Fetch stores nothing, iOS Apps stores its
 * AppDetails. Generic over it rather than union-typed, so no consumer has to
 * widen its type to accommodate another's.
 */

import type { DownloadErrorCode } from "./errors";

export interface DownloadRecord<M = unknown> {
  id: string;
  filename: string;
  outputPath: string;
  status: "completed" | "failed" | "cancelled";
  /**
   * Source URL, when it is safe to persist.
   *
   * Deliberately optional: signed URLs are bearer credentials and must NOT be
   * written here. Consumers of expiring-URL APIs should omit this and store an
   * identifier in `meta` they can re-resolve from.
   */
  url?: string;
  bytesDownloaded?: number;
  error?: { code: DownloadErrorCode; message: string };
  timestamp: number;
  meta?: M;
}

/** Minimal shape of Raycast's LocalStorage — the part this module uses. */
export interface HistoryStorage {
  getItem(key: string): Promise<string | undefined>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface HistoryOptions<M> {
  /** LocalStorage key. Default `"download-history"`. */
  key?: string;
  /** Maximum rows retained, newest first. Default 100. */
  limit?: number;
  /**
   * Collapse rows sharing a derived key, keeping the newest. iOS Apps passes
   * `r => r.meta?.bundleId` to keep one row per app rather than per download.
   * Return `undefined` to exempt a row from deduplication.
   */
  dedupeBy?: (record: DownloadRecord<M>) => string | undefined;
  /** Injected for tests or non-Raycast callers. Defaults to Raycast LocalStorage. */
  storage?: HistoryStorage;
}

export interface DownloadHistory<M = unknown> {
  list(): Promise<DownloadRecord<M>[]>;
  add(
    record: Omit<DownloadRecord<M>, "timestamp"> & { timestamp?: number },
  ): Promise<void>;
  addMany(
    records: Array<
      Omit<DownloadRecord<M>, "timestamp"> & { timestamp?: number }
    >,
  ): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  clearOlderThan(ms: number): Promise<number>;
}

/**
 * Fold finished downloads into history, then clear their status files.
 *
 * **Call this on command launch.** It closes a gap that is structural rather
 * than accidental:
 *
 *   - The transfer completes in the DETACHED RUNNER, which cannot import
 *     `@raycast/api` (it runs outside the Raycast host) and therefore cannot
 *     write to LocalStorage.
 *   - The command that *can* write to LocalStorage has usually been unloaded by
 *     then — surviving dismissal is the whole point of the package.
 *
 * So nothing records the row at the moment the download finishes. Instead the
 * runner leaves a terminal status file behind, and the next command launch
 * reconciles it here.
 *
 * Without this, a user who starts a download and presses Escape gets the file
 * but no history entry — for every download they don't sit and watch.
 *
 * Idempotent: history rows are keyed by download id, and a reconciled status is
 * cleared, so repeat calls neither duplicate nor resurrect rows.
 *
 * @returns how many finished downloads were folded in.
 */
export async function reconcileHistory<M = unknown>(
  history: DownloadHistory<M>,
  options: {
    /** Where status files live. Defaults to the package's status directory. */
    statusDir?: string;
    /** Map a status onto the per-consumer `meta` payload. */
    toMeta?: (status: ReconcilableStatus) => M | undefined;
    /** Also delete status files for downloads that never finished. Default false. */
    clearAbandoned?: boolean;
  } = {},
): Promise<number> {
  const { statusDir, toMeta, clearAbandoned = false } = options;

  // Imported lazily so this module stays usable without the transport layer —
  // a consumer that only wants `createDownloadHistory` shouldn't pull in
  // status-file machinery.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const status = require("./status") as typeof import("./status");

  const statuses = status.listStatuses(statusDir) as ReconcilableStatus[];
  const finished = statuses.filter(
    (s) =>
      s.state === "completed" ||
      s.state === "failed" ||
      s.state === "cancelled",
  );

  if (finished.length === 0) return 0;

  await history.addMany(
    finished.map((s) => ({
      id: s.id,
      filename: s.filename,
      outputPath: s.outputPath,
      status:
        s.state === "completed"
          ? ("completed" as const)
          : (s.state as "failed" | "cancelled"),
      bytesDownloaded: s.bytesDownloaded,
      error: s.error
        ? { code: s.error.code as DownloadErrorCode, message: s.error.message }
        : undefined,
      timestamp: s.finishedAt ?? s.heartbeatAt ?? s.startedAt,
      meta: toMeta?.(s),
    })),
  );

  for (const s of finished) status.clearStatus(s.id, statusDir);

  if (clearAbandoned) {
    for (const s of statuses) {
      if (
        !finished.includes(s) &&
        !status.isAlive(s as unknown as import("./status").DownloadStatus)
      ) {
        status.clearStatus(s.id, statusDir);
      }
    }
  }

  return finished.length;
}

/** The subset of `DownloadStatus` this module needs, without importing the type. */
export interface ReconcilableStatus {
  id: string;
  state: string;
  filename: string;
  outputPath: string;
  bytesDownloaded: number;
  startedAt: number;
  heartbeatAt: number;
  finishedAt?: number;
  error?: { code: string; message: string };
  meta?: Record<string, unknown>;
}

/** Lazily resolve Raycast's LocalStorage, so importing this module never requires a host. */
function defaultStorage(): HistoryStorage {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LocalStorage } = require("@raycast/api") as {
    LocalStorage: {
      getItem(key: string): Promise<string | undefined>;
      setItem(key: string, value: string): Promise<void>;
      removeItem(key: string): Promise<void>;
    };
  };
  return LocalStorage;
}

export function createDownloadHistory<M = unknown>(
  options: HistoryOptions<M> = {},
): DownloadHistory<M> {
  const { key = "download-history", limit = 100, dedupeBy } = options;
  let storage = options.storage;

  const store = (): HistoryStorage => (storage ??= defaultStorage());

  /**
   * Serializes read-modify-write cycles on this instance.
   *
   * History is one storage key holding an array. Two overlapping `add()` calls
   * would each read the same list and write independently, and the later write
   * would erase the earlier record. Extensions routinely run parallel commands,
   * so this is reachable in normal use.
   *
   * Scoped per instance — it cannot serialize across separate Raycast command
   * processes, and nothing available here could. It closes the realistic window
   * rather than pretending to be a distributed lock.
   */
  let chain: Promise<unknown> = Promise.resolve();
  const withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = chain.then(operation, operation);
    chain = result.catch(() => undefined);
    return result;
  };

  async function readAll(): Promise<DownloadRecord<M>[]> {
    const raw = await store().getItem(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      // Corrupt or hand-edited storage must not take the command down; an
      // unreadable history is recoverable, a crash on launch is not.
      return Array.isArray(parsed) ? (parsed as DownloadRecord<M>[]) : [];
    } catch {
      return [];
    }
  }

  async function writeAll(records: DownloadRecord<M>[]): Promise<void> {
    await store().setItem(key, JSON.stringify(records));
  }

  /** Newest first, deduped, capped. */
  function normalize(records: DownloadRecord<M>[]): DownloadRecord<M>[] {
    const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);

    let result = sorted;
    if (dedupeBy) {
      const seen = new Set<string>();
      result = sorted.filter((record) => {
        const dedupeKey = dedupeBy(record);
        if (dedupeKey === undefined) return true;
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
      });
    }

    return result.slice(0, limit);
  }

  async function upsert(incoming: DownloadRecord<M>[]): Promise<void> {
    return withLock(async () => {
      const existing = await readAll();
      // Replace by id rather than append: resume-on-reopen can report the same
      // download again, and a duplicated row would make history lie about how many
      // times something was downloaded.
      const incomingIds = new Set(incoming.map((r) => r.id));
      const merged = [
        ...incoming,
        ...existing.filter((r) => !incomingIds.has(r.id)),
      ];
      await writeAll(normalize(merged));
    });
  }

  return {
    async list() {
      return withLock(async () => normalize(await readAll()));
    },

    async add(record) {
      await upsert([
        {
          ...record,
          timestamp: record.timestamp ?? Date.now(),
        } as DownloadRecord<M>,
      ]);
    },

    async addMany(records) {
      if (records.length === 0) return;
      // Distinct, descending timestamps preserve input order after the sort in
      // normalize(); identical stamps would let it reorder a batch arbitrarily.
      const now = Date.now();
      const stamped = records.map(
        (record, index) =>
          ({
            ...record,
            timestamp: record.timestamp ?? now - index,
          }) as DownloadRecord<M>,
      );
      await upsert(stamped);
    },

    async remove(id) {
      await withLock(async () => {
        const existing = await readAll();
        await writeAll(existing.filter((record) => record.id !== id));
      });
    },

    async clear() {
      // Inside the lock like every other mutation: an `add()` already partway
      // through its read-modify-write would otherwise write its snapshot back
      // afterwards, silently resurrecting rows the user just cleared.
      await withLock(async () => {
        await store().removeItem(key);
      });
    },

    async clearOlderThan(ms) {
      return withLock(async () => {
        const existing = await readAll();
        const cutoff = Date.now() - ms;
        const kept = existing.filter((record) => record.timestamp >= cutoff);
        const removed = existing.length - kept.length;
        if (removed > 0) await writeAll(kept);
        return removed;
      });
    },
  };
}
