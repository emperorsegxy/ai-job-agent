# Review Guide 001: Stop dashboard polling before sign-in (with scan-time fallback)

Repo: emperorsegxy/ai-job-agent (master) | File in scope: src/app/page.tsx (effect at ~153-187)
Status: written BEFORE implementation. "Done" = every MUST item below verified with evidence.

## 1. Problem
The mount effect in page.tsx runs fetchConfig(), refreshAllData(), setInterval(refreshAllData, 10000) and opens EventSource('/api/notifications') for every visitor, signed in or not. On the landing/sign-up screen this wastes 4 requests per 10s plus an open stream.

## 2. Intended behaviour
A. Signed out / auth loading: no timers, no EventSource, no calls to /api/profile, /api/jobs, /api/applications, /api/pipeline/status.
B. On sign-in/sign-up success: fetchConfig() and refreshAllData() run exactly once, EventSource opens.
C. Signed in: dashboard updates via SSE events (existing non-INFO event handler kept) and after user actions (existing refreshAllData() calls untouched).
D. Resync: refreshAllData() runs on EventSource open and reconnect (covers events lost during a drop).
E. Fallback: a 30s refreshAllData() interval runs ONLY while a scan/pipeline is running (from existing pipeline status state) and is cleared as soon as it stops.
F. Sign-out/unmount: EventSource closed, every interval cleared, nothing keeps firing.
G. Notification.requestPermission() (if present in that effect) only runs for signed-in users.

## 3. Scope limits (MUST NOT)
- No changes to API routes, auth-context.tsx, auth-view.tsx, cron-scheduler.ts, NotificationService.
- No change to src/public/app.js (legacy Express dashboard); mention only.
- No new dependencies. No unrelated refactors/formatting churn. Diff should be small and confined to page.tsx.

## 4. Checklist (MUST unless marked SHOULD)
Code
- [ ] 1. Effect early-returns when authLoading || !user.
- [ ] 2. Dependency array is [user?.uid, authLoading] (plus pipeline-running flag for the fallback effect); no stale closure on refreshAllData (stable via useCallback or ref).
- [ ] 3. The 10s setInterval is removed; the only interval is the 30s fallback gated on pipeline-running.
- [ ] 4. Cleanup closes EventSource and clears the fallback interval.
- [ ] 5. refreshAllData() invoked on es.onopen.
- [ ] 6. No duplicate EventSource when user object identity changes but uid is the same.
- [ ] 7. Early returns (auth loading / landing page) stay AFTER all hooks (rules of hooks respected).
- [ ] 8. SHOULD: fallback interval constant named (e.g. SCAN_FALLBACK_REFRESH_MS = 30000).
Behaviour (verify by running the app, browser devtools Network tab)
- [ ] 9. Landing + sign-up form open 60s: zero requests to the 4 endpoints and zero /api/notifications connections.
- [ ] 10. Sign up (or demo-mode sign-in): one burst of the 4 requests, then SSE connected, then idle.
- [ ] 11. Idle signed-in, no scan: no periodic requests over 60s.
- [ ] 12. Start a scan from the dashboard: status indicator turns on; requests repeat every ~30s; stops within one tick after scan ends.
- [ ] 13. Kill/restart the dev server or drop network: on reconnect a refresh fires.
- [ ] 14. Sign out: SSE closed, no further requests.
- [ ] 15. Page reload while signed in: loads data once, no regression in what the dashboard shows.
Quality gates
- [ ] 16. `yarn build` (or npm run build) and type check pass; lint passes with no new warnings.
- [ ] 17. Existing tests pass; if the repo has none for this, state so and rely on items 9-15.
- [ ] 18. Diff reviewed: only page.tsx changed (plus this guide if committed under docs/).
- [ ] 19. PR description lists each checklist item with PASS/FAIL and evidence (command output or request counts).

## 5. Known risks to re-check
- Pipeline run as a separate process (yarn harvest / yarn scheduler): SSE won't deliver; item 12 fallback is the safety net.
- SCAN_COMPLETE is also sent on cron start/pause: make sure the running flag reflects /api/pipeline/status, not just events.

## 6. Done definition
All MUST items PASS with evidence recorded in the PR; any item that could not be verified (e.g. no Firebase credentials for real sign-up) is reported explicitly as NOT VERIFIED with the reason, never silently skipped.
