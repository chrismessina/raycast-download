/**
 * Progress formatting and throttling.
 *
 * Pure functions — no Raycast imports — so they are testable without a host and
 * usable from the detached runner. The toast presenter that consumes these lives
 * separately, because it needs `@raycast/api` and a status file to watch.
 *
 * Every formatter returns an em dash rather than `NaN`/`undefined` for unknown
 * values. These strings go straight into a toast: "NaN undefined" is a visible
 * bug, a dash reads as "not known yet".
 */

const UNKNOWN = "—";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Largest sane ETA to display. curl's first samples are wild; don't show "in 68 years". */
const MAX_ETA_SECONDS = 24 * 60 * 60;

function isUsableNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Human-readable byte count. `formatBytes(383713905)` → `"365.9 MB"`. */
export function formatBytes(bytes: number | undefined): string {
  if (!isUsableNumber(bytes)) return UNKNOWN;
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** Transfer rate. Zero is treated as unknown — a stalled transfer shows no rate. */
export function formatSpeed(bytesPerSec: number | undefined): string {
  if (!isUsableNumber(bytesPerSec) || bytesPerSec === 0) return UNKNOWN;
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Compact duration. Caps at a day, above which the estimate is noise. */
export function formatEta(seconds: number | undefined): string {
  if (!isUsableNumber(seconds) || seconds === 0 || seconds > MAX_ETA_SECONDS) return UNKNOWN;

  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const rem = total % 60;
    return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}

export interface ProgressLineInput {
  bytesDownloaded: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  etaSeconds?: number;
}

/**
 * One-line progress summary for a toast message.
 *
 * Omits segments it cannot compute rather than padding with dashes: a line
 * reading "— · — · —" is noise. With a known total this yields
 * `"50% · 183.0 MB / 365.9 MB · 1.2 MB/s · 2m 30s"`.
 */
export function formatProgressLine(input: ProgressLineInput): string {
  const { bytesDownloaded, totalBytes, speedBytesPerSec, etaSeconds } = input;
  const parts: string[] = [];

  if (isUsableNumber(totalBytes) && totalBytes > 0) {
    // Resumed transfers can report more than the ranged content-length.
    const pct = Math.min(100, Math.floor((bytesDownloaded / totalBytes) * 100));
    parts.push(`${pct}%`);
    parts.push(`${formatBytes(bytesDownloaded)} / ${formatBytes(totalBytes)}`);
  } else {
    // No content-length: report real bytes rather than inventing a percentage.
    parts.push(formatBytes(bytesDownloaded));
  }

  const speed = formatSpeed(speedBytesPerSec);
  if (speed !== UNKNOWN) parts.push(speed);

  const eta = formatEta(etaSeconds);
  if (eta !== UNKNOWN) parts.push(eta);

  return parts.join(" · ");
}

/**
 * Per-key throttle.
 *
 * A 350 MB transfer emits progress tens of thousands of times. Without this,
 * each one becomes a Raycast UI update. Returns the callback's value when it
 * runs and `undefined` when suppressed.
 *
 * Scoped to the returned closure rather than a module-global map (which is how
 * Fetch does it today) so two concurrent views can't throttle each other.
 */
export function createThrottle(intervalMs = 250): <T>(key: string, fn: () => T) => T | undefined {
  const lastRun = new Map<string, number>();

  return <T>(key: string, fn: () => T): T | undefined => {
    const now = Date.now();
    const previous = lastRun.get(key);
    if (previous !== undefined && now - previous < intervalMs) return undefined;
    lastRun.set(key, now);
    return fn();
  };
}
