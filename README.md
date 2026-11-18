# Praxos for web chats

A browser extension that saves your chats on claude.ai and chatgpt.com to your
[Praxos](https://app.mypraxos.com) account, so your coding agents and your
other tools can use what you worked out there.

## What it does

- **Saves as you go.** A few seconds after a reply finishes, the open
  conversation is read and what is new is sent.
- **Imports earlier chats.** A button in the popup walks your past chats on
  the site you are on. It can be stopped and started again.
- **Stays under your control.** Pause everything, switch a site off, skip one
  chat, or disconnect the browser.

See [DATA.md](DATA.md) for exactly what is and is not sent.

## Install

Until it is listed in the Chrome Web Store:

1. `npm run pack`, then unzip `dist/praxos-web-chats.zip` (or use this folder
   as it is).
2. Open `chrome://extensions` and turn on Developer mode.
3. Choose "Load unpacked" and pick the folder.
4. Click the extension's icon, then "Connect to Praxos", and approve the code
   in Praxos.

Works in Chrome and other Chromium browsers. There is no Firefox or Safari
build, and nothing for the sites' phone apps.

## How it works

- `content.js` runs on the two sites. It reads the open conversation with the
  page's own login, using the same requests the site's own app makes, converts
  it (`lib/convert.js`) and hands it to the service worker.
- `background.js` holds the Praxos sign-in and sends: only messages not sent
  yet, and a recent message again when its text has changed, which covers a
  reply that was read while it was still being written.
- `popup.*` is the control surface.

Sign-in is a pairing flow: the popup shows a code, you approve it in Praxos,
and the extension receives a token made for this browser. Removing the
connection in Praxos turns it off.

## Known limits

- The sites' internal requests are not a public API and can change without
  notice. When that happens, saving stops until the adapter is updated; it
  does not send wrong data.
- The claude.ai data shapes were checked against the live site in November
  2026. The chatgpt.com adapter is written from the known shapes and needs
  testing against the live site.
- History import runs in an open tab and stops if the tab is closed. Starting
  it again skips what is already saved.

## Develop

    npm test          # conversion and the service worker, under node
    npm run pack      # dist/praxos-web-chats.zip

No build step and no dependencies. The files at the top of this repository are
the files the browser runs.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

MIT. See [LICENSE](LICENSE).
