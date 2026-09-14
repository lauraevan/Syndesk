const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
} = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORTAL_ORIGIN =
  "https://syndesk.cb88sggy8y.chatgpt.site";
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let mainWindow = null;
let tray = null;
let inputHost = null;
let quitting = false;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettingsFile() {
  try {
    return JSON.parse(
      fs.readFileSync(settingsPath(), "utf8"),
    );
  } catch {
    return {};
  }
}

function writeSettingsFile(settings) {
  const target = settingsPath();
  const temporary = target + ".tmp";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    temporary,
    JSON.stringify(settings, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  fs.renameSync(temporary, target);
}

function decryptKey(encrypted) {
  if (!encrypted || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    return safeStorage.decryptString(
      Buffer.from(encrypted, "base64"),
    );
  } catch {
    return null;
  }
}

function encryptKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Windows secure storage is unavailable. Syndesk will not save an unencrypted key.",
    );
  }
  return safeStorage.encryptString(key).toString("base64");
}

function generateAccessKey() {
  const bytes = crypto.randomBytes(20);
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded +=
        BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  const groups = encoded.match(/.{1,4}/g) || [];
  return "SYN-" + groups.join("-");
}

function getState() {
  const settings = readSettingsFile();
  return {
    active: Boolean(settings.active),
    key: decryptKey(settings.encryptedKey),
    deviceName:
      settings.deviceName ||
      process.env.COMPUTERNAME ||
      "Windows PC",
    portalOrigin: PORTAL_ORIGIN,
    inputReady: Boolean(inputHost),
    version: app.getVersion(),
    startWithWindows:
      app.getLoginItemSettings().openAtLogin,
  };
}

function persistState(next) {
  const current = readSettingsFile();
  writeSettingsFile({ ...current, ...next });
}

function inputHostPath() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "input",
      "Syndesk.InputHost.exe",
    );
  }
  return path.join(
    __dirname,
    "input-helper",
    "bin",
    "publish",
    "Syndesk.InputHost.exe",
  );
}

function startInputHost() {
  const executable = inputHostPath();
  if (process.platform !== "win32" || !fs.existsSync(executable)) {
    return;
  }
  try {
    inputHost = spawn(executable, [], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    inputHost.once("exit", () => {
      inputHost = null;
      mainWindow?.webContents.send(
        "input-host-status",
        false,
      );
    });
  } catch {
    inputHost = null;
  }
}

function sendInput(payload) {
  if (!inputHost?.stdin?.writable) return false;
  const serialized = JSON.stringify(payload);
  if (serialized.length > 4096) return false;
  inputHost.stdin.write(serialized + "\n");
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 680,
    minWidth: 430,
    minHeight: 610,
    show: false,
    frame: false,
    backgroundColor: "#07090b",
    title: "Syndesk Host",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(
    path.join(__dirname, "renderer", "index.html"),
  );
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(
    ({ url }) => {
      if (url.startsWith(PORTAL_ORIGIN)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    },
  );
  mainWindow.webContents.on(
    "will-navigate",
    (event) => event.preventDefault(),
  );
}

function createTray() {
  let image = nativeImage.createFromPath(
    path.join(__dirname, "assets", "icon.png"),
  );
  if (!image.isEmpty()) image = image.resize({ width: 18 });
  tray = new Tray(image);
  tray.setToolTip("Syndesk Host");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Syndesk",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: "Disable remote access",
        click: () => {
          persistState({ active: false });
          mainWindow?.webContents.send(
            "remote-access-disabled",
          );
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

ipcMain.handle("get-state", () => getState());
ipcMain.handle(
  "activate",
  (_event, options = {}) => {
    const current = getState();
    const key =
      options.rotate || !current.key
        ? generateAccessKey()
        : current.key;
    persistState({
      active: true,
      encryptedKey: encryptKey(key),
      deviceName:
        options.deviceName ||
        current.deviceName ||
        "Windows PC",
    });
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
    });
    return getState();
  },
);
ipcMain.handle("deactivate", () => {
  persistState({ active: false });
  sendInput({ t: "release-all" });
  return getState();
});
ipcMain.handle("copy-text", (_event, value) => {
  clipboard.writeText(String(value).slice(0, 256));
  return true;
});
ipcMain.handle("inject-input", (_event, payload) =>
  sendInput(payload),
);
ipcMain.handle("get-display-source", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  const primary =
    sources.find((source) => source.display_id === "1") ||
    sources[0];
  if (!primary) {
    throw new Error("No display is available to capture.");
  }
  return { id: primary.id, name: primary.name };
});
ipcMain.handle(
  "window-action",
  (_event, action) => {
    if (action === "minimize") mainWindow?.minimize();
    if (action === "hide") mainWindow?.hide();
  },
);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    startInputHost();
    createWindow();
    createTray();
    app.on("activate", () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
  });
}

app.on("before-quit", () => {
  quitting = true;
  sendInput({ t: "release-all" });
  inputHost?.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    mainWindow = null;
  }
});
