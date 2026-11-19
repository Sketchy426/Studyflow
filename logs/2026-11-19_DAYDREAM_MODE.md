# Daydream replaces Planning mode (2026-11-19)

## What changed for the student

The workspace mode called Planning is now called Daydream. It has the features and the look of the standalone Daydream planner: plans, a checklist per plan and a General checklist, a journal with photos, and plans on the calendar. Everything saved in Planning mode before is still there. Events are plans and to-dos are General checklist items. School and Work are unchanged.

## The rule behind the data shape

A build from before this change can still be open in a tab or cached on a second device, and it can still save. It rewrites `studyflowPlanning` as `{v, todos}` and `studyflowEvents` as the same event objects. So nothing new is stored beside the to-dos, there is no version bump and no migration.

| Thing | Where it lives |
| --- | --- |
| Plan | A `studyflowEvents` record with `mode: "planning"` and optional `type`, `place`, `emoji`. A missing type reads as Event. |
| Checklist item | A `studyflowPlanning` to-do with an optional `planId`. No `planId`, or one whose plan is gone, reads as General. |
| Memory | `studyflowMemories`, a new key: `{id, title, date, mood, text, tags, hasPhoto}`. |
| Photo | IndexedDB `studyflow` / `photos`, key = memory id, value `{blob, orphanedAt?}`. JPEG, 1000px at most. |
| Deleted plan | A `pevent` trash entry whose data is the event plus `todos`. |
| Deleted memory | A `pmemory` trash entry. |

Photos are never deleted on first sight. A photo with no memory and no trash entry gets `orphanedAt`. It is deleted when it is still unreferenced 30 days later, and the mark is cleared when a reference comes back. Delete all data clears the photo store.

The stored mode name stays `planning`. Only display text says Daydream.

## The look

While the mode is on, `<html>` carries `data-theme="daydream"` in place of the student's color design. The design's own CSS rules stop applying and the Daydream palette overrides the design colors with `!important` custom properties. `studyflowColors` is not written. Under the Night design Daydream mode is fully light.

## Known limits

- Photos stay on the device where they were added. Another device shows "This photo is on another device".
- A tab still running the old build drops a `pmemory` trash entry if Restore is pressed there.
- Two open tabs of the new build keep each other's saves. Each listens for the browser's `storage` event and rereads `studyflowEvents`, `studyflowPlanning` and `studyflowMemories` when another tab writes them. Rereading writes nothing, so it starts no account sync.
- A tab opened before the update, still running the old build, holds its own copy of `studyflowEvents` and `studyflowPlanning` and writes the whole key back the next time it saves an event or a to-do. Plans, plan edits and checklist items made in a new tab after that old tab was opened are then lost. This is the app's existing last-writer-wins behavior between tabs, and it ends when the old tab is reloaded or closed. Journal entries and photos are not affected, because the old build never writes `studyflowMemories` or the photo store.
- The old build shows a plan with no date as "Invalid Date" under its Past and All filters. It does not throw.
- 200 memories of 4000 ASCII characters make the synced data 829,142 bytes, measured by the e2e script. The Firestore limit is 1,048,576 bytes and counts UTF-8 bytes, so the same count of non-Latin text would not fit.
- `api/guide.mjs` was not changed. Any mode name the server prompt holds still says Planning.

## Fixed after review

- On a phone the plan form ran past the bottom of the screen and Save could not be reached. Modals in Daydream mode now fit the viewport and scroll.
- A tab opened earlier erased plans and checklist items another tab had added. Two new-build tabs now reread each other's saves (see Known limits for a tab still on the old build).
- Saving a memory with a photo hung when IndexedDB never answered. Photo store calls give up after 4 seconds and the memory is saved without the photo, with a message.
- The color editor in Settings changed the saved design invisibly in Daydream mode. It is replaced there by a line saying Daydream uses its own colors.
- The calendar day list deleted a plan and its checklist in one tap. A plan's row now only opens the plan, whose Delete asks first.
- Checklist checkboxes and delete buttons have 32x32 tap areas at 700px and below.
- The calendar key and day list say Plans and Plan in Daydream mode.

## Also fixed

`window.__mode` is now set before the first `apply()`. Before, the first draw after a reload asked for the mode too early and got School, so Recently deleted was empty after a reload in Work or Planning mode until something redrew it.

## Verification

`node scripts/e2e-planning.js` drives the new build and the build from commit `dd49bba` on one local origin in headless Chrome. It ran three times with all 173 checks passing. The old-client check was shown to catch a real failure: with `place` moved into `studyflowPlanning`, the plan card read "Big Sur" before the old build wrote and "Location TBD" after.

A signed-in Firebase sync was not exercised. The sync path is covered by replacing every `studyflow*` key with an older and then a newer copy and reloading, which is what `useCloud()` does.
