# G-16 — the Android app

The web app already is the product. Android adds a launcher icon, push, and a geolocation call that
asks the OS for permission at the right moment — nothing is re-implemented in Java.

```
apps/mobile                      Capacitor shell (applicationId ir.benzin2.app)
  capacitor.config.ts            splash, status bar, push, geolocation settings
  android/                       the Gradle project (committed, configured, no secrets)
  scripts/sync.mjs               build the SPA against the deployed origin, then `cap sync android`
  scripts/make-assets.py         launcher icons + splash from apps/web/public/icons/icon-512.png
  scripts/check-android.mjs      12 machine-checkable acceptance items
apps/web/src/lib/native.ts       the browser↔WebView seam (no Capacitor import in the bundle)
apps/api  POST /v1/me/devices    where the FCM token is stored
```

## Why the seam is duck-typed

`apps/web/src/lib/native.ts` never imports `@capacitor/*`. It reads `window.Capacitor` at call time.
Consequences, all of them wanted:

- the browser bundle does not grow by a single byte for a feature it cannot use;
- the same code is unit-tested with a fake bridge (`apps/web/test/g16-native.test.ts`, 10 tests);
- a broken or absent plugin degrades to "no push" instead of a white screen.

## The three native behaviours

| Behaviour   | How                                                                                                                                                                 | Failure mode if missing                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| push token  | after login: permission → `PushNotifications.register()` → `registration` event → `POST /v1/me/devices`; rotates re-register                                        | notifications silently never arrive            |
| geolocation | `nativeGeolocation()` returns an object with the same shape as `navigator.geolocation`, so `geo.ts` takes it unchanged; permission is requested before the position | the «موقعیت من» button does nothing on Android |
| API origin  | the WebView origin is `https://localhost`, so `VITE_API_BASE_URL` is baked at build time from `BENZIN_API_ORIGIN`                                                   | every request 404s inside the app              |

## Device registration (API side)

`POST /v1/me/devices` upserts by `(user, deviceId)`:

```json
{ "platform": "android", "deviceId": "android-4f8c1d9a7b2e", "pushToken": "fcm-…", "appVersion": "1.0.0" }
→ { "id": "…", "platform": "android", "deviceId": "…", "pushRegistered": true, "lastSeenAt": "…" }
```

- `deviceId` must match `[A-Za-z0-9._:-]{8,128}` (422 otherwise) — it is client-supplied and it
  scopes the row;
- a registration without a token does **not** erase the token that already works;
- a rotated token updates the same row;
- `GET /v1/me/devices` never shows another user's devices (`apps/api/test/g16-devices.test.ts`,
  6 tests).

## What the owner still has to do

| Step                                                                                       | Why it cannot be done here                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `keytool -genkeypair … benzin-release.jks` + `keystore.properties`                         | the signing identity is the app's identity; losing it means a new app on Play |
| Create the Firebase project, drop in `google-services.json`                                | needs a Google account; the file is git-ignored                               |
| Install JDK 21 + Android SDK 36 (`sdkmanager "platforms;android-36" "build-tools;36.0.0"`) | ~4 GB of toolchain; Capacitor 8 needs JDK 21                                  |
| `./gradlew assembleRelease`                                                                | needs the two previous rows                                                   |

Everything up to those is done and verified statically:

```
$ node apps/mobile/scripts/check-android.mjs
12/12 checks passed
```

and the APK path after step 4 is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

## Verified here

| Check                                                    | Result                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `cap add android` produced a real Gradle project         | `apps/mobile/android/**`, `ir/benzin2/app/MainActivity.java`                            |
| applicationId is the product's, not the Capacitor sample | `ir.benzin2.app`                                                                        |
| installs on Android 9+                                   | `minSdk 24`, `targetSdk 36`                                                             |
| permissions                                              | internet, network state, notifications, coarse + fine location — and nothing else       |
| FCM                                                      | channel id in the manifest == the string resource == the channel `MainActivity` creates |
| google-services                                          | applied only when the file exists; ignored in git                                       |
| signing                                                  | from a git-ignored `keystore.properties`; version via `-PversionCode`                   |
| icons + splash                                           | 5 densities × 3 variants + 11 splashes, generated from the PWA artwork                  |
| privacy                                                  | `usesCleartextTraffic=false`, `allowBackup=false`, no backup of the session             |
| tests                                                    | api 323/323, web 153/153 (10 new native tests)                                          |

## Deliberately not in this task

- **Sending** push messages. The token is collected and stored; dispatching a notification for a new
  reservation / chat message is a server-side sender (FCM HTTP v1) and belongs with the
  notification work, not with the shell.
- iOS/App Store: `17-*` covers the PWA on iPhone; a native iOS build would need a Mac and an Apple
  developer account and was never in scope.
