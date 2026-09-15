# Lesson Notes

A home-screen app for driving instructors. Keep every student's lesson notes in one place, dictate what happened after a lesson, and let Claude or ChatGPT tidy it into a clean note (practiced / went well / work on / next time). Includes a "Please leave a review" card with a QR code for students and parents.

- **Private by design:** notes are stored only on the phone (IndexedDB). Nothing is uploaded, and each person who installs the app has their own notes.
- **No API keys:** the AI step copies a ready-made prompt, you paste it into your own Claude or ChatGPT app, then paste the reply back.
- **Works offline** after the first visit.

## Install on iPhone

Open https://mawklin.github.io/lesson-notes/ in Safari, tap **Share**, then **Add to Home Screen**. Use the installed app, not the Safari tab: iOS keeps their storage separate.

## Development

Plain HTML/CSS/JS with no build step. The site lives in `docs/` and is served by GitHub Pages from the `main` branch.

On every release, bump `VERSION` in `docs/app.js` and `CACHE` in `docs/sw.js` together, or installed phones keep the old files.

`docs/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 (MIT).
