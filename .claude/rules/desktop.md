---
paths:
  - "apps/desktop/**"
---

# Desktop (Electron)

- The desktop app is a **thin client of the Locus web app**. It loads `LOCUS_URL` and holds no
  GHL, Turso or Locus API credentials — authentication is the web app's session cookie.
- Windows stay `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Only the Locus origin renders in the app; every other URL opens in the system browser.
- Native features (notifications, deep links, tray) are exposed through a preload script with
  `contextBridge`, one narrow function at a time. A sandboxed window cannot load an ES-module
  preload — build the preload as CommonJS.
- Code signing, auto-update and the OAuth deep-link callback are part of shipping, not polish.
