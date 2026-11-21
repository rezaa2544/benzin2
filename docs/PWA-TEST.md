# PWA on a real iPhone — test protocol (G-17)

The goal of this task is not "the manifest validates". It is: **a person with an iPhone can add
the app to the home screen, sign in with an SMS code, reserve a quota, chat, and get a
notification.** Everything a machine can check is checked by
`apps/web/test/g17-ios.test.ts` and `apps/web/test/pwa.test.ts`; what remains is a device run,
and this file is the script for it.

Owner dependencies: a real iPhone (iOS 16.4+ for Web Push), the deployed HTTPS origin from G-18,
and an SMS provider that actually delivers (or the development OTP from `DEV_FIXED_OTP`).

## 0. Before the device run

```bash
# the deployed origin answers, with a real certificate
curl -sS -o /dev/null -w '%{http_code}\n' https://<PUBLIC_HOST>/healthz      # → 200
curl -sS -o /dev/null -w '%{http_code}\n' https://<PUBLIC_HOST>/             # → 200
# the manifest and the worker are served as files, not as the SPA fallback
curl -sS https://<PUBLIC_HOST>/manifest.webmanifest | head -3
curl -sS https://<PUBLIC_HOST>/sw.js | head -3
```

| Check                             | Expected                                                     |
| --------------------------------- | ------------------------------------------------------------ |
| `manifest.webmanifest`            | `application/manifest+json` (or at least `application/json`) |
| `sw.js`                           | `text/javascript`                                            |
| `/offline.html`                   | 200                                                          |
| `/icons/apple-touch-icon-180.png` | 200, 180×180                                                 |

## 1. Install (Safari, not Chrome)

1. Open `https://<PUBLIC_HOST>` in **Safari**.
2. Share → **Add to Home Screen** → Add.
3. The icon must be the brand mark, **not** a screenshot of the page (that is what a missing
   `apple-touch-icon` looks like).
4. The login screen shows the «نصب روی صفحهٔ اصلی» card _before_ installing; after dismissing it
   once it must not come back (stored under `benzin.iosInstallHint`).

Record: iOS version, device model, screenshot of the home-screen icon.

## 2. Launch from the icon

1. Open the icon. The app must open **without Safari chrome** (no address bar).
2. The status bar area must not overlap the header (this is `--safe-top` +
   `black-translucent`; if the title is under the clock, the token is missing).
3. Rotate to landscape and back: no clipped controls.

## 3. Sign in — the first launch is a _new_ session

> **Expected, not a buget:** iOS gives an installed web app a **separate storage** partition. The
> session that exists in Safari does not exist in the icon, so the OTP is requested again. This
> is documented behaviour and is why the refresh token is long-lived after that first login.

1. Enter a phone number → «ارسال کد» → the code arrives → enter it.
2. Kill the app (swipe up) and reopen: it must **stay signed in**.

## 4. Reserve a quota (the money-less path)

1. Open a listing → «رزرو».
2. A free account hits the reservation quota (`RESERVATION_QUOTA_EXHAUSTED`) — expected; the
   message must name the plan, not a raw error code.
3. As a subscribed buyer the reservation goes through and the countdown starts.

## 5. Chat

1. Open the trade, send a message; the other side receives it (WebSocket).
2. Send a phone number: it must appear **masked** unless the reader has a plan and the trade is
   confirmed (G-27). The banner must say why.
3. Put the app in the background for ~2 minutes and return: the socket reconnects and the
   messages that arrived meanwhile appear.

## 6. Web Push (iOS 16.4+, installed only)

1. Trigger a notification from the panel (`POST /v1/admin/notifications` or the trades event).
2. First time: iOS asks for permission — the prompt must appear **only after** a user action,
   never on load.
3. Background the app, fire the notification again: the banner must appear on the lock screen.
4. Tap it: the app opens on the relevant screen.

Record whether the token reached the server: `GET /v1/me/devices` (as the same user) or check
`devices.push_token` in the panel.

## 7. Offline

1. Turn on Airplane Mode, reopen the app: the cached shell plus the offline card must paint,
   never a browser error page.
2. Any `/v1/**` request while offline must fail fast (the worker never caches the API).

## 8. Uninstall / reinstall

Delete the icon, reinstall: the app asks for the OTP again (same storage rule as §3), and the
old device row is replaced rather than duplicated (`POST /v1/me/devices` upserts by deviceId).

## Result table (fill in on the device run)

| #   | Step                          | iOS / model | Result | Notes                             |
| --- | ----------------------------- | ----------- | ------ | --------------------------------- |
| 1   | Install from Safari           |             | ☐      |                                   |
| 2   | Icon opens standalone         |             | ☐      |                                   |
| 3   | OTP sign-in, session persists |             | ☐      | first launch is a new session     |
| 4   | Reserve a quota               |             | ☐      | free account blocked by design    |
| 5   | Chat + masking                |             | ☐      |                                   |
| 6   | Web Push                      |             | ☐      | needs iOS 16.4+ and installed app |
| 7   | Offline shell                 |             | ☐      |                                   |
| 8   | Reinstall                     |             | ☐      |                                   |

A run counts as passed only when every row is ticked **and** the screenshot of the installed icon
is attached. Until then this task stays `In Progress` with the reason "device owed by the owner".

## What is already proven without a device

- `apps/web/test/pwa.test.ts` — manifest fields, icon sizes, worker versioning, standalone
  detection, secure-context rule.
- `apps/web/test/g17-ios.test.ts` — the iOS install card logic, the translucent status bar +
  safe-area contract, and the "no `100vh`" rule.
- `node apps/mobile/scripts/check-android.mjs` — the Android side of the same shell.

## Known iOS limits (do not file as bugs)

| Limit                                                | Consequence                                          |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Installed app has separate storage                   | one extra OTP after installing                       |
| No `beforeinstallprompt`                             | the in-app install card is the only hint             |
| Web Push requires iOS 16.4+ **and** an installed app | no push in Safari tabs                               |
| Safari clears unused site data after ~7 days         | a long-dormant user signs in again                   |
| Background JS is suspended                           | the socket reconnects on resume, not while suspended |
