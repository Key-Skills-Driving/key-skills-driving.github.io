# KS Glovebox

A home-screen app for driving instructors at Key Skills Driving School (called KSDS Lesson Breakdown until v3.12): lesson breakdowns, the review card, practice routes and test routes. Talk through what happened in a lesson and get a professional lesson breakdown (a bare "Covered today" list, then a personal message in the instructor's voice about how it went, then "Focus for next lesson", with no title or date line) that's one tap to copy and send.

- **Break down:** dictate with the iPhone keyboard mic, then tap **Break it down**. With a free Google Gemini key (Settings) it's written right in the app at no cost: Gemini 3.8 Flash on the free tier, falling back to other free Gemini models when one's daily allowance runs out. An OpenAI or Anthropic (Claude) key works too but is paid; Claude runs `claude-opus-5` with adaptive thinking at low effort and server-side fallbacks, dropping either if the chosen model rejects them. Without a key, it copies a ready-made prompt to paste into the ChatGPT or Claude app.
- **Saved:** only the breakdowns you choose to save (tap **Save** under one), plus prewritten ones you add. Tap any of them to copy it.
- **Modify:** on a fresh breakdown or a saved one, tell the AI what to change. It gets your original notes and the current version, and you keep or undo the result. Keeping it also copies it, ready to paste.
- **My style (Settings):** breakdowns are always warm and detailed; each instructor adds a sign-off, free-text instructions, and up to three examples of their own writing. Examples come only from breakdowns the instructor fixed by hand (the app offers to keep their version), never from AI-written or prewritten text. They're sent with each request so the AI matches the voice while the base rules keep it professional; "Tidy me up" vs "Close to how I write" sets how much it polishes. Styles stay on the phone (and in backups); the school server only passes them through, capped.
- **Finished students:** if the notes say the student passed or completed their test, or it was their last lesson, the breakdown leaves out "Focus for next lesson".
- **Wipe App** (Settings) deletes only this app's data, behind a tick box and a confirmation that lists what goes.
- **Inviting a coworker:** Settings > Invite a coworker texts the link and the steps. A new instructor types their first name, taps **Ask to join**, and an admin approves that phone once, from Settings > Manage phones. No keys to pass around. Admins can turn on **Notify me when someone asks to join** (Settings > School AI) to get a push notification; it needs the installed app, not a browser tab. The person waiting also gets a **Text your admin** button that opens Messages with the request typed out.

## The school server (`worker/`)

A Cloudflare Worker (`ksds-lessons`) plus a D1 database holds the school's Gemini key and the list of approved phones, so staff never need a key. It also fetches practice routes for approved phones, with the school's OpenRouteService key (only coordinates are sent), and keeps the school's test routes (`test_routes` table): approved phones list them, admins add and delete them, and `GET /shared/<id>` returns one to anyone holding its random 12-character link. Each phone makes up an id and secret token; the server keeps only a hash. The first phone to tap **Become the admin** claims the school and becomes its one **master admin**; after that only admins can approve, remove or promote phones, or change the school key (which is never sent back to a phone). The master admin can't be removed or demoted by anyone, and only they can pass the role on (**Make master admin** on the Phones screen, behind a tick box and a confirmation). Wipe App is refused on the master admin's phone until the role has been passed on. The server builds the prompt itself (it imports `docs/ai.js`), only answers the app's own origin, allows 200 breakdowns per phone per day, and keeps no lesson text or logs.

Notifications use Web Push (`@block65/webcrypto-web-push`): the VAPID public key is in `wrangler.toml` and `docs/app.js`, the private key is the `VAPID_PRIVATE_KEY` secret. Deploy with `npx wrangler deploy` from `worker/`. For local testing, `wrangler dev` on port 8787 (the app switches to it automatically on localhost) needs `http://localhost:8787` temporarily added to the `connect-src` list in `docs/index.html`.
- **Review:** the school's "Please leave a review" card with a scannable QR code, and a Send button.
- **Routes:** a practice-route maker. Pick a start (the office, or **Here** from the phone's GPS when you're at a student's house), a length (30 min to 2½ hr), the student's level (Beginner keeps off freeways; Test-ready leans toward the office area) and the skills to practice: lefts at lights, unprotected lefts, roundabouts, school zones, lane changes, freeway merging, railroad crossings, quiet streets, parking lots. **Build route** makes a loop back to the start through real spots for those skills, sized to the time, and shows it on a dark map with numbered stops ("3. Roundabout from Price Rd"), the total time and miles. Each stop is checked against the route's own directions (it really turns left there, really goes through that roundabout) and left out if not. **Shuffle** makes a different loop, **Save** keeps it with a name (in backups too), and **Google Maps** / **Apple Maps** (iPhone only) hands it over for voice directions, up to 9 stops. Spots come from OpenStreetMap and can be out of date, so drive a route yourself before using it with a student.
- **Test routes:** the school's routes for road-test days, at the top of the Routes tab on every instructor's phone (a copy stays on the phone for places with no signal). An admin adds one with **Add to test routes** under any route they built or saved, or with **Make one from turns**: type or paste the course one turn per line ("Right on Ray Rd", "Left on Kyrene Rd", …; lines with no street, like "Parallel park on the right", become notes). The app finds where each street meets the next, draws the route, and lists anything to check before saving: a street it can't find (usually a spelling or a name change, like 56th St becoming Priest Dr north of Ray Rd) or a turn that goes the other way on the map. Admins can delete test routes. Anyone can tap **Share route**: it shares a link (by text or any app) that opens just that route on the student's own phone, no app or sign-in needed, with the Google Maps / Apple Maps buttons so they can practice it with a licensed adult before test day. Deleting a test route stops its link working.
- **Private:** everything stays on the phone (IndexedDB). API keys only leave the phone to call Google or OpenAI, and aren't included in backups. Breakdowns never use names (the student is always "the student"). On Gemini's free tier Google may use what's sent to improve its products, so the app suggests leaving last names out of the dictation.
- **Screen stays on** while you dictate, while a breakdown is being written, and while the review card is showing.
- **Reload:** pull down from the top of any screen (the installed app has no browser bar), or tap Reload at the bottom of Settings. It checks for a new version first, so one pull picks up an update.

## Installing

Opening the link on a phone shows a walkthrough until the app is installed. iPhone: **Share → Add to Home Screen** (Apple offers no shorter route), shown as a looping animation of the three taps plus a browser-specific hint about where Share lives. Android: an **Install** button that triggers the browser's own install prompt, with menu instructions as the fallback for browsers that don't offer one. Use the installed app on iPhone, not the Safari tab: iOS keeps their storage separate. On Android the two share storage.

## Development

Plain HTML/CSS/JS with no build step. The site lives in `docs/`.

On every release, bump `VERSION` in `docs/app.js` and `CACHE` in `docs/sw.js` together, or installed phones keep the old files.

`docs/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 (MIT).
`docs/vendor/maplibre/` is [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) 6.14.0 (BSD-3-Clause, license file alongside).

### Route data

The Routes tab never asks a map server for spots. They're prepared ahead of time from OpenStreetMap
(© OpenStreetMap contributors, ODbL) for the school's area, Phoenix and Tempe down to Sun Lakes and over to Queen Creek:

```
python -I tools/route-spots/fetch.py   # downloads the area from the Overpass API (slow; skips cells it already has)
python -I tools/route-spots/build.py   # writes docs/route-spots/*.json
```

Then release as usual. Road routes come from [OpenRouteService](https://openrouteservice.org/) through the school
server, which keeps the key as the `ORS_KEY` secret (`npx wrangler secret put ORS_KEY` from `worker/`). The free key
allows 200 route requests a day for the whole school; one build uses up to 4. Map tiles are
[OpenFreeMap](https://openfreemap.org/)'s free "dark" style.
