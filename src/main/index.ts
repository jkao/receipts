import { app, BrowserWindow } from "electron";
import path from "node:path";
import { IPC } from "../shared/ipc";
import { InvoiceExporter } from "./exporter";
import { ImportManager } from "./import-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { InvoiceChecker } from "./invoice-checker";
import { InvoiceOutputBuilder } from "./invoice-output";
import { InvoiceStore } from "./invoice-store";
import { SettingsStore } from "./settings";
import { TrashManager } from "./trash-manager";

let mainWindow: BrowserWindow | null = null;

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const settings = new SettingsStore(app.getPath("userData"));
    const invoices = new InvoiceStore(() => settings.getBaseFolder(), {
      getDefaultRateMinor: async () => (await settings.read()).defaultRateMinor,
    });
    const importer = new ImportManager(invoices, settings, (progress) => {
      mainWindow?.webContents.send(IPC.importProgress, progress);
    });
    const checker = new InvoiceChecker(invoices);
    const trash = new TrashManager(invoices);
    const exporter = new InvoiceExporter(invoices, () => mainWindow);
    const output = new InvoiceOutputBuilder(invoices);

    registerIpcHandlers({
      settings,
      invoices,
      checker,
      importer,
      trash,
      exporter,
      output,
      getWindow: () => mainWindow,
    });
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: "#f4f1ea",
    title: "Receipt Invoice",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.VITE_DEV_SERVER_URL;
    if (developmentUrl) {
      try {
        if (new URL(url).origin === new URL(developmentUrl).origin) {
          return;
        }
      } catch {
        // Invalid and non-web destinations are denied below.
      }
    }
    event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }
}
