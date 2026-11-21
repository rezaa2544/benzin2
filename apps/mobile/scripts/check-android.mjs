#!/usr/bin/env node
/**
 * G-16 — the part of "an installable, push-capable Android APK" that a machine can verify.
 *
 *   node apps/mobile/scripts/check-android.mjs
 *
 * The APK itself cannot be built here (that needs a JDK, the Android SDK and a Firebase project),
 * but every input to that build is a file in this repo, and each one has a way of being wrong
 * that only shows up on a real device: a missing permission, a notification channel id that does
 * not match the manifest, an applicationId that collides with `com.getcapacitor.myapp`, an icon
 * set that was never regenerated. Those are checked here.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const mobile = join(root, 'apps', 'mobile');
const android = join(mobile, 'android');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✔ ${name}${typeof detail === 'string' ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✘ ${name} — ${error.message}`);
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

console.log('Android shell (G-16) — apps/mobile\n');

const manifest = read('apps/mobile/android/app/src/main/AndroidManifest.xml');
const appGradle = read('apps/mobile/android/app/build.gradle');
const variables = read('apps/mobile/android/variables.gradle');
const strings = read('apps/mobile/android/app/src/main/res/values/strings.xml');
const colors = read('apps/mobile/android/app/src/main/res/values/colors.xml');
const capacitorConfig = read('apps/mobile/capacitor.config.ts');
const mainActivity = read('apps/mobile/android/app/src/main/java/ir/benzin2/app/MainActivity.java');

check('the shell has its own applicationId, not the Capacitor sample one', () => {
  expect(/appId: 'ir\.benzin2\.app'/.test(capacitorConfig), 'capacitor.config.ts appId');
  expect(/applicationId "ir\.benzin2\.app"/.test(appGradle), 'build.gradle applicationId');
  expect(!/com\.getcapacitor\.myapp/.test(appGradle), 'the sample applicationId is still there');
  const java = readDirRecursive(join(android, 'app', 'src', 'main', 'java'));
  expect(
    java.some((file) => file.endsWith(join('ir', 'benzin2', 'app', 'MainActivity.java'))),
    'MainActivity is not in the ir.benzin2.app package',
  );
  return 'ir.benzin2.app';
});

check('it installs on Android 9 and newer', () => {
  const min = /minSdkVersion = (\d+)/.exec(variables)?.[1];
  expect(min !== undefined, 'minSdkVersion is not declared');
  // Android 9 = API 28. A lower minSdk is allowed (more reach); anything above 28 would lock
  // out the devices the acceptance criteria name.
  expect(Number(min) <= 28, `minSdkVersion ${min} excludes Android 9`);
  const target = /targetSdkVersion = (\d+)/.exec(variables)?.[1];
  expect(Number(target) >= 34, `targetSdkVersion ${target} is too old for the Play Store`);
  return `minSdk ${min} · targetSdk ${target}`;
});

check('the permissions the app actually uses are declared', () => {
  for (const permission of [
    'android.permission.INTERNET',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ]) {
    expect(manifest.includes(permission), `${permission} missing from the manifest`);
  }
  // Nothing beyond that: a fuel-trading app has no business asking for contacts or the camera.
  for (const forbidden of [
    'READ_CONTACTS',
    'CAMERA',
    'READ_SMS',
    'RECORD_AUDIO',
    'ACCESS_BACKGROUND_LOCATION',
  ]) {
    expect(!manifest.includes(forbidden), `${forbidden} is requested but never used`);
  }
  return 'internet · notifications · location';
});

check('FCM is wired to a channel that exists', () => {
  const manifestChannel =
    /default_notification_channel_id"\s*\n?\s*android:value="@string\/([\w]+)"/.exec(manifest)?.[1];
  expect(manifestChannel, 'the manifest does not name a default channel');
  const declared = new RegExp(`<string name="${manifestChannel}">`).test(strings);
  expect(declared, `@string/${manifestChannel} is not declared in strings.xml`);
  expect(
    mainActivity.includes('createNotificationChannel'),
    'MainActivity never creates the channel — Android 8+ would drop every push',
  );
  expect(mainActivity.includes('R.string.default_notification_channel_id'), 'channel id mismatch');
  return `${manifestChannel} created in MainActivity`;
});

check('the Google Services plugin is applied only when the config exists', () => {
  expect(
    /google-services\.json/.test(appGradle),
    'build.gradle never looks for google-services.json',
  );
  expect(
    /try\s*\{[\s\S]*servicesJSON[\s\S]*apply plugin: 'com\.google\.gms\.google-services'/.test(
      appGradle,
    ),
    'a missing google-services.json would fail the build instead of skipping push',
  );
  const ignore = read('apps/mobile/.gitignore');
  expect(
    ignore.includes('android/app/google-services.json'),
    'google-services.json is not ignored',
  );
  return 'conditional, git-ignored';
});

check('the release keystore comes from a git-ignored file', () => {
  expect(/keystore\.properties/.test(appGradle), 'no signing config');
  expect(
    /if \(keystoreFile\.exists\(\)\)[\s\S]*signingConfig signingConfigs\.release/.test(appGradle),
    'the release build is not signed from keystore.properties',
  );
  const ignore = read('apps/mobile/.gitignore');
  for (const pattern of ['android/keystore.properties', '*.jks', '*.keystore']) {
    expect(ignore.includes(pattern), `${pattern} is not ignored`);
  }
  expect(
    existsSync(join(android, 'keystore.properties.example')),
    'no android/keystore.properties.example',
  );
  return 'keystore.properties (ignored) + example';
});

check('the version is passed in, not hardcoded in two places', () => {
  expect(/project\.findProperty\('versionCode'\)/.test(appGradle), 'versionCode is hardcoded');
  expect(/project\.findProperty\('versionName'\)/.test(appGradle), 'versionName is hardcoded');
  return '-PversionCode / -PversionName';
});

check('the launcher icon and splash are real assets from the PWA artwork', () => {
  execFileSync('python3', [join(mobile, 'scripts', 'make-assets.py'), '--check'], {
    stdio: 'pipe',
  });
  const icon = join(android, 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher.png');
  expect(existsSync(icon), 'no xxxhdpi launcher icon');
  expect(statSync(icon).size > 2000, 'the launcher icon looks like a placeholder');
  return '5 densities · 3 variants · 11 splashes';
});

check('the splash and the status bar match the dark UI', () => {
  expect(/#0B0F14/.test(colors), 'splashBackground is not the UX-SPEC background');
  expect(
    /splashBackground/.test(read('apps/mobile/android/app/src/main/res/values/styles.xml')),
    'the splash theme does not use it',
  );
  expect(mainActivity.includes('#0B0F14'), 'the status bar colour is not set');
  return '#0B0F14';
});

check('cleartext traffic is off and backups do not carry the session', () => {
  expect(/android:usesCleartextTraffic="false"/.test(manifest), 'cleartext HTTP is allowed');
  expect(/android:allowBackup="false"/.test(manifest), 'the WebView storage would be backed up');
  expect(
    existsSync(join(android, 'app/src/main/res/xml/data_extraction_rules.xml')),
    'no data extraction rules',
  );
  return 'https only · no backup';
});

check('the shell knows where the API lives and refuses to guess', () => {
  const sync = read('apps/mobile/scripts/sync.mjs');
  expect(/BENZIN_API_ORIGIN/.test(sync), 'sync does not take the API origin');
  expect(/Refusing to bake a localhost origin/.test(sync), 'a localhost origin would be accepted');
  expect(/VITE_API_BASE_URL: origin/.test(sync), 'the origin is not passed to the web build');
  expect(
    /apiBaseUrl\(import\.meta\.env\.VITE_API_BASE_URL\)/.test(read('apps/web/src/App.tsx')),
    'the app never reads VITE_API_BASE_URL',
  );
  return 'VITE_API_BASE_URL';
});

check('the web-side bridge asks for the native permission before using it', () => {
  const native = read('apps/web/src/lib/native.ts');
  expect(/requestPermissions/.test(native), 'the push flow never asks for permission');
  expect(
    /requestPermissions[\s\S]{0,600}await call\(/.test(native),
    'geolocation reads the position without asking for permission first',
  );
  expect(/isNativeApp/.test(native), 'the bridge is not gated on the WebView');
  expect(/registerDevice/.test(read('apps/web/src/App.tsx')), 'the token never reaches the API');
  return 'push + geolocation';
});

function readDirRecursive(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? readDirRecursive(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const total = passed + failures.length;
console.log(`\n${passed}/${total} checks passed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('the shell is ready for `gradlew assembleRelease` once the SDK and the keystore exist');
