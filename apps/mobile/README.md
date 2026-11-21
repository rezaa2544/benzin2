# @benzin/mobile — the Android shell (G-16)

The same React bundle as the PWA, wrapped by Capacitor. `apps/web` stays the source of truth for
every screen; this package only adds the three things a browser cannot do: a launcher icon, FCM
push, and a geolocation call that asks for the Android permission at the moment the user taps
«موقعیت من».

```
apps/mobile
├── capacitor.config.ts        appId ir.benzin2.app, splash/status-bar/push settings
├── scripts/sync.mjs           build the SPA against the deployed origin + `cap sync android`
├── scripts/make-assets.py     launcher icons + splash from apps/web/public/icons/icon-512.png
├── scripts/check-android.mjs  the machine-checkable half of the acceptance criteria
└── android/                   the generated Gradle project (committed, configured)
```

## Build an APK

```bash
# 1. one-time toolchain (owner): JDK 21 + Android SDK 36 + `sdkmanager "platforms;android-36" "build-tools;36.0.0"`
# 2. bake the deployed origin into the bundle and copy it into the shell
BENZIN_API_ORIGIN=https://benzin.example.com pnpm --filter @benzin/mobile sync
# 3. sign it (keystore.properties is git-ignored, see keystore.properties.example)
cd apps/mobile/android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

`sync` refuses to run without an HTTPS origin and refuses `localhost`, because a release build
that calls a laptop is the bug that only shows up after handing the file to someone else.

## Push (FCM)

1. Create the Firebase project, add an Android app with `applicationId` **`ir.benzin2.app`**.
2. Download `google-services.json` into `apps/mobile/android/app/` (git-ignored).
3. `pnpm --filter @benzin/mobile sync` → the Google Services Gradle plugin is applied
   automatically when that file exists; without it the build still succeeds and push is simply
   off, which is the correct behaviour for a developer machine.
4. The app requests the token after login and posts it to `POST /v1/me/devices`
   (`apps/web/src/lib/native.ts` → `syncPushToken`).

Sending a notification is the server's job and is not part of this task: the token is stored in
`devices.push_token` and the API already lists devices for support. Until a sender exists, the
token is collected but no message is dispatched.
