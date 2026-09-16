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
import { withFileLock } from "./lock";

export interface DownloadRecord<M = unknown> {
  id: string;
  filename: string;
  outputPath: string;
  status: "completed" | "failed" | "cancelled";
  /**
   * Source URL, when it is safe to persist.
   *
   * **The default is to persist whatever you pass, verbatim.** This module does
   * not inspect it and never has — an earlier version of this comment implied a
   * guarantee that no code backed up, which is worse than no comment at all.
   *
   * Signed URLs are bearer credentials: anyone who can read the extension's
   * LocalStorage can re-download with them until they expire. Keeping them out
   * is the CALLER's responsibility. Consumers of expiring-URL APIs should omit
   * this field and store a re-resolvable identifier in `meta` instead.
   *
   * If you want the library to enforce it, set `urlPolicy` on
   * `createDownloadHistory` — opt-in, because turning it on by default would
   * silently drop URLs an existing consumer relies on.
   */
  url?: string;
  bytesDownloaded?: number;
  error?: { code: DownloadErrorCode; message: string };
  timestamp: number;
  meta?: M;
}

/**
 * Query parameters that make a URL a bearer credential.
 *
 * A heuristic, and named as one: it recognises the presigning schemes actually
 * in use (S3/R2 sigv4, GCS, Azure SAS, CloudFront, and the generic
 * `token`/`signature`/`sig` conventions) and it will not recognise a bespoke
 * one. It is a safety net under a caller who already decided not to persist
 * secrets — not a substitute for that decision.
 */
const SIGNED_URL_PARAMS: readonly string[] = [
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
  "signature",
  "sig",
  "token",
  "access_token",
  "key-pair-id",
  "policy",
  "se", // Azure SAS expiry, always paired with a signature
  "expires",
  "expiry",
  "hmac",
];

/**
 * True when a URL carries what looks like an embedded credential.
 *
 * Exported so a consumer can make the same judgement at its own call site —
 * e.g. to decide whether to store an identifier in `meta` instead.
 */
export function looksLikeSignedUrl(url: string): boolean {
  let query: string;
  try {
    query = new URL(url).searchParams.toString();
  } catch {
    // Not parseable as a URL: fall back to the raw string after "?" so a
    // relative or malformed value is still screened rather than waved through.
    query = url.slice(url.indexOf("?") + 1);
  }
  if (!query) return false;

  const names = new Set(
    query
      .split("&")
      .map((pair) => decodeURIComponent(pair.split("=")[0] ?? "").toLowerCase())
      .filter(Boolean),
  );
  return SIGNED_URL_PARAMS.some((param) => names.has(param));
}

/**
 * What to do with `record.url` before persisting it.
 *
 * `"allow"` (the default) persists it verbatim, which is the historical
 * behaviour and the only one that cannot break an existing consumer.
 */
export type HistoryUrlPolicy = "allow" | "omit-signed" | "omit-all" | "throw-signed";

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
  /**
   * Whether to enforce that signed URLs stay out of persisted history.
   * Default `"allow"` — see `DownloadRecord.url`. `"omit-signed"` is the
   * setting a consumer of an expiring-URL API wants.
   */
  urlPolicy?: HistoryUrlPolicy;
  /**
   * Directory for the cross-process lock file. Defaults to the package's own
   * status directory, which is per-extension. Override only to isolate tests.
   */
  lockDir?: string;
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

  // Only clear the status we actually folded in.
  //
  // `addMany` is awaited above, and that await is long enough for the user to
  // press Retry: the id gets reused, a new runner writes a fresh non-terminal
  // status over the terminal one, and the unconditional delete that used to sit
  // here threw away the LIVE attempt's status file. The download then ran to
  // completion with nothing tracking it — invisible in the UI, uncancellable,
  // and reported as vanished.
  //
  // Re-read under the same lock the status writers hold, and delete only if the
  // file is still the attempt whose row we just wrote.
  for (const s of finished) {
    status.withStatusLock(s.id, statusDir, () => {
      const current = status.readStatus(s.id, statusDir);
      if (!current) return;
      if (!status.isTerminal(current.state)) return;
      // `startedAt` alone is enough to tell two attempts apart; pid is a second
      // signal for the case where a retry landed inside the same millisecond.
      if (s.startedAt !== undefined && current.startedAt !== s.startedAt) return;
      if (s.pid !== undefined && current.pid !== s.pid) return;
      status.clearStatus(s.id, statusDir);
    });
  }

  if (clearAbandoned) {
    // Same hazard as the loop above, and it was still open here: this decided
    // liveness from the snapshot taken BEFORE `await history.addMany(...)` and
    // deleted without the status lock. Retry reuses the id during that await
    // and writes a fresh LIVE status — which is then the file this deleted.
    //
    // So re-read under the lock the status writers hold, confirm it is still
    // the same attempt, and re-check liveness against what is on disk NOW
    // rather than against the stale snapshot.
    for (const s of statuses) {
      if (finished.includes(s)) continue;
      status.withStatusLock(s.id, statusDir, () => {
        const current = status.readStatus(s.id, statusDir);
        if (!current) return;
        if (s.startedAt !== undefined && current.startedAt !== s.startedAt) return;
        if (s.pid !== undefined && current.pid !== s.pid) return;
        if (status.isAlive(current)) return;
        status.clearStatus(s.id, statusDir);
      });
    }
  }

  return finished.length;
}

/** The subset of `DownloadStatus` this module needs, without importing the type. */
export interface ReconcilableStatus {
  id: string;
  /** Identifies the ATTEMPT, so reconciliation cannot delete a retry's status. */
  pid?: number;
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
  const { key = "download-history", limit = 100, dedupeBy, urlPolicy = "allow" } = options;
  let storage = options.storage;

  const store = (): HistoryStorage => (storage ??= defaultStorage());

  /**
   * Where the cross-process lock file lives.
   *
   * Resolved lazily: `statusDir()` creates a directory and reads
   * `@raycast/api`, and merely constructing a history object should do neither.
   */
  let lockPath: string | undefined;
  const lockFile = (): string => {
    if (lockPath) return lockPath;
    let dir = options.lockDir;
    if (!dir) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const status = require("./status") as typeof import("./status");
      dir = status.statusDir();
    }
    // The key is a LocalStorage key, so it may hold anything; reduce it to one
    // safe path segment. Same key in two processes must yield the same lock.
    const safeKey = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "history";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require("node:path") as typeof import("node:path");
    lockPath = join(dir, `history-${safeKey}.lock`);
    return lockPath;
  };

  /**
   * Serializes read-modify-write cycles, in this process AND across processes.
   *
   * History is one storage key holding an array, so a mutation is
   * read-the-whole-array, change it, write-the-whole-array. Two of those
   * overlapping means the later write erases the earlier record.
   *
   * The promise chain handles the in-process case. It is NOT enough on its own:
   * every Raycast command is a separate OS process with no shared memory, so
   * the Download and History commands can be halfway through the same cycle at
   * the same moment and neither chain can see the other. That is the case the
   * file lock covers — `../lock.ts` explains why it is built from `open(…,
   * "wx")` and why it degrades to running unsynchronized rather than failing.
   */
  let chain: Promise<unknown> = Promise.resolve();
  const withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const guarded = () => withFileLock(lockFile(), operation);
    const result = chain.then(guarded, guarded);
    chain = result.catch(() => undefined);
    return result;
  };

  /** Apply `urlPolicy` to one record on its way to storage. */
  function screenUrl(record: DownloadRecord<M>): DownloadRecord<M> {
    if (urlPolicy === "allow" || record.url === undefined) return record;
    if (urlPolicy === "omit-all") return { ...record, url: undefined };
    if (!looksLikeSignedUrl(record.url)) return record;
    if (urlPolicy === "throw-signed") {
      throw new Error(
        `Refusing to persist a signed URL in download history (record ${JSON.stringify(record.id)}). ` +
          `Signed URLs are bearer credentials — store a re-resolvable identifier in \`meta\` instead.`,
      );
    }
    return { ...record, url: undefined };
  }

  /**
   * Apply `urlPolicy` to a record ALREADY in storage, on its way back out.
   *
   * `screenUrl` only ever saw incoming records, so a row written while the
   * policy was `"allow"` was copied through the merge below and re-serialized
   * by every later write — meaning `omit-signed` did not actually keep signed
   * URLs out of persisted history, it only kept new ones out. Callers opting in
   * are opting into the property, not into the subset of rows we happened to
   * screen.
   *
   * Deliberately never throws, unlike `screenUrl`: under `"throw-signed"` a row
   * predating the policy must not make an unrelated write fail. Scrubbing it is
   * the outcome that policy wants anyway.
   */
  function screenStored(record: DownloadRecord<M>): DownloadRecord<M> {
    if (urlPolicy === "allow" || record.url === undefined) return record;
    if (urlPolicy === "omit-all") return { ...record, url: undefined };
    if (!looksLikeSignedUrl(record.url)) return record;
    return { ...record, url: undefined };
  }

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

  async function upsert(records: DownloadRecord<M>[]): Promise<void> {
    // Collapse duplicate ids WITHIN the batch, keeping the NEWEST by timestamp.
    //
    // The de-duplication below only protected `incoming` against `existing`. A
    // single batch carrying the same id twice — reconciliation seeing a status
    // twice, a caller looping over an unfiltered list — put two rows with one
    // id into history, and every later `remove(id)`/replace touched whichever
    // one it hit first.
    //
    // This used to keep the FIRST occurrence, on the premise that `addMany`
    // stamps records newest-first. That premise holds only when the caller
    // OMITS timestamps: `addMany` stamps `record.timestamp ?? now - index`, so a
    // caller supplying its own timestamps decides the order and the OLDER row
    // was winning. Compare the timestamps instead of trusting position.
    const newest = new Map<string, DownloadRecord<M>>();
    for (const record of records) {
      const previous = newest.get(record.id);
      if (previous === undefined || record.timestamp > previous.timestamp) {
        newest.set(record.id, record);
      }
    }
    const incoming = [...newest.values()].map(screenUrl);
    const batchIds = new Set(newest.keys());

    return withLock(async () => {
      const existing = await readAll();
      // Replace by id rather than append: resume-on-reopen can report the same
      // download again, and a duplicated row would make history lie about how many
      // times something was downloaded.
      const merged = [
        ...incoming,
        ...existing.filter((r) => !batchIds.has(r.id)).map(screenStored),
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
