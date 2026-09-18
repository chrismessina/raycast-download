# Changelog

## 0.1.3

**`partialUnsafe` on `DownloadStatus`: a machine-checkable "do not resume this file".**

0.1.2 added the case but not a way to detect it. When the runner writes a redirect body
into the partial and can then neither truncate it back nor delete it, the bytes on disk
must not be resumed — `curl -C -` would append the real download after the HTML. That was
only ever expressed as a sentence glued onto `error.message` and a `bytesDownloaded: 0`,
neither of which a consumer can branch on: zero also means an empty response and a failed
setup.

The flag is deliberately NOT a new error code and does not change the existing one. They
answer different questions: `error.code` is why THIS attempt failed (`http_client`, with
`httpStatus: 302`), `partialUnsafe` is whether the bytes on disk may be reused. A 304
against a resumed transfer proves they are independent — it fails while leaving a
perfectly valid partial behind.

Additive and optional, so no `schema` bump: the reader already accepts unknown fields. It
IS validated as a boolean when present, because a malformed value would otherwise read as
falsy and report a contaminated partial as safe.

**Absence is not proof of safety.** A runner from 0.1.2 or earlier cannot set this field,
so a status it wrote is silent on the question. That is unavoidable for any new signal.

**A rejected spawn no longer crashes the host command.** `spawn` reports ENOENT, EACCES and
EMFILE on the child's `error` event, asynchronously — the existing `pid === undefined`
check only ever caught the synchronous case. An `error` event with no listener is thrown
by EventEmitter, and it fires after `startDownload` has usually already resolved, so it
landed in the Raycast host rather than in the caller's `catch`. Measured on Node 22:
spawning a nonexistent executable returns `pid === undefined` AND emits `error: ENOENT` a
tick later, so both halves fire.

The listener is therefore attached before `child.pid` is inspected. With a pid, the
failure is reported the way every other runner failure is — a terminal `failed` status
with code `runner_failed`, which the watcher the caller already attached will see. Without
one there is no ticket and no valid status to write, so the thrown `DownloadError` stays
the whole contract.

**A redirect body that cannot be deleted is now flagged on a first attempt too.** 0.1.3's
first cut only set `partialUnsafe` when the transfer was resuming. On an initial download
the contaminated partial was discarded best-effort and the outcome ignored, so a denied
delete left redirect HTML on disk with nothing recording it — and `resume` defaults to
true, so the next attempt appended the real download to it. Same corruption the flag
exists to prevent, one path over.

**A malformed `partialUnsafe` is coerced to `true`, not used to reject the status.**
Reading it as falsy would report a contaminated partial as safe; rejecting the whole file
would make a live download invisible to `watchStatus` and un-cancellable through
`killDownload`. It is the only field treated this way — it is advisory, where every other
validated field is structural.

**README gains a quick-start recipe** for driving a toast and preference-gated console
logs from one `watchStatus` handler set, including the two things consumers get wrong —
logging the URL instead of the typed error code, and omitting `onAbandoned`, which leaves
a toast animating forever when the runner dies without recording an outcome.

## 0.1.2

**A rollback that cannot be verified now discards the partial instead of trusting it.**

After an unfollowed 3xx, curl has written the redirect BODY into the `.part`
file. On a resumed transfer the bytes before it are the user's real progress, so
the runner rolls the file back to that length rather than discarding it.

That rollback swallowed its own failure, with the note "the worst case is a
partial that a later resume rejects". That was an assumption about the consumer,
and a false one: consumers accept any non-empty partial. So if the truncate did
not land, the redirect HTML stayed on disk, and the next `curl -C -` appended the
real recording after it and published a corrupt file under the user's filename —
the same silent corruption that refusing to treat a 3xx as success exists to
prevent, arrived at one step later.

`rollbackPartial(partPath, keepBytes)` replaces it: it truncates, **verifies the
resulting size**, and returns false if it cannot vouch for the length — discarding
the partial in that case, so nothing can be appended to bytes we do not trust.
Verifying matters because a truncate that throws is obvious while one that leaves
the file longer than asked is not, and only the second corrupts the next resume.

`rollbackPartial` binds every step to one open file descriptor rather than
operating by pathname, so another attempt replacing the file mid-sequence cannot
have its healthy partial truncated or deleted. `keepBytes` is validated before
anything destructive runs — it is a caller-supplied number on an exported
function, and a negative value would otherwise turn bad input into deleted
progress.

When the partial cannot be deleted either, the runner records that in the status
(`bytesDownloaded: 0` and an explicit message) so consumers refuse to resume that
path. Nothing on disk can be fixed in that case, so the status is the mitigation.

Exported, so a consumer can use the same rollback rather than re-implementing it.

**Behaviour change:** the README previously promised partial files are always
retained. They are not, in this one case — see "Scope of the guarantee".

## 0.1.1

**`followRedirects` now actually works, and an unfollowed redirect is a failure.**

`buildCurlConfig` accepted and honored `followRedirects`, but nothing could reach it:
neither `StartDownloadOptions` nor the runner payload carried the field, so every
detached download followed redirects and the documented option was dead config. It is
now plumbed end to end (default unchanged: `true`).

Making it reachable exposed the reason it mattered. The runner's success predicate
treated any 3xx as success, so with redirects off curl wrote the redirect BODY to the
`.part` file, exited 0, reported 302 — and the stub was renamed to the user's expected
filename and published as a completed download.

**Success is now strictly 2xx, whatever `followRedirects` says.** `--location` only
follows a response carrying a usable `Location`, so a 304 (the caller sent a conditional
header) or a 300 is still the final status with redirects fully enabled — and a 304
writes no body at all, which on a resumed transfer would have published the existing
partial as if it were whole. When a transfer genuinely succeeds behind redirects, curl
reports the 2xx of the final hop, so nothing legitimate is rejected.

`classifyCurlFailure` gained a 3xx branch (`http_client`, non-retryable), worded for the
case at hand — unchanged (304), redirects disabled, or a redirect that could not be
followed. Previously an unfollowed redirect fell through to "Download failed (curl exit
0)." and a 304 surfaced as an ENOENT on the rename. The branch is gated on a clean curl
exit so a redirect loop keeps its own "Too many redirects" (exit 47).

Whatever a 3xx wrote into the `.part` file is rolled back — deleted outright when the
attempt started from nothing, truncated back to the pre-attempt byte count when it was
resuming. A redirect body is not resumable content, and a later retry would otherwise
have `continue-at`-ed past the HTML and spliced the real file onto it.

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

Zero runtime dependencies. `@raycast/api` is a peer accepting `^1.0.0 || ^2.0.0`, loaded lazily
so the runner and the tests work outside a Raycast host. The suite is run against v2.

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
