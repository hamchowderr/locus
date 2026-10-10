import { defineConfig } from "electron-vite";

// Main process only: the window loads the Locus web app, so there is no renderer bundle, and
// nothing is exposed to the page yet, so there is no preload. When native features arrive
// (notifications, deep links), add a preload built as CommonJS — sandboxed windows cannot
// load an ES-module preload.
export default defineConfig({
  main: {},
});
