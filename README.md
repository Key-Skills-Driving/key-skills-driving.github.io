# KSDS Lesson Breakdown

A home-screen app for driving instructors at Key Skills Driving School. Talk through what happened in a lesson and get a professional lesson breakdown (covered today / how it went / focus for next lesson) that's one tap to copy and send.

- **Break down:** dictate with the iPhone keyboard mic, then tap **Break it down**. With an OpenAI API key (Settings) ChatGPT writes it right in the app, at about a tenth of a cent per breakdown. Without a key, it copies a ready-made prompt to paste into the ChatGPT or Claude app.
- **Saved:** every breakdown is saved automatically, plus prewritten ones you add. Tap any of them to copy it.
- **Review:** the school's "Please leave a review" card with a scannable QR code, and a Send button.
- **Private:** everything stays on the phone (IndexedDB). The API key never leaves the phone except to call OpenAI, and isn't included in backups.

## Install on iPhone

Open the site in Safari, tap **Share**, then **Add to Home Screen**. Use the installed app, not the Safari tab: iOS keeps their storage separate.

## Development

Plain HTML/CSS/JS with no build step. The site lives in `docs/`.

On every release, bump `VERSION` in `docs/app.js` and `CACHE` in `docs/sw.js` together, or installed phones keep the old files.

`docs/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 (MIT).
