/**
 * @chrismessina/raycast-download
 *
 * Downloads for Raycast extensions that survive the window closing.
 *
 * Raycast unloads a command when the user presses Escape or pops back to root
 * search — "any async work you kick off should not be relied on to keep running"
 * (Raycast lifecycle docs). An in-flight stream to disk is torn down mid-write,
 * leaving a truncated file. `no-view` does not help: it runs until its promise
 * resolves, and the promise is the thing doing the downloading.
 *
 * So the transfer runs in a DETACHED child process that outlives the command,
 * reporting through a status file rather than through memory.
 *
 * Two layers, deliberately independent:
 *
 *   Layer A (transport) — status/detach/curl. For extensions downloading from a
 *     URL. Not usable by tools that own their own transport (e.g. `ipatool`,
 *     which never exposes a URL, picks its own output path, and emits no
 *     progress); those consume Layer B only.
 *
 *   Layer B (everything else) — paths/errors/progress/history. Useful to any
 *     extension that puts a file on disk, however it got the bytes.
 *
 * Scope of the guarantee: this survives Raycast dismissal. It does NOT survive
 * machine sleep, power loss, or unattended network drops without user action.
 * Partial files are retained so an interrupted transfer can resume via HTTP
 * Range rather than starting over.
 *
 * Zero runtime dependencies. `@raycast/api` is a peer.
 *
 * SECRETS ARE THE CALLER'S RESPONSIBILITY. Nothing here inspects a URL before
 * persisting it: `meta` is written to the status file verbatim and
 * `DownloadRecord.url` is written to history verbatim. Signed URLs are bearer
 * credentials, so store a re-resolvable identifier instead — or set
 * `createDownloadHistory({ urlPolicy: "omit-signed" })` to have the library
 * enforce it for history (opt-in; the default persists what you pass).
 */

export {
  DownloadError,
  isDownloadError,
  classifyHttpStatus,
  type DownloadErrorCode,
  type DownloadErrorDetail,
} from "./errors";

export {
  expandHome,
  isContained,
  resolveDirectory,
  uniquePath,
  releaseReservation,
  sanitizeFilename,
  type ResolveDirectoryOptions,
  type UniquePathOptions,
} from "./paths";

export {
  formatBytes,
  formatSpeed,
  formatEta,
  formatProgressLine,
  createThrottle,
  type ProgressLineInput,
} from "./progress";

export {
  createDownloadHistory,
  reconcileHistory,
  looksLikeSignedUrl,
  type HistoryUrlPolicy,
  type DownloadHistory,
  type DownloadRecord,
  type HistoryOptions,
  type HistoryStorage,
  type ReconcilableStatus,
} from "./history";

export {
  statusDir,
  statusPath,
  writeStatus,
  readStatus,
  listStatuses,
  clearStatus,
  pruneStatuses,
  watchStatus,
  isAlive,
  isTerminal,
  isStalled,
  processStartTimeMs,
  canVerifyProcessIdentity,
  acquireLease,
  releaseLease,
  statusLockPath,
  withStatusLock,
  type DownloadStatus,
  type DownloadState,
  type StatusWatcher,
  type WatchOptions,
} from "./status";

export {
  startDownload,
  killDownload,
  reconcile,
  runnerPath,
  runnerSearchPaths,
  type StartDownloadOptions,
  type DownloadTicket,
  type KillOptions,
} from "./detach";

export {
  hasCurl,
  buildCurlConfig,
  parseCurlMeter,
  parseCurlSize,
  parseCurlDuration,
  parseWriteOut,
  classifyCurlFailure,
  type CurlConfigOptions,
  type CurlProgress,
  type CurlWriteOut,
  type ClassifyCurlInput,
} from "./curl";
