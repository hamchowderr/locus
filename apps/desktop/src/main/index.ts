import { app, BrowserWindow, shell } from "electron";

const LOCUS_URL = process.env.LOCUS_URL ?? "http://localhost:3000";

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Only the Locus origin renders inside the app; everything else opens in the browser.
  const origin = new URL(LOCUS_URL).origin;
  window.webContents.setWindowOpenHandler(({ url }) => {
    // A blank window is a page preparing a pop-up (Connect on the Apps page); refusing it
    // makes the page fall back to its own tab instead of opening a stray blank browser tab.
    if (url === "about:blank") return { action: "deny" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void window.loadURL(LOCUS_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
