import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, formatSpeed, formatEta, formatProgressLine, createThrottle } from "../dist/progress.js";

// ─── formatBytes ─────────────────────────────────────────────────────────────

test("formatBytes uses human units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(383713905), "365.9 MB"); // a real Fathom recording
});

test("formatBytes handles absent or nonsense input without printing NaN", () => {
  // These reach the UI. "NaN undefined" in a toast is worse than a dash.
  assert.equal(formatBytes(undefined), "—");
  assert.equal(formatBytes(NaN), "—");
  assert.equal(formatBytes(-1), "—");
});

// ─── formatSpeed ─────────────────────────────────────────────────────────────

test("formatSpeed appends a rate suffix", () => {
  assert.equal(formatSpeed(1024 * 1024), "1.0 MB/s");
  assert.equal(formatSpeed(0), "—");
  assert.equal(formatSpeed(undefined), "—");
});

// ─── formatEta ───────────────────────────────────────────────────────────────

test("formatEta renders compact durations", () => {
  assert.equal(formatEta(45), "45s");
  assert.equal(formatEta(90), "1m 30s");
  assert.equal(formatEta(3661), "1h 1m");
});

test("formatEta refuses to render unknown or absurd values", () => {
  assert.equal(formatEta(undefined), "—");
  assert.equal(formatEta(0), "—");
  assert.equal(formatEta(-5), "—");
  // curl reports a wild ETA in the first moments; don't show "in 68 years".
  assert.equal(formatEta(60 * 60 * 48), "—");
});

// ─── formatProgressLine ──────────────────────────────────────────────────────

test("formatProgressLine shows percent when the total is known", () => {
  // Exactly half of a real Fathom recording's 383,713,905 bytes.
  const line = formatProgressLine({ bytesDownloaded: 383713905 / 2, totalBytes: 383713905 });
  assert.match(line, /50%/);
  assert.match(line, /183\.0 MB \/ 365\.9 MB/);
});

test("formatProgressLine floors the percent rather than rounding up", () => {
  // 191856952 / 383713905 = 49.9997%. Rounding to "50%" would claim a half-done
  // transfer is further along than it is; floor never overstates progress.
  const line = formatProgressLine({ bytesDownloaded: 191856952, totalBytes: 383713905 });
  assert.match(line, /49%/);
});

test("formatProgressLine degrades gracefully when the total is unknown", () => {
  // No content-length: report what we have rather than a fake percentage.
  const line = formatProgressLine({ bytesDownloaded: 1048576 });
  assert.ok(!line.includes("%"), `should not invent a percent: ${line}`);
  assert.match(line, /1\.0 MB/);
});

test("formatProgressLine appends speed and ETA only when meaningful", () => {
  const withRate = formatProgressLine({
    bytesDownloaded: 1048576,
    totalBytes: 2097152,
    speedBytesPerSec: 524288,
    etaSeconds: 2,
  });
  assert.match(withRate, /512\.0 KB\/s/);
  assert.match(withRate, /2s/);

  const withoutRate = formatProgressLine({ bytesDownloaded: 1048576, totalBytes: 2097152 });
  assert.ok(!withoutRate.includes("/s"), `no speed expected: ${withoutRate}`);
  assert.ok(!withoutRate.includes("—"), `should omit rather than show dashes: ${withoutRate}`);
});

test("formatProgressLine clamps a percent that would exceed 100", () => {
  // Resumed transfers can report more bytes than content-length for the range.
  const line = formatProgressLine({ bytesDownloaded: 200, totalBytes: 100 });
  assert.match(line, /100%/);
});

// ─── createThrottle ──────────────────────────────────────────────────────────

test("createThrottle runs the first call immediately", () => {
  const throttle = createThrottle(1000);
  let calls = 0;
  throttle("k", () => calls++);
  assert.equal(calls, 1);
});

test("createThrottle suppresses rapid repeats for the same key", () => {
  // A 350MB download fires tens of thousands of progress events; without this
  // every one becomes a Raycast UI update.
  const throttle = createThrottle(10_000);
  let calls = 0;
  for (let i = 0; i < 100; i++) throttle("k", () => calls++);
  assert.equal(calls, 1);
});

test("createThrottle tracks keys independently", () => {
  const throttle = createThrottle(10_000);
  let a = 0;
  let b = 0;
  throttle("a", () => a++);
  throttle("b", () => b++);
  throttle("a", () => a++);
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("createThrottle allows the call again once the interval elapses", async () => {
  const throttle = createThrottle(20);
  let calls = 0;
  throttle("k", () => calls++);
  await new Promise((r) => setTimeout(r, 40));
  throttle("k", () => calls++);
  assert.equal(calls, 2);
});

test("createThrottle returns the callback's value when it runs", () => {
  const throttle = createThrottle(10_000);
  assert.equal(
    throttle("k", () => "ran"),
    "ran",
  );
  assert.equal(
    throttle("k", () => "ran"),
    undefined,
  );
});
