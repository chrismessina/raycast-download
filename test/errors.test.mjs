import assert from "node:assert/strict";
import { test } from "node:test";

import { DownloadError, isDownloadError, classifyHttpStatus } from "../dist/errors.js";

test("DownloadError carries its code and is a real Error", () => {
  const e = new DownloadError("network", "boom");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "DownloadError");
  assert.equal(e.code, "network");
  assert.equal(e.message, "boom");
});

test("DownloadError preserves cause without the ES2022 constructor", () => {
  // The package targets ES2020, so `super(message, {cause})` is unavailable.
  // The property must still be populated.
  const root = new Error("underlying");
  const e = new DownloadError("tls", "wrapped", { cause: root });
  assert.equal(e.cause, root);
});

test("DownloadError exposes transport detail when supplied", () => {
  const e = new DownloadError("http_server", "500", { httpStatus: 500, exitCode: 22, signal: null });
  assert.equal(e.httpStatus, 500);
  assert.equal(e.exitCode, 22);
  assert.equal(e.signal, null);
});

test("retryable is true for transient conditions", () => {
  for (const code of ["network", "dns", "tls", "timeout", "stalled", "http_server", "rate_limited", "url_expired"]) {
    assert.equal(new DownloadError(code, "x").retryable, true, `${code} should be retryable`);
  }
});

test("retryable is false for conditions needing human intervention", () => {
  // Retrying these in a loop burns quota and never succeeds.
  for (const code of ["cancelled", "auth", "forbidden", "not_found", "disk_full", "permission", "integrity"]) {
    assert.equal(new DownloadError(code, "x").retryable, false, `${code} should NOT be retryable`);
  }
});

test("isDownloadError narrows correctly", () => {
  assert.equal(isDownloadError(new DownloadError("unknown", "x")), true);
  assert.equal(isDownloadError(new Error("plain")), false);
  assert.equal(isDownloadError(null), false);
  assert.equal(isDownloadError("string"), false);
});

test("classifyHttpStatus maps the statuses this API actually returns", () => {
  assert.equal(classifyHttpStatus(401), "auth");
  assert.equal(classifyHttpStatus(403), "forbidden");
  assert.equal(classifyHttpStatus(404), "not_found");
  assert.equal(classifyHttpStatus(429), "rate_limited");
  assert.equal(classifyHttpStatus(500), "http_server");
  assert.equal(classifyHttpStatus(503), "http_server");
});

test("classifyHttpStatus treats 410 Gone as an expired URL", () => {
  // For signed URLs a lapsed signature shows up as 403/410; both recover by
  // re-requesting a fresh URL rather than by telling the user to go fix something.
  assert.equal(classifyHttpStatus(410), "url_expired");
  assert.equal(new DownloadError("url_expired", "x").retryable, true);
});

test("classifyHttpStatus distinguishes client from server errors", () => {
  assert.equal(classifyHttpStatus(422), "http_client");
  assert.equal(classifyHttpStatus(418), "http_client");
  assert.equal(classifyHttpStatus(200), "unknown");
});
