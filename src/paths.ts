/**
 * Path resolution and containment.
 *
 * This is the security-sensitive module: it decides where a download is allowed
 * to land. Two mistakes it exists to prevent, both observed in the wild:
 *
 *   1. Prefix-matched containment. `"/tmp-evil".startsWith("/tmp")` is true, so
 *      a string-prefix allowlist happily accepts a sibling directory. Containment
 *      must compare path *components*.
 *   2. Lexical-only checks. A symlink inside an allowed directory can resolve
 *      anywhere, so containment is decided after realpath.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/**
 * Expand a leading `~` to the current user's home directory.
 *
 * `~user` is deliberately NOT expanded. It means "user's home" to a shell, we
 * cannot resolve it, and rewriting it to the *current* user's home (which both
 * existing fleet implementations do, by `slice(1)` or `replace("~", home)`)
 * silently sends files somewhere the user did not ask for.
 */
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~" + sep)) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/**
 * True when `candidate` is `root` or sits beneath it.
 *
 * Component-aware: `/tmp-evil` is not inside `/tmp`. Symlinks are resolved for
 * whichever leading portion of the path exists, so a link cannot smuggle the
 * destination outside the root.
 */
export function isContained(candidate: string, root: string): boolean {
  const resolvedRoot = realpathIfPossible(resolve(root));
  const resolvedCandidate = realpathIfPossible(resolve(candidate));

  if (resolvedCandidate === resolvedRoot) return true;

  // `relative()` gives a component-wise answer: anything that escapes starts
  // with "..", and a prefix sibling yields "../tmp-evil" rather than "-evil".
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  return !isAbsolute(rel);
}

/**
 * realpath the longest existing ancestor, then re-append the missing tail.
 * A path we are about to create does not exist yet, but its parent chain does,
 * and that is where a symlink escape would live.
 */
function realpathIfPossible(input: string): string {
  let current = normalize(input);
  const trailing: string[] = [];

  for (;;) {
    if (existsSync(current)) {
      try {
        return trailing.length ? join(realpathSync(current), ...trailing.reverse()) : realpathSync(current);
      } catch {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) return input;
    trailing.push(basename(current));
    current = parent;
  }
}

export interface ResolveDirectoryOptions {
  /** Roots the resolved path must sit under. Default: [homedir(), tmpdir()]. */
  allowedRoots?: string[];
  /**
   * What to do when the input is missing or lands outside `allowedRoots`.
   * Fathom warns and falls back; iOS Apps throws. Both are correct for their
   * context, so this is a required decision rather than a default.
   */
  onUnsafe?: "fallback" | "throw";
  fallback?: string;
  /** mkdir -p the result. Default true. */
  create?: boolean;
}

/**
 * Resolve a user-supplied directory preference to a safe absolute path.
 */
export function resolveDirectory(input: string | undefined, options: ResolveDirectoryOptions = {}): string {
  const { allowedRoots = [homedir(), tmpdir()], onUnsafe = "fallback", create = true } = options;
  const fallback = options.fallback ?? join(homedir(), "Downloads");

  const candidate = input?.trim() ? resolve(expandHome(input.trim())) : undefined;

  let chosen: string;
  if (!candidate) {
    chosen = fallback;
  } else if (allowedRoots.some((root) => isContained(candidate, root))) {
    chosen = candidate;
  } else if (onUnsafe === "throw") {
    throw new Error(
      `Refusing to use "${candidate}": it is outside the allowed roots (${allowedRoots.join(", ")}).`,
    );
  } else {
    chosen = fallback;
  }

  if (create) mkdirSync(chosen, { recursive: true });
  return chosen;
}

/**
 * Release a reservation taken by `uniquePath({reserve: true})`.
 *
 * Call this when the work that claimed the name fails before writing anything.
 * An abandoned zero-byte sidecar would otherwise burn that filename forever:
 * every later attempt skips past it to `name (2)`, `name (3)`, and so on.
 *
 * Only removes the sidecar if it is still empty, so it can never delete a
 * partial download that has real bytes in it and could be resumed.
 */
export function releaseReservation(outputPath: string, reserveSuffix = ".part"): void {
  const sidecar = `${outputPath}${reserveSuffix}`;
  try {
    if (statSync(sidecar).size === 0) unlinkSync(sidecar);
  } catch {
    // Missing, or has bytes worth keeping.
  }
}

/**
 * Write a file that only the current user can read, enforcing the mode even if
 * the path already exists.
 *
 * `writeFileSync(path, data, { mode })` applies the mode only when it CREATES
 * the file — measured: writing a secret over an existing 0644 file leaves it at
 * 0644, world-readable. Since these files carry signed URLs (bearer
 * credentials), the mode has to be enforced rather than requested.
 *
 * Order matters: chmod BEFORE writing, so the secret is never on disk under
 * loose permissions, even briefly.
 */
export function writeSecretFile(path: string, data: string): void {
  try {
    if (existsSync(path)) chmodSync(path, 0o600);
  } catch {
    // If it can't be tightened, fall through — the write below still requests
    // 0600, and failing the download outright would be worse than a best-effort
    // write to a path the caller chose.
  }
  writeFileSync(path, data, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on exotic filesystems.
  }
}

/** Split a filename into stem and final extension. "a.tar.gz" → ["a.tar", ".gz"]. */
function splitExtension(filename: string): [string, string] {
  const ext = extname(filename);
  return ext ? [filename.slice(0, -ext.length), ext] : [filename, ""];
}

export interface UniquePathOptions {
  /** " (n)" (both current fleet extensions) or "-n". Default "paren". */
  style?: "paren" | "dash";
  /**
   * First suffix to try. Fetch numbers from 1, Fathom from 2 — preserved
   * deliberately, because unifying them renames files users already have.
   */
  startAt?: number;
  /** Attempts before falling back to a timestamp. Default 1000. */
  limit?: number;
  /**
   * Atomically claim the name by creating a sidecar file, closing the window
   * between "this name is free" and "this name is taken".
   *
   * Required when the real file appears later than this call — a download that
   * writes to `<path>.part` first, for instance. Without it, two downloads
   * started moments apart both see a free name and one overwrites the other.
   */
  reserve?: boolean;
  /** Sidecar suffix used when reserving. Default `".part"`. */
  reserveSuffix?: string;
}

/** Find a non-colliding path in `dir` for `filename`. */
export function uniquePath(dir: string, filename: string, options: UniquePathOptions = {}): string {
  const { style = "paren", startAt = 1, limit = 1000, reserve = false, reserveSuffix = ".part" } = options;
  const safe = sanitizeFilename(filename);

  const candidates: string[] = [join(dir, safe)];
  const [stem, ext] = splitExtension(safe);
  for (let n = startAt; n < startAt + limit; n++) {
    candidates.push(join(dir, style === "paren" ? `${stem} (${n})${ext}` : `${stem}-${n}${ext}`));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) continue;

    if (!reserve) return candidate;

    // Reservation mode. Checking `existsSync` and returning a path is a TOCTOU
    // race: a caller that only creates the file LATER (a download writing to
    // `<path>.part` first) leaves a window where a second caller sees the same
    // empty directory and picks the same name — and then one silently
    // overwrites the other. Claim the sidecar atomically with `wx` instead, so
    // exactly one caller can win a given name.
    const sidecar = `${candidate}${reserveSuffix}`;
    if (existsSync(sidecar)) continue;
    try {
      closeSync(openSync(sidecar, "wx"));
      return candidate;
    } catch {
      // Lost the race; try the next candidate.
      continue;
    }
  }

  // Pathological case: never loop forever and never return a colliding path.
  return join(dir, `${stem} ${Date.now()}${ext}`);
}

/**
 * Reduce an arbitrary string to a safe single path segment.
 *
 * Never returns an empty string — an empty filename would silently become the
 * directory itself at the join() call site.
 */
export function sanitizeFilename(name: string, options: { maxLength?: number } = {}): string {
  const { maxLength = 255 } = options;

  let out = name
    .replace(/[/\\]/g, "-") // path separators → visible, non-structural
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "") // control characters, incl. NUL
    .replace(/[<>:"|?*]/g, "") // reserved on the platforms Raycast targets
    .replace(/\.{2,}/g, ".") // collapse traversal runs
    .replace(/^[.\s]+/, "") // no leading dots (hidden) or space
    .replace(/[.\s]+$/, ""); // no trailing dot or space

  if (!out) out = "download";

  // Truncate by BYTES, not UTF-16 code units. macOS/APFS limits a path
  // component to 255 bytes, so a title in CJK or with emoji can sit well under
  // 255 characters and still blow the limit — an ENAMETOOLONG at write time,
  // long after the name was chosen.
  if (byteLength(out) > maxLength) {
    const [stem, ext] = splitExtension(out);
    const room = Math.max(1, maxLength - byteLength(ext));
    out = truncateToBytes(stem, room) + ext;
  }

  return out;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate to a byte budget without splitting a multi-byte character. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;

  // Cutting a Buffer mid-sequence yields replacement characters, so walk back
  // to a whole-character boundary using the code points themselves.
  let result = "";
  let used = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    result += char;
    used += size;
  }
  return result || value.slice(0, 1);
}
