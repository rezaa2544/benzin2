import type { CapacitorConfig } from '@capacitor/cli';

/**
 * G-16 — the Android shell.
 *
 * The WebView loads the *built* SPA from `webDir` (not the live site): the app works offline for
 * everything the service worker has, and the store reviewers see a self-contained app. Because
 * the bundle is served from `https://localhost` inside the WebView, every API call has to be
 * absolute — `scripts/sync.mjs` bakes `VITE_API_BASE_URL` into the build from `BENZIN_API_ORIGIN`.
 */
const config: CapacitorConfig = {
  appId: 'ir.benzin2.app',
  appName: 'بنزین۲',
  webDir: '../web/dist',
  android: {
    // Mixed content must stay off: the API is HTTPS in production.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 900,
      // Auto-hide: with no splash plugin call in the web bundle, a splash that never hides is a
      // white screen with extra steps.
      launchAutoHide: true,
      backgroundColor: '#0B0F14',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Geolocation: {
      // The plugin asks the OS only when a screen calls it (G-07 / G-16).
      permissions: ['location'],
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0B0F14',
    },
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
