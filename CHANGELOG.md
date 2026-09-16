# Changelog

## 0.1.0

First release.

**Downloads that survive the Raycast window closing.** Raycast unloads a command's process
when the user presses Escape or pops back to root search, and an in-flight stream to disk is
torn down mid-write — leaving a truncated file that looks complete. `no-view` mode does not
help: it runs until its promise resolves, and the promise is the thing doing the downloading.

So the transfer runs in a detached child process that outlives the command and reports through
a status file on disk rather than through memory. `startDownload` returns a ticket; the user
can dismiss Raycast immediately; `watchStatus` picks the transfer back up from any later
command, in any other process.

**The guarantee is stated narrowly on purpose.** It survives Raycast dismissal, the command
being unloaded, and the parent process exiting. It does not survive machine sleep, power loss,
or unattended network drops without user action — detached spawn solves parent-process-exit,
which is the problem Raycast creates, and this is not a download supervisor. Partial files are
always retained, so an interrupted transfer resumes via HTTP Range instead of starting over.

**Two layers, deliberately independent.** Layer A (`status`, `detach`, `curl`) is the
transport, for extensions downloading from a URL. Layer B (`paths`, `errors`, `progress`,
`history`) is useful to any extension that puts a file on disk, however it got the bytes — so
a tool that owns its own transport, like `ipatool`, can consume Layer B without being forced
through a URL-shaped API that does not fit it.

**macOS and Windows.** `curl` ships with both. The supervision around the transfer differs
because the process models genuinely differ: `detached: true` + `unref()` versus `unref()`
alone, `kill(-pid)` on the process group versus `taskkill /T`, and two different ways to ask
the OS for a process's start time. `canVerifyProcessIdentity()` exposes which regime you are
in — and when identity cannot be established, "is it running?" falls back to the runner's
heartbeat while "should I signal this pid?" refuses outright, because guessing wrong about
liveness costs a mislabelled status and guessing wrong about identity kills an unrelated
process tree.

Zero runtime dependencies. `@raycast/api` is a peer, loaded lazily so the runner and the tests
work outside a Raycast host.

### Notes for the first consumers

- **Never put a signed URL in `meta`** — it is persisted to the status file verbatim. Store an
  identifier you can re-resolve from instead. History has an opt-in
  `createDownloadHistory({ urlPolicy: "omit-signed" })`; the default is `"allow"`, which
  persists what you pass.
- **Retry policy is yours.** `DownloadError.retryable` gives you the signal; the loop stays in
  your code, because consumers differ too much to share one.
- **Copy `dist/runner.bundle.js`, not `dist/runner.js`.** A bundled extension that copies the
  plain `tsc` output gets a file that resolves but cannot run — its siblings are gone. The
  bundle has its local graph inlined for exactly this reason.
