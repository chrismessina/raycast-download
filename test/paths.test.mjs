import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  expandHome,
  resolveDirectory,
  uniquePath,
  releaseReservation,
  sanitizeFilename,
  isContained,
  writeSecretFile,
} from "../dist/paths.js";

// ─── expandHome ──────────────────────────────────────────────────────────────

test("expandHome expands a bare tilde", () => {
  assert.equal(expandHome("~"), homedir());
});

test("expandHome expands ~/ prefixed paths", () => {
  assert.equal(expandHome("~/Downloads"), join(homedir(), "Downloads"));
});

test("expandHome does NOT expand ~user — it is not our home directory", () => {
  // Both existing in-fleet implementations get this wrong in different ways:
  // Fathom's `slice(1)` turns "~foo" into "<home>/foo"; Fetch's `replace("~", home)`
  // does the same. "~foo" means user foo's home to a shell, which we cannot resolve
  // and must not silently rewrite into the current user's home.
  assert.equal(expandHome("~foo"), "~foo");
  assert.equal(expandHome("~foo/bar"), "~foo/bar");
});

test("expandHome leaves absolute and relative paths alone", () => {
  assert.equal(expandHome("/tmp/x"), "/tmp/x");
  assert.equal(expandHome("./rel"), "./rel");
  assert.equal(expandHome(""), "");
});

// ─── isContained ─────────────────────────────────────────────────────────────

test("isContained accepts a real descendant", () => {
  assert.equal(isContained("/tmp/sub/file.txt", "/tmp"), true);
});

test("isContained accepts the root itself", () => {
  assert.equal(isContained("/tmp", "/tmp"), true);
});

test("isContained REJECTS a prefix sibling — /tmp-evil is not inside /tmp", () => {
  // A naive `startsWith("/tmp")` returns true here. That is the bug this exists to stop.
  assert.equal(isContained("/tmp-evil/file.txt", "/tmp"), false);
  assert.equal(isContained("/tmpfoo", "/tmp"), false);
});

test("isContained rejects traversal that escapes the root", () => {
  assert.equal(isContained("/tmp/../etc/passwd", "/tmp"), false);
});

// ─── resolveDirectory ────────────────────────────────────────────────────────

test("resolveDirectory falls back when the path is outside the allowlist", () => {
  const fallback = join(tmpdir(), "rd-fallback-test");
  const got = resolveDirectory("/etc", {
    allowedRoots: [tmpdir()],
    onUnsafe: "fallback",
    fallback,
    create: false,
  });
  assert.equal(got, fallback);
});

test("resolveDirectory throws when configured to, instead of silently relocating", () => {
  assert.throws(
    () => resolveDirectory("/etc", { allowedRoots: [tmpdir()], onUnsafe: "throw", create: false }),
    /outside the allowed/i,
  );
});

test("resolveDirectory rejects a symlink escaping the allowlist", () => {
  const base = mkdtempSync(join(tmpdir(), "rd-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "rd-outside-"));
  const link = join(base, "escape");
  symlinkSync(outside, link);
  try {
    // The link *lexically* sits under `base`, but resolves outside it. Containment
    // must be decided after realpath, or this is an escape hatch.
    assert.throws(
      () => resolveDirectory(link, { allowedRoots: [join(base, "allowed")], onUnsafe: "throw", create: false }),
      /outside the allowed/i,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveDirectory accepts a path inside the allowlist", () => {
  const base = mkdtempSync(join(tmpdir(), "rd-ok-"));
  try {
    assert.equal(resolveDirectory(base, { allowedRoots: [tmpdir()], create: false }), base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── uniquePath ──────────────────────────────────────────────────────────────

test("uniquePath returns the plain path when nothing collides", () => {
  const dir = mkdtempSync(join(tmpdir(), "up-none-"));
  try {
    assert.equal(uniquePath(dir, "a.txt"), join(dir, "a.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePath honors startAt — Fetch numbers from (1), Fathom from (2)", () => {
  // Unifying these would rename files existing users already have on disk.
  const dir = mkdtempSync(join(tmpdir(), "up-start-"));
  try {
    writeFileSync(join(dir, "a.txt"), "");
    assert.equal(uniquePath(dir, "a.txt", { startAt: 1 }), join(dir, "a (1).txt"));
    assert.equal(uniquePath(dir, "a.txt", { startAt: 2 }), join(dir, "a (2).txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePath skips over successive collisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "up-skip-"));
  try {
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, "a (2).txt"), "");
    assert.equal(uniquePath(dir, "a.txt", { startAt: 2 }), join(dir, "a (3).txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePath preserves multi-dot extensions", () => {
  const dir = mkdtempSync(join(tmpdir(), "up-ext-"));
  try {
    writeFileSync(join(dir, "a.tar.gz"), "");
    // Only the final extension is a suffix; "a.tar" is the stem.
    assert.equal(uniquePath(dir, "a.tar.gz", { startAt: 1 }), join(dir, "a.tar (1).gz"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePath with reserve atomically claims the name for concurrent callers", () => {
  // Without reservation this is a TOCTOU race: a download resolves its name
  // BEFORE the runner creates any file, so two downloads of same-titled
  // meetings both see a free name and one silently overwrites the other.
  const dir = mkdtempSync(join(tmpdir(), "up-reserve-"));
  try {
    const first = uniquePath(dir, "Weekly Sync - 2026-07-30.mp4", { startAt: 2, reserve: true });
    const second = uniquePath(dir, "Weekly Sync - 2026-07-30.mp4", { startAt: 2, reserve: true });

    assert.notEqual(first, second, "two concurrent callers must not get the same path");
    assert.equal(first, join(dir, "Weekly Sync - 2026-07-30.mp4"));
    assert.equal(second, join(dir, "Weekly Sync - 2026-07-30 (2).mp4"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePath reservation creates an EMPTY sidecar the downloader can write into", () => {
  const dir = mkdtempSync(join(tmpdir(), "up-sidecar-"));
  try {
    const chosen = uniquePath(dir, "a.mp4", { reserve: true });
    const sidecar = `${chosen}.part`;
    assert.ok(existsSync(sidecar), "sidecar must exist to hold the claim");
    assert.equal(statSync(sidecar).size, 0, "must be empty so resume logic treats it as a fresh start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePath without reserve leaves no files behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "up-noreserve-"));
  try {
    uniquePath(dir, "a.mp4");
    assert.equal(readdirSync(dir).length, 0, "non-reserving callers must not touch the filesystem");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePath skips a name whose sidecar is claimed even if the final file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "up-claimed-"));
  try {
    writeFileSync(join(dir, "a.mp4.part"), ""); // an in-flight download
    const chosen = uniquePath(dir, "a.mp4", { startAt: 1, reserve: true });
    assert.notEqual(chosen, join(dir, "a.mp4"), "must not hand out a name a live download owns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePath falls back to a distinct name at the iteration cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "up-cap-"));
  try {
    writeFileSync(join(dir, "a.txt"), "");
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, `a (${i}).txt`), "");
    const got = uniquePath(dir, "a.txt", { startAt: 1, limit: 5 });
    // Must not return a path that already exists, and must not loop forever.
    assert.notEqual(got, join(dir, "a.txt"));
    assert.match(got, /a .*\.txt$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── sanitizeFilename ────────────────────────────────────────────────────────

test("sanitizeFilename strips path separators and control characters", () => {
  assert.equal(sanitizeFilename("a/b\\c.txt"), "a-b-c.txt");
  assert.equal(sanitizeFilename("a b.txt"), "ab.txt");
});

test("sanitizeFilename neutralizes traversal segments", () => {
  const got = sanitizeFilename("../../etc/passwd");
  assert.ok(!got.includes(".."), `expected no ".." in ${got}`);
  assert.ok(!got.includes("/"), `expected no "/" in ${got}`);
});

test("sanitizeFilename never returns an empty string", () => {
  assert.notEqual(sanitizeFilename(""), "");
  assert.notEqual(sanitizeFilename("..."), "");
  assert.notEqual(sanitizeFilename("///"), "");
});

test("sanitizeFilename truncates but keeps the extension", () => {
  const long = "x".repeat(500) + ".mp4";
  const got = sanitizeFilename(long, { maxLength: 60 });
  assert.ok(got.length <= 60, `expected <= 60, got ${got.length}`);
  assert.ok(got.endsWith(".mp4"), `expected .mp4 suffix, got ${got.slice(-10)}`);
});

test("sanitizeFilename truncates by BYTES, not UTF-16 code units", () => {
  // macOS limits a path component to 255 BYTES. A CJK title sits at 3 bytes per
  // character, so 200 characters is 600 bytes — well under a character-based
  // limit but far over the filesystem's, producing ENAMETOOLONG at write time.
  const cjk = "会".repeat(200) + ".mp4";
  const got = sanitizeFilename(cjk, { maxLength: 255 });
  assert.ok(Buffer.byteLength(got, "utf8") <= 255, `expected <=255 bytes, got ${Buffer.byteLength(got, "utf8")}`);
  assert.ok(got.endsWith(".mp4"));
});

test("sanitizeFilename never splits a multi-byte character when truncating", () => {
  const emoji = "🎬".repeat(100) + ".mp4";
  const got = sanitizeFilename(emoji, { maxLength: 60 });
  assert.ok(!got.includes("�"), "must not produce replacement characters");
  assert.ok(got.endsWith(".mp4"));
  assert.ok(Buffer.byteLength(got, "utf8") <= 60);
});

test("releaseReservation frees an empty claim so the name is reusable", () => {
  const dir = mkdtempSync(join(tmpdir(), "rel-"));
  try {
    const first = uniquePath(dir, "a.mp4", { reserve: true });
    releaseReservation(first);
    // Without release, the abandoned sidecar would burn "a.mp4" forever.
    const second = uniquePath(dir, "a.mp4", { reserve: true });
    assert.equal(second, first, "the released name should be handed out again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseReservation REFUSES to delete a partial that has real bytes", () => {
  // A resumable download must never be destroyed by cleanup.
  const dir = mkdtempSync(join(tmpdir(), "rel-bytes-"));
  try {
    const chosen = uniquePath(dir, "a.mp4", { reserve: true });
    writeFileSync(`${chosen}.part`, "downloaded bytes");
    releaseReservation(chosen);
    assert.ok(existsSync(`${chosen}.part`), "a non-empty .part must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSecretFile enforces 0600 even over an existing loose-permission file", () => {
  // writeFileSync({mode}) applies the mode only when it CREATES the file.
  // Measured: writing a secret over an existing 0644 file leaves it at 0644,
  // world-readable — and these files carry signed URLs.
  const dir = mkdtempSync(join(tmpdir(), "secret-"));
  try {
    const target = join(dir, "payload.json");
    writeFileSync(target, "old");
    chmodSync(target, 0o644);
    assert.equal(statSync(target).mode & 0o777, 0o644, "precondition: file is loose");

    writeSecretFile(target, '{"url":"https://signed"}');

    assert.equal(statSync(target).mode & 0o777, 0o600, "mode must be enforced, not merely requested");
    assert.match(readFileSync(target, "utf8"), /signed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSecretFile creates a new file already restricted", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-new-"));
  try {
    const target = join(dir, "new.json");
    writeSecretFile(target, "secret");
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDirectory reports a fallback so the caller can explain it", (t) => {
  const outside = "/etc/definitely-not-under-home";
  const calls = [];
  const chosen = resolveDirectory(outside, {
    onUnsafe: "fallback",
    fallback: tmpdir(),
    create: false,
    onFallback: (attempted, picked) => calls.push([attempted, picked]),
  });
  assert.equal(chosen, tmpdir());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], outside);
  assert.equal(calls[0][1], tmpdir());
});

test("resolveDirectory does NOT report a fallback when the input was accepted", () => {
  const calls = [];
  const inside = join(tmpdir(), "accepted-dir");
  const chosen = resolveDirectory(inside, { create: false, onFallback: () => calls.push(1) });
  assert.equal(chosen, inside);
  assert.equal(calls.length, 0, "nothing was overridden, so nothing to report");
});

test("resolveDirectory does NOT report a fallback when no input was supplied", () => {
  const calls = [];
  resolveDirectory(undefined, { fallback: tmpdir(), create: false, onFallback: () => calls.push(1) });
  assert.equal(calls.length, 0, "no directory was attempted, so there is no override to explain");
});

test("resolveDirectory throws instead of reporting when onUnsafe is throw", () => {
  const calls = [];
  assert.throws(
    () => resolveDirectory("/etc/nope", { onUnsafe: "throw", create: false, onFallback: () => calls.push(1) }),
    /outside the allowed roots/,
  );
  assert.equal(calls.length, 0, "the throw is already the signal");
});

// ─── Codex fix wave: fallback containment, reservation TOCTOU, byte budget ───

test("resolveDirectory refuses a fallback that sits outside allowedRoots", () => {
  // A caller that declares custom roots and forgets to override `fallback` used
  // to get ~/Downloads — outside the roots it had just restricted — and mkdir'd
  // into existence. Silently landing files outside the allowlist defeats the
  // only guarantee the function makes, so this is now loud.
  const root = mkdtempSync(join(tmpdir(), "roots-"));
  try {
    assert.throws(
      () => resolveDirectory(undefined, { allowedRoots: [root] }),
      /outside the allowed roots/,
      "the default ~/Downloads fallback is not inside the declared root",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDirectory refuses a rejected input's fallback too, not just the input", () => {
  const root = mkdtempSync(join(tmpdir(), "roots-"));
  try {
    assert.throws(
      () => resolveDirectory("/etc/nope", { allowedRoots: [root], onUnsafe: "fallback" }),
      /outside the allowed roots/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDirectory accepts a fallback inside allowedRoots", () => {
  const root = mkdtempSync(join(tmpdir(), "roots-"));
  try {
    const chosen = resolveDirectory(undefined, {
      allowedRoots: [root],
      fallback: join(root, "dl"),
      create: false,
    });
    assert.equal(chosen, join(root, "dl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDirectory expands ~ in the fallback", () => {
  const chosen = resolveDirectory(undefined, { fallback: "~/Downloads", create: false });
  assert.equal(chosen, join(homedir(), "Downloads"));
});

test("uniquePath does not hand back a final path occupied after the sidecar was taken", () => {
  // The state the post-acquisition recheck exists for: the sidecar is free (so
  // `wx` succeeds) while the final name is occupied, which is exactly what a
  // concurrent runner's `.part` -> final rename produces. Constructed directly
  // here because the real interleaving is a sub-microsecond window between two
  // syscalls; see test/races.test.mjs for the process-level attempt at it.
  const dir = mkdtempSync(join(tmpdir(), "reserve-"));
  try {
    // `a.txt` taken, `a.txt.part` free -> the loop must skip to `a (1).txt`.
    writeFileSync(join(dir, "a.txt"), "done");
    const chosen = uniquePath(dir, "a.txt", { reserve: true });
    assert.notEqual(chosen, join(dir, "a.txt"), "must never return an occupied final path");
    assert.equal(chosen, join(dir, "a (1).txt"));
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "done", "the completed file is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sanitizeFilename budgets an oversized extension instead of blowing past maxLength", () => {
  // `extname` happily returns 301 bytes for `"a." + "b".repeat(300)`. Trimming
  // only the stem left the total far over the limit — an ENAMETOOLONG at write
  // time, long after the name looked settled.
  const out = sanitizeFilename("a." + "b".repeat(300));
  assert.ok(
    Buffer.byteLength(out, "utf8") <= 255,
    `expected <=255 bytes, got ${Buffer.byteLength(out, "utf8")}`,
  );
});

test("sanitizeFilename reserves room for a caller's suffix", () => {
  const out = sanitizeFilename("x".repeat(400) + ".mp4", { reserveBytes: 20 });
  assert.ok(
    Buffer.byteLength(out, "utf8") <= 235,
    `expected <=235 bytes, got ${Buffer.byteLength(out, "utf8")}`,
  );
  assert.ok(out.endsWith(".mp4"));
});

test("uniquePath leaves room for its own numbering and sidecar suffix", () => {
  // The name uniquePath returns is not the name that reaches the filesystem:
  // a collision appends " (1000)" and reservation appends ".part". A name
  // sanitized to exactly 255 bytes therefore produced a 266-byte sidecar.
  const dir = mkdtempSync(join(tmpdir(), "budget-"));
  try {
    const chosen = uniquePath(dir, "y".repeat(400) + ".mp4", { reserve: true });
    const component = chosen.slice(dir.length + 1);
    const worst = `${component} (1000).part`;
    assert.ok(
      Buffer.byteLength(worst, "utf8") <= 255,
      `worst-case component is ${Buffer.byteLength(worst, "utf8")} bytes: ${worst.slice(0, 40)}…`,
    );
    assert.ok(existsSync(`${chosen}.part`), "the sidecar was actually creatable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
