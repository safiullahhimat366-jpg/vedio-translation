import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
} from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(import.meta.url);

let mainWindow = null;
let serverInstance = null;
let serverPort = 0;
let studioOutputDir = '';

function createApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Outputs Folder',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            if (studioOutputDir && fs.existsSync(studioOutputDir)) {
              void shell.openPath(studioOutputDir);
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startEmbeddedBackend() {
  const userDataDir = app.getPath('userData');
  fs.mkdirSync(userDataDir, { recursive: true });

  const envCandidates = [
    path.join(path.dirname(app.getPath('exe')), '.env'),
    path.join(APP_ROOT, '.env'),
    path.join(userDataDir, '.env'),
  ];
  for (const envFile of envCandidates) {
    try {
      if (!fs.existsSync(envFile)) continue;
      const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && !(key in process.env)) {
          process.env[key] = val;
        }
      }
    } catch {
      // Optional .env file missing or unreadable
    }
  }

  process.env.NODE_ENV = 'production';
  process.env.SADAVOX_NO_AUTOSTART = '1';
  process.env.SADAVOX_DATA_DIR = userDataDir;

  const unpackedServerPath = path
    .join(APP_ROOT, 'dist-desktop', 'server.cjs')
    .replace('app.asar', 'app.asar.unpacked');
  const bundledServerPath = fs.existsSync(unpackedServerPath)
    ? unpackedServerPath
    : path.join(APP_ROOT, 'dist-desktop', 'server.cjs');
  const distHtmlDir = path.join(APP_ROOT, 'dist');

  if (!fs.existsSync(bundledServerPath)) {
    throw new Error(
      `Desktop backend bundle missing at ${bundledServerPath}. Run "npm run desktop:build" first.`
    );
  }

  const serverModule = nodeRequire(bundledServerPath);
  const started = await serverModule.startStudioServer({
    port: 0,
    host: '127.0.0.1',
    staticDistDir: distHtmlDir,
    useViteDev: false,
  });

  serverInstance = started.server;
  serverPort = started.port;
  studioOutputDir = started.outputDir;
}

function createMainWindow() {
  const pngIcon = path.join(__dirname, 'icon.png');
  const jpgFallback = path.join(APP_ROOT, 'dist', 'src', 'assets', 'images', 'sadavox_brand_mark_1795261292897.jpg');
  const windowIcon = fs.existsSync(pngIcon) ? pngIcon : jpgFallback;

  mainWindow = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: 'SadaVox Studio',
    backgroundColor: '#090C10',
    autoHideMenuBar: true,
    ...(fs.existsSync(windowIcon) ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
}

function registerIpcHandlers() {
  ipcMain.handle('sadavox:get-info', () => ({
    isDesktop: true,
    platform: process.platform,
    outputDir: studioOutputDir,
    appVersion: app.getVersion(),
  }));

  ipcMain.handle('sadavox:open-outputs-folder', async () => {
    if (!studioOutputDir) return { ok: false };
    fs.mkdirSync(studioOutputDir, { recursive: true });
    const err = await shell.openPath(studioOutputDir);
    return { ok: !err, error: err || undefined };
  });

  ipcMain.handle('sadavox:save-file', async (_event, payload) => {
    if (!mainWindow || !payload?.urlPath) {
      return { saved: false, cancelled: true };
    }

    const res = await fetch(`http://127.0.0.1:${serverPort}${payload.urlPath}`);
    if (!res.ok) {
      throw new Error(`Could not read studio output (HTTP ${res.status})`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Dubbed Media',
      defaultPath: payload.defaultName || 'dubbed-output',
    });

    if (canceled || !filePath) {
      return { saved: false, cancelled: true };
    }

    await fsp.writeFile(filePath, buffer);
    return { saved: true, filePath };
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'audioCapture') {
      callback(true);
      return;
    }
    callback(false);
  });

  createApplicationMenu();
  registerIpcHandlers();

  try {
    await startEmbeddedBackend();
    createMainWindow();
  } catch (error) {
    dialog.showErrorBox(
      'SadaVox Studio Startup Error',
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort > 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
