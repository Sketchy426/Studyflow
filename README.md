# StudyFlow

A study planner for students: classes, assignments, calendar, grades, GPA, flashcards, a focus timer, and import from Google Classroom and Schoology. It is a single static HTML file with no build step, and it saves everything in the browser (localStorage).

- **Live site (main):** https://studyflow-one-pi.vercel.app/ (Vercel; every push to `main` redeploys in about a minute)
- **Mirror:** https://sketchy426.github.io/Studyflow/ (GitHub Pages, also built from `main`)

The two sites keep separate saved data, because browser storage belongs to one web address. To move data between them, use **Settings → Backup**, then **Restore** on the other site.

## Status (last updated 2026-10-17)

| Area | State |
|---|---|
| App at the site root (`index.html`) | Live on both sites |
| Dashboard, My Classes, Assignments, Calendar, Study Planner | Done |
| Grade tracker: category weights, grade calculator (add/delete), GPA out of 4 (plus/minus or simple scale) | Done |
| Due-soon alert on the dashboard | Done |
| Flashcards, focus timer (on/off in Settings), color editing | Done |
| Save everything, Backup / Restore / Reset in Settings | Done |
| Secret Room (hidden: click the "Features" heading 5 times, then turn it on in Settings) with Cookie Clicker, Memory Match, Math Sprint, Wordle, Typing Speed | Done |
| Graduation-hat logo goes back to the Dashboard | Done |
| **Google Classroom sync** (classes, assignments, due dates, returned grades; read-only; token in sessionStorage only) | Done, and the user reports it works |
| **Schoology import** from the personal calendar feed, on every page load, through the built-in relay `api/schoology.mjs` | Built and the relay is live; **not yet tested with a real Schoology feed link** |
| Schoology `.ics` file import (one-time, no relay needed) | Done |
| Easier Schoology setup: step-by-step guide, Paste button, connects as soon as a valid feed link is pasted (or Enter), explains a wrong link (e.g. the calendar page address), relay field under "Advanced" | Done (tested with a mocked relay) |
| **Schoology grades import**: paste the Grades page (Grades → Import from Schoology). Imports the current grading period's scores and category weights, creates or matches classes by course name, and averages by points per category like Schoology does. Calendar-feed assignments whose title is on a course's Grades page are filed into that course | Done; averages match Schoology exactly for 3 real courses (Algebra 95.72, Science 91.18, Chinese 96) |
| Calendar shows assignment names as colored chips (homework, quiz, test, project; click a color in the key to change it, saved as `studyflowCalColors`), finished work faded, and a list for the clicked day; on phones the chips become colored bars and the page no longer runs off the right edge. Grade import also adds upcoming ungraded assignments to the calendar and ticks off graded ones (the feed adopts them, no duplicates) | Done (tested with mocked data) |
| Assignments page shows only work due in the next 7 days by default (plus overdue unfinished work). The first filter lets the student choose today, 3 days, 7 days, 2 weeks, 30 days, "Choose my own…" (any number of days, saved as `studyflowDueDays`) or all dates; a "Show all dates" link switches to everything. The choice is saved as `studyflowDueFilter` | Done |
| Overdue assignments sit in their own collapsible "Overdue" section at the top of Assignments, with checkboxes, Select all, Mark done and Delete (tap twice). Open/closed is saved as `studyflowOverdueOpen` | Done |
| Installable app (PWA): `manifest.webmanifest`, offline service worker `sw.js`, icons in `icons/`, "Install the app" card in Settings | Done locally; not yet tested on a real phone or with Google sign-in inside the installed app |

## To do

1. **Finish connecting Schoology.** In Schoology open **Calendar → Export** and copy the `webcal://…/calendar/feed/ical/…/ical.ics` link. The calendar page address (`…/calendar/<number>/<month>`) is not the export link. In StudyFlow go to **Settings → School connections → Schoology**, paste the link (or press **Paste**); it connects by itself. Keep the link private.
2. **Check Schoology class matching** after the first real sync. Importing grades first files feed assignments by title; anything left in the "Schoology" class didn't match. An assignment goes into the class whose name appears in the event text; otherwise it goes into a "Schoology" class. If many land in "Schoology", look at one event from the downloaded `.ics` file (with personal details removed) and adjust `classFor()` in `index.html`.
3. If Schoology **Export is turned off** at the school, use **Import .ics file** instead, or ask the school.
4. Google Classroom hardening (follow-ups from the review in `logs/2026-10-10_SCHOOL_SYNC_PLAN.md`):
   - Wrap `client.requestAccessToken` so a synchronous throw clears the pending sign-in.
   - Fold the 2-minute sign-in timeout into `current()` so a very late popup answer is ignored.
   - Guard `hasGrantedAllScopes` with try/catch.
   - Add tests for the per-course page-limit skip and for a client-ID change during a running sync.
5. Google Cloud project is in **Testing** mode: only listed test users can sign in. To let other students use it, add them as test users or publish the app (Google verification).
6. Optional clean-up: delete `old.html` (the original simple site) and `template/index.html` (a redirect to `/`) when they are no longer needed.

## Files

| Path | What it is |
|---|---|
| `index.html` | **The app. Edit this file.** All features are inline scripts in this one file. |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable app: name and icons, and the service worker that lets it open offline. Bump `VERSION` in `sw.js` when the list of app files changes. |
| `api/schoology.mjs` | Vercel Function: the Schoology relay at `/api/schoology`. It only fetches Schoology calendar feed links and only answers the two StudyFlow sites. |
| `worker/schoology-relay.js` | The same relay as a Cloudflare Worker, for anyone hosting StudyFlow somewhere without functions. |
| `old.html` | The original StudyFlow page, kept for reference. |
| `template/index.html` | Redirect so old `/template/` links still work. Don't edit. |
| `logs/` | Plans and review records (`2026-10-10_SCHOOL_SYNC_PLAN.md` is the school-sync plan and review). |

### Where data is saved (browser localStorage keys)

`studyflowData` (classes, tasks, sessions, name), `studyflowColors`, `studyflowFlashcards`, `studyflowFocus`, `studyflowFocusEnabled`, `studyflowSecretEnabled`, `studyflowGames`, `studyflowWordle`, `studyflowTyping`, `studyflowGpaScale`, `studyflowLastBackup`, `studyflowClassroom` (client ID and connection state), `studyflowSchoology` (feed link and connection state). The Google access token is in sessionStorage (`studyflowGcToken`) and is never saved permanently.

### If the allowed site addresses change

If the Vercel address changes, update `ALLOWED_ORIGINS` in `api/schoology.mjs` (and `worker/schoology-relay.js`), `DEFAULT_RELAY` in `index.html`, and the **Authorized JavaScript origins** of the Google OAuth client in Google Cloud.

## Rules this project keeps

- StudyFlow never asks for a school password. Google sign-in happens on Google's own page; Schoology uses only the private calendar feed link.
- School data is read-only: StudyFlow never turns in, edits or deletes anything in Classroom or Schoology.
- No proxies or tools to get around the school's web filter (Blocksi), and no self-hosted copies of copyrighted games.
- Treat the Schoology feed link like a password; never commit it or paste it in issues.

## Resume prompt

Paste this into Claude Code (opened in this repo) to pick up where we left off:

```text
I'm continuing work on StudyFlow (this repo, github.com/Sketchy426/Studyflow).
Read README.md first: the "Status" and "To do" sections say what is done and what is next.
The app is the single file index.html (no build). The Schoology relay is api/schoology.mjs
(Vercel Function); the Cloudflare copy is worker/schoology-relay.js. Live site:
https://studyflow-one-pi.vercel.app/ (auto-deploys from main); mirror: GitHub Pages.
Keep the existing design and code style, keep the rules in README.md, test changes in a
browser (headless Chrome with mocked fetch is fine), then commit and push to main.
When something changes, update the Status and To do sections of README.md.
Today I want to: <describe what you want next>
```
