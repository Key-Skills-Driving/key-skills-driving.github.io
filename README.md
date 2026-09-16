# KSDS Lesson Breakdown

A home-screen app for driving instructors at Key Skills Driving School. Talk through what happened in a lesson and get a professional lesson breakdown (a one-line summary, then covered today / how it went / focus for next lesson, with no title or date line) that's one tap to copy and send.

- **Break down:** dictate with the iPhone keyboard mic, then tap **Break it down**. With a free Google Gemini key (Settings) it's written right in the app at no cost: Gemini 3.8 Flash on the free tier, falling back to other free Gemini models when one's daily allowance runs out. An OpenAI key works too but is paid. Without a key, it copies a ready-made prompt to paste into the ChatGPT or Claude app.
- **Saved:** only the breakdowns you choose to save (tap **Save** under one), plus prewritten ones you add. Tap any of them to copy it.
- **Modify:** on a fresh breakdown or a saved one, tell the AI what to change. It gets your original notes and the current version, and you keep or undo the result.
- **Finished students:** if the notes say the student passed or completed their test, or it was their last lesson, the breakdown leaves out "Focus for next lesson".
- **Wipe App** (Settings) deletes only this app's data, behind a tick box and a confirmation that lists what goes.
- **Inviting a coworker:** Settings > Invite a coworker texts the link and the steps. A new instructor types their first name, taps **Ask to join**, and an admin approves that phone once, from Settings > Manage phones. No keys to pass around.

## The school server (`worker/`)

A Cloudflare Worker (`ksds-lessons`) plus a D1 database holds the school's Gemini key and the list of approved phones, so staff never need a key. Each phone makes up an id and secret token; the server keeps only a hash. The first phone to tap **Become the admin** claims the school, and after that only admins can approve, remove or promote phones, or change the school key (which is never sent back to a phone). The server builds the prompt itself (it imports `docs/ai.js`), only answers the app's own origin, allows 200 breakdowns per phone per day, and keeps no lesson text or logs.

Deploy with `npx wrangler deploy` from `worker/`. For local testing, `wrangler dev` on port 8787 (the app switches to it automatically on localhost) needs `http://localhost:8787` temporarily added to the `connect-src` list in `docs/index.html`.
- **Review:** the school's "Please leave a review" card with a scannable QR code, and a Send button.
- **Private:** everything stays on the phone (IndexedDB). API keys only leave the phone to call Google or OpenAI, and aren't included in backups. Breakdowns never use names (the student is always "the student"). On Gemini's free tier Google may use what's sent to improve its products, so the app suggests leaving last names out of the dictation.
- **Screen stays on** while you dictate, while a breakdown is being written, and while the review card is showing.

## Installing

Opening the link on a phone shows a walkthrough until the app is installed. iPhone: **Share → Add to Home Screen** (Apple offers no shorter route), with an arrow pointing at Safari's bar. Android: an **Install** button that triggers the browser's own install prompt, with menu instructions as the fallback for browsers that don't offer one. Use the installed app on iPhone, not the Safari tab: iOS keeps their storage separate. On Android the two share storage.

## Development

Plain HTML/CSS/JS with no build step. The site lives in `docs/`.

On every release, bump `VERSION` in `docs/app.js` and `CACHE` in `docs/sw.js` together, or installed phones keep the old files.

`docs/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 (MIT).
