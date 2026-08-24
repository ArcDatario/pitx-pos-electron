import { app, BrowserWindow, Menu, Tray, nativeImage, MenuItemConstructorOptions } from "electron";
import * as path from "path";
import * as fs from "fs";
import { initLogger } from "./logger";
import { registerIpcHandlers, resumeAutomation } from "./ipc";
import { loadConfig } from "./config";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
});

try {
  initLogger();
} catch (e) {
  console.error("[main] initLogger failed:", e);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      createWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.disableHardwareAcceleration();

function buildTray() {
  const iconPath = path.join(__dirname, "../../build/logo.ico");
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show",
      click: () => {
        if (!mainWindow) {
          createWindow();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("PITX POS Transfer");
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (!mainWindow) {
      createWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Settings",
          click: () => {
            mainWindow?.webContents.send("nav:settings");
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, isMac ? { role: "close" } : { role: "close" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#f5f7fa",
    title: "PITX POS Transfer",
    icon: path.join(__dirname, "../../build/logo.ico"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  const htmlPath = path.join(app.getAppPath(), "src/renderer/index.html");
  console.info(`[main] loading HTML from: ${htmlPath}`);
  
  if (fs.existsSync(htmlPath)) {
    mainWindow.loadFile(htmlPath).catch((err) => {
      console.error(`[main] loadFile failed:`, err);
      loadFallback();
    });
  } else {
    console.error(`[main] HTML not found at: ${htmlPath}`);
    loadFallback();
  }

  function loadFallback() {
    if (!mainWindow) return;
    const fallbackPath = path.join(__dirname, "../../src/renderer/index.html");
    console.info(`[main] trying fallback: ${fallbackPath}`);
    if (fs.existsSync(fallbackPath)) {
      mainWindow.loadFile(fallbackPath).catch((err) => {
        console.error(`[main] fallback loadFile failed:`, err);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL("data:text/html;charset=utf-8,<h1>Application load failed</h1>").catch(() => {});
        }
      });
    } else {
      console.error(`[main] fallback HTML not found at: ${fallbackPath}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL("data:text/html;charset=utf-8,<h1>Application files not found</h1>").catch(() => {});
      }
    }
  }

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    const cfg = loadConfig();
    if (cfg.automation_enabled) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const cfg = loadConfig();
  registerIpcHandlers(() => mainWindow as BrowserWindow);
  buildMenu();
  buildTray();
  createWindow();

  if (cfg.automation_enabled) {
    resumeAutomation(cfg, () => mainWindow);
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // On Windows/Linux, don't quit when all windows are closed.
  // The app keeps running in the background for automation.
});

app.on("before-quit", () => {
  isQuitting = true;
});