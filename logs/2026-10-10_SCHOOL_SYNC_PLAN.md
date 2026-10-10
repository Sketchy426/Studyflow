# School Sync, run 1: Google Classroom import (plan v3)

Source plan: "StudyFlow School Sync Plan" (Claude Docs, 2026-10-10). This run builds its **phases 2 and 3**: a browser-only Google Classroom connection in `template/index.html` that imports on reload while the sign-in pass is valid, and otherwise offers a one-click **Sync now**.

## Run settings

| Setting | Value |
| --- | --- |
| Roster | standard, run in Orca 1.4.224 |
| Planner | Claude Code (claude-opus-5-5), sole implementer |
| Reviewer 1 | DeepSeek V4.1 Flash via OpenCode 1.18.30 (`deepseek/deepseek-flash`), review only |
| Reviewer 2 (third judge) | Codex CLI 0.157.1, review only |
| Branch | `school-sync` (private), base `3be690892d35a804ec5d7263e9b13a579ff8d029` |
| Scratch | `/private/tmp/claude-502/-Users-jianwang-irene-ws/fcf3c760-a6a3-47e7-8167-69c16bfd36bf/scratchpad/fleet` |
| Implementation paths | `template/index.html` |
| Record paths | `logs/2026-10-10_SCHOOL_SYNC_PLAN.md`, `logs/README.md` |

The whole change lives in one file, so per Step 5 the planner edits it alone and both other seats review the plan and the diff. Nothing is pushed or merged to `main` in this run.

## Scope

**In:** Classroom connect, import, sync on reload, Sync now, disconnect, status line, the Settings UI for them, and the small fixes imported data needs (tasks with no due date).

**Out (later runs, after the user's checks):** hosting the site, the user's Google Cloud setup, the Cloudflare Worker (phase 4), Schoology calendar feed (phase 5), Google verification (phase 6). The Settings card keeps Schoology as "Planned" with one line saying it needs the server.

The user has not yet run the doc's three checks (hosting, school allows outside apps, Schoology feed). This run's code is still useful either way: it is inert until a client ID is entered, and can be tested with mocks.

## Design

**Sign-in.** Google Identity Services token model. `https://accounts.google.com/gsi/client` is loaded only when a client ID exists: eagerly on page load if one is saved, and right after one is saved. It is never awaited inside a Connect or Sync now click, so the click's user activation is still fresh when `requestAccessToken` runs; if the script isn't ready yet, the button stays disabled with "Loading Google sign-in…". `google.accounts.oauth2.initTokenClient({client_id, scope, callback, error_callback})`. Scopes, read-only only:
- `https://www.googleapis.com/auth/classroom.courses.readonly`
- `https://www.googleapis.com/auth/classroom.coursework.me.readonly`

The access token and its expiry (`Date.now() + expires_in*1000` from the token response; about 1 hour) are stored in **sessionStorage** (`studyflowGcToken`), never localStorage, so it is not in backups and dies with the tab. The client ID (public by design) and a `connected` flag go in localStorage (`studyflowClassroom`).

**When it syncs.**
1. Connect button (user click) → `requestAccessToken({prompt:'consent'})` → import.
2. Page load, connected, token unexpired (> 60 s left) → import automatically, no popup.
3. Page load, connected, token expired or missing → no popup; status says "Sign-in expired"; **Sync now** button (user click) → `requestAccessToken({prompt:''})` → import.

**API calls** (`fetch` with `Authorization: Bearer`, `https://classroom.googleapis.com/v1`), following `nextPageToken`:
- `GET /courses?studentId=me&courseStates=ACTIVE&pageSize=100`
- per course `GET /courses/{id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`
- per course `GET /courses/{id}/courseWork/-/studentSubmissions?userId=me&pageSize=100`

Courses are fetched in sequence (no burst of parallel calls). Probes assert the exact request URLs, since mocked `fetch` would otherwise hide a wrong path.

**Sync lifecycle (fetch first, merge once).**
1. A `syncing` flag blocks overlapping syncs; the Sync now button is disabled while it is set.
2. A generation counter `gen` increments on disconnect, client-ID change and Remove imported items. Every awaited step and every token callback checks that `gen` is unchanged; a stale continuation stops without touching anything.
3. Fetching builds a **remote snapshot** only (courses → per-course coursework and submissions). Live `classes`/`tasks` are never mutated while requests are pending, so `render()`/save calls from navigation in the meantime are harmless.
4. Failure rules: an error on any `/courses` page, a 401 anywhere, or a network failure aborts the whole sync with **no** merge. An error (403/404/5xx) on one course's coursework or submissions pages marks only that course as skipped: its remote data is discarded and its saved local copy is left exactly as it was.
5. After fetching finishes and `gen` still matches, one **synchronous merge** applies the snapshot to the *current* arrays (so local edits made during the fetch are kept), then calls `render()` once.

**Mapping (upsert by Google id, never delete local items).**

| Classroom | StudyFlow | Rule |
| --- | --- | --- |
| Course | `classes[]` item `{id:<number>, gcId, name, teacher: section or "Google Classroom", icon:'G', grades:[], source:'classroom'}` | Match on `gcId`. Ids stay numbers because existing code compares with `+id`. New id = `Date.now()+n`, checked unique. Existing name/icon edits by the user are kept; only `name` updates if the user hasn't renamed it (track `gcName`). |
| CourseWork | `tasks[]` item `{id:<number>, gcId, title, classId, type, due, points, priority:'Medium', done, source:'classroom'}` | `type` (case-insensitive, existing task types only): quiz/test/exam/midterm/final → `Test`, project → `Project`, homework/hw → `Homework`, else `Assignment`. `due`: `dueDate` (+`dueTime`, UTC) converted to the **local** date; `''` when absent. On re-sync: title, due, points, classId update; `priority` is the user's; `done = local.done || remoteDone`. |
| Submission state `TURNED_IN` or `RETURNED` | task `done: true` | Never un-done a task the user ticked. |
| Submission `RETURNED` with a valid grade | `class.grades[]` item `{id:<number>, gcId:<courseWork id>, title, type, score, total, date, source:'classroom'}` | Valid = `Number.isFinite(assignedGrade)` (0 allowed) **and** `Number.isFinite(maxPoints) && maxPoints > 0`; otherwise no grade row. `type` uses the calculator's existing set: quiz → `Quiz`, test/exam/midterm/final → `Test`, project → `Project`, homework/hw → `Homework`, else `Assignment`. `date` = local `YYYY-MM-DD` from the submission's `updateTime`, else the coursework's `updateTime`, else today. Upsert by `gcId` keeps the existing numeric `id`; a changed returned grade updates `score`/`total`/`date`. Feeds Grade Tracker, calculator and GPA. |

After import: `render()` (which already saves), toast "Synced: N new classes, N new assignments, N grades updated", status "Last synced <time>".

**Errors.** 401 → clear the token, status "Sign-in expired", show Sync now. 403 on `/courses` → status "Google blocked access. Your school may not allow StudyFlow yet, or the Classroom API isn't enabled in your Google Cloud project." Network failure or blocked script → "Couldn't reach Google. Showing your last saved copy." In every error case local data is untouched.

**Disconnect.** Bump `gen`; call `google.accounts.oauth2.revoke(token)` only when a token exists **and** the GIS script is loaded; clear the token and `connected`. Imported items stay.

**Remove imported items** (two-tap confirm). It **also disconnects**: it bumps `gen`, revokes (same guard) and clears the token and `connected`, so a later reload cannot re-import what was just removed. Then:
- Delete tasks with `source:'classroom'` and grade rows with `source:'classroom'`.
- An imported class is deleted only if nothing local still uses it: no remaining grades, no non-imported tasks with its `classId`, and no flashcard deck with its `classId` (all compared as numbers). Otherwise the class stays and loses `gcId`, `gcName` and `source`, becoming a normal local class, so manual grades, tasks and decks keep their class.

**Status copy.** The Settings status line includes: "Imported items you delete come back on the next sync. Use Remove imported items to clear them all." 

**Fixes needed for imported data.**
- `dueLabel(t)`: return `'No due date'` when `!t.due` (today it would say "Overdue").
- The four `a.due.localeCompare(b.due)` sorts use `dueKey(t)` = `t.due || '9999-12-31'` so undated work sorts last.
- Assignment list shows a small `Classroom` tag on imported items.

**Escaping.** All imported strings render through the existing `safe()`; the new Settings UI also uses `safe()` / `textContent`. No `innerHTML` with raw API strings.

**Settings UI** (in the existing School connections card, Google Classroom tile): client ID field with one help line, Connect / Sync now / Disconnect / Remove imported items, and a status line. Schoology tile: "Planned: needs the small server (phase 5)".

## Tasks

| # | Owner | Task | Acceptance check |
| --- | --- | --- | --- |
| 1 | planner | Due-date fixes: `dueKey`, `dueLabel` no-date case, the 4 sorts, Classroom tag | P7, P8 |
| 2 | planner | Classroom module: token handling, GIS loader, API client with paging, mapping/upsert, errors | P2, P3, P5, P6 |
| 3 | planner | Sync on load / Sync now / disconnect / remove imported | P4, P5 |
| 4 | planner | Settings UI in the School connections card | P1, P9 |

## Probes (headless Chrome, mocked `google.accounts.oauth2` and `fetch`; results written into the page title)

- **P1** No client ID: Connect is disabled and the help line shows.
- **P2** Connect with a fixture (2 courses, courses and coursework each split over **2 pages**; coursework with and without due dates, one with `dueTime` crossing midnight UTC; titles with Quiz/Exam/HW; submissions `TURNED_IN`, `RETURNED` with grade, `RETURNED` with grade 0, `RETURNED` with missing `maxPoints`, `RETURNED` with `maxPoints` 0, `NEW`): exact request URLs, counts and fields of imported classes, tasks, grades (grade 0 imported; missing/zero max points skipped; dates are `YYYY-MM-DD`).
- **P3** Second sync with a changed returned grade: no duplicates; grade row keeps its id and gets the new score; a user-changed priority and a user-ticked done survive. With Test weight 100% and other weights 0, an Exam grade counts toward the class percent.
- **P4** Reload with an unexpired token in sessionStorage: import runs with no popup call. With an expired token: no import, no popup call, Sync now visible.
- **P5** 401 clears the token and shows Sync now; 403 on `/courses` shows the blocked message; failure on the second `/courses` page aborts with no change; a 500 on one course's second coursework page skips only that course (its saved items unchanged) while the other course merges. Local data otherwise unchanged in every case.
- **P5b** Concurrency. Each case starts from seeded saved data: one earlier imported class with an imported task and grade, plus a manual task, a manual grade and a flashcard deck on that class.
    - A local edit (priority change, new manual task) made while fetches are pending survives the merge.
    - A second Sync while one is running makes no new requests.
    - **Disconnect while a response is pending:** after the late response arrives, every saved item (imported and manual) equals the seeded state, the token is gone, `connected` is false, and no merge happened.
    - **Remove imported items while a response is pending:** after the late response arrives, imported tasks and grades are gone, manual items are intact under the P9 rules, the token is gone, `connected` is false, and nothing was re-imported.
- **P6** A course name and a coursework title of `<img src=x onerror=alert(1)>` render as text in My Classes, Assignments, Dashboard (upcoming work and class overview), Grade Tracker (averages, history, calculator, GPA) and Settings; no `img` element is created.
- **P7** An undated task shows "No due date", sorts after dated ones, and is not counted as overdue.
- **P8** Regression: sample data still gives GPA 3.33, data persists across reload, Secret Room and Focus switches still work.
- **P9** Disconnect calls revoke and clears the token; with the GIS script never loaded it clears the token without calling revoke. Remove imported items deletes imported tasks and grades only; an imported class holding a manual grade, a manual task and a flashcard deck survives as a local class with all three intact; an imported class with nothing local is deleted.

## Round-1 objections → changes

| Objection (who) | Change |
| --- | --- |
| 1. Grade validity, date, id and fixtures (Codex) | Mapping grade row: finite `assignedGrade` (0 allowed), finite `maxPoints > 0`, `YYYY-MM-DD` date with fallbacks, id kept on upsert, `source` marker. P2/P3 fixtures added. |
| 2. `Exam` not an existing type (Codex); task type set (DeepSeek NB6) | Case-insensitive mapping onto existing sets: tasks Homework/Assignment/Test/Project, grades add Quiz; exam → Test. P3 weight check. |
| 3. Remove imported deletes manual content (Codex) | Remove only imported tasks/grades; keep a class still used by local grades, tasks or decks, stripping its Classroom metadata. P9 extended. |
| 4. Commit and cancellation boundaries (Codex) | New "Sync lifecycle" section: remote snapshot, one synchronous merge, per-course skip, `syncing` flag, `gen` counter. New P5 cases and P5b. |
| Paging not probed (DeepSeek NB1) | P2 fixture has 2 pages for courses and coursework. |
| Grade date format (DeepSeek NB2) | Covered by objection 1. |
| `expires_in` capture (DeepSeek NB3) | Stated in Sign-in. |
| `courseWork/-` wildcard and URL check (DeepSeek NB4) | Probes assert exact URLs. The wildcard is documented by Google for `studentSubmissions.list`; a live check needs the user's client ID and is listed for the user's first real sync. |
| Revoke guard (DeepSeek NB5) | Disconnect calls revoke only when the GIS script is loaded. P9 case added. |

## Round-2 objections → changes

| Objection (who) | Change |
| --- | --- |
| P5b contradicts Disconnect keeping imported items; removal's token behaviour unspecified (Codex) | Chose: Remove imported items also disconnects. P5b split into separate Disconnect and Remove cases, both starting from seeded imported and manual data, with exact expected end states. |
| GIS script load timing vs user activation (DeepSeek NB1) | Sign-in: loaded eagerly when a client ID exists, never awaited inside a click; buttons disabled until ready. |
| P6 coverage (DeepSeek NB2) | P6 covers Dashboard and Grade Tracker too. |
| Deleted imported items reappear (DeepSeek NB3) | Status copy line added. |
| Numeric `classId` compare; strip `gcName` (DeepSeek NB4) | Stated in Remove imported items. |
| Wildcard needs a live check (DeepSeek NB5) | Kept as a user acceptance item: the first real sync with the user's client ID confirms `courseWork/-/studentSubmissions` returns submissions. |

Round 3 was sent before these edits were saved (a planner script error); both seats correctly rejected the unchanged v2 file. This table and v3 are what round 4 reviews.

## Review record

Round 1: DeepSeek PLAN-APPROVED (6 non-blocking), Codex PLAN-REJECTED (4 blocking). Planner approval of v1 superseded.

Round 2: DeepSeek PLAN-APPROVED (5 non-blocking), Codex PLAN-REJECTED (1 blocking). Round 3: both PLAN-REJECTED because the file was still v2. Planner approval of v2 superseded.

PLANNER (claude): PLAN-APPROVED (plan v3)

## Outcome

**Plan gate:** 4 rounds. v1: DeepSeek approved, Codex rejected (grade validity, `Exam` type, removal deleting manual content, sync commit/cancel boundaries). v2: DeepSeek approved, Codex rejected (P5b contradicted Disconnect). Round 3 reviewed a stale file because a planner edit script failed; both rejected it correctly. v3 (round 4): all three approved.

**Code gate:** 2 rounds against base `3be6908`.
- Round 1 (revision `e927320`): DeepSeek approved with 6 non-blocking notes; Codex rejected with 2 defects it reproduced in a Node VM: OAuth callbacks not bound to their sign-in attempt (a late callback from an old client ID could be accepted), and silent partial snapshots at the 50-page limit.
- Fixes: a token client per attempt, with callbacks bound to `(gen, attempt)` and duplicate sign-ins blocked; the page limit is an error that aborts (`/courses`) or skips one course. DeepSeek notes 1-4 and 6 folded in; note 5 declined with a reason.
- Round 2 (revision `4f9727857721f10ab97ee759e3eabc4825d1f920`): all three approved.

**Probes:** 24 headless pages (P1-P11 plus splits), all PASS with TZ=America/New_York. Negative controls, each run on a deliberately broken copy: removing the "No due date" fix fails P7; removing the stale-generation checks fails P5f and P5g; making the attempt check always true fails P10a-P10c; breaking out of the page loop fails P11.

**What each seat caught:** Codex found every blocking defect (6 in the plan, 2 in code), several by running the real module. DeepSeek checked compatibility with the existing code line by line and contributed most of the hardening folded into v3 and code round 2.

**Follow-ups (not in this diff; DeepSeek round-2 non-blocking):**
1. Wrap `client.requestAccessToken` so a synchronous throw clears the pending sign-in immediately.
2. Fold the 2-minute timeout into `current()` so a very late success from an abandoned popup is ignored.
3. Guard `hasGrantedAllScopes` with try/catch.
4. Probes for the per-course page-limit skip and for a client-ID change during a running sync.

**User acceptance item:** the first real sync with the user's own client ID confirms Google accepts `courseWork/-/studentSubmissions` and the scopes on a school account.

### Final verdicts (plan v3; diff revision 4f97278, base 3be6908)

- DeepSeek V4.1 Flash: PLAN-APPROVED (round 4); IMPL-APPROVED (code round 2)
- Codex (GPT-6-Astra, codex-cli 0.157.1): PLAN-APPROVED (round 4); IMPL-APPROVED (code round 2)
- PLANNER (claude): IMPL-APPROVED (diff revision 4f9727857721f10ab97ee759e3eabc4825d1f920, base 3be690892d35a804ec5d7263e9b13a579ff8d029)
