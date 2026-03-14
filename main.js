const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APP_ID = 'com.shortcutapp.launcher';

let win;
let appShortcuts = [];
const iconCache = new Map();
const appIconPath = process.platform === 'win32'
  ? path.join(__dirname, 'assets', 'app-icon.ico')
  : path.join(__dirname, 'assets', 'app-icon.png');

function walkShortcuts(dir, items = []) {
  if (!fs.existsSync(dir)) {
    return items;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkShortcuts(fullPath, items);
      continue;
    }

    if (entry.isFile() && fullPath.toLowerCase().endsWith('.lnk')) {
      const name = path.basename(fullPath, '.lnk').trim();
      if (name) {
        items.push({ name, path: fullPath });
      }
    }
  }

  return items;
}

function loadWindowsAppShortcuts() {
  const startMenuDirs = [
    path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(app.getPath('home'), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];

  const seen = new Map();

  for (const dir of startMenuDirs) {
    for (const shortcut of walkShortcuts(dir)) {
      const key = shortcut.name.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, shortcut);
      }
    }
  }

  appShortcuts = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function walkMacApplications(dir, items = []) {
  if (!fs.existsSync(dir)) {
    return items;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.name.toLowerCase().endsWith('.app')) {
      const name = path.basename(entry.name, '.app').trim();
      if (name) {
        items.push({ name, path: fullPath, type: 'appBundle' });
      }
      continue;
    }

    walkMacApplications(fullPath, items);
  }

  return items;
}

function loadMacApplications() {
  const appDirs = [
    '/Applications',
    '/System/Applications',
    path.join(app.getPath('home'), 'Applications'),
  ];

  const seen = new Map();

  for (const dir of appDirs) {
    for (const appEntry of walkMacApplications(dir)) {
      const key = appEntry.name.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, appEntry);
      }
    }
  }

  appShortcuts = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function loadAppsFolderEntries() {
  return new Promise((resolve) => {
    const script = `
$apps = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').Items()
$apps |
  Select-Object Name, Path |
  ConvertTo-Json -Compress
`;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 8 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          const items = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            items
              .filter((item) => item && item.Name && item.Path)
              .map((item) => ({
                name: item.Name.trim(),
                path: item.Path,
                type: 'appsFolder',
              }))
          );
        } catch {
          resolve([]);
        }
      }
    );
  });
}

function launchAppsFolderEntry(appId) {
  return new Promise((resolve, reject) => {
    execFile(
      'explorer.exe',
      [`shell:AppsFolder\\${appId}`],
      { windowsHide: true },
      (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      }
    );
  });
}

async function loadAvailableApps() {
  if (process.platform === 'win32') {
    loadWindowsAppShortcuts();
    const seen = new Map(
      appShortcuts.map((shortcut) => [
        shortcut.name.toLowerCase(),
        { ...shortcut, type: 'shortcut' },
      ])
    );

    for (const appEntry of await loadAppsFolderEntries()) {
      const key = appEntry.name.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, appEntry);
      }
    }

    appShortcuts = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
    return;
  }

  if (process.platform === 'darwin') {
    loadMacApplications();
    return;
  }

  appShortcuts = [];
}

function findMatchingApps(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return appShortcuts.slice(0, 8);
  }

  const startsWith = [];
  const includes = [];

  for (const shortcut of appShortcuts) {
    const name = shortcut.name.toLowerCase();
    if (name.startsWith(normalized)) {
      startsWith.push(shortcut);
    } else if (name.includes(normalized)) {
      includes.push(shortcut);
    }
  }

  return startsWith.concat(includes).slice(0, 8);
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function readMacInfoPlist(appPath) {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlistPath)) {
    return null;
  }

  try {
    const { stdout } = await runExecFile('plutil', ['-convert', 'json', '-o', '-', infoPlistPath], {
      maxBuffer: 1024 * 1024 * 2,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function resolveMacIconFile(appPath, iconName) {
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  if (iconName) {
    const candidateNames = iconName.toLowerCase().endsWith('.icns')
      ? [iconName]
      : [iconName, `${iconName}.icns`];

    for (const candidateName of candidateNames) {
      const candidatePath = path.join(resourcesDir, candidateName);
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  if (!fs.existsSync(resourcesDir)) {
    return null;
  }

  const fallbackIcons = fs.readdirSync(resourcesDir)
    .filter((entry) => entry.toLowerCase().endsWith('.icns'))
    .sort((a, b) => {
      const aIsAppIcon = a.toLowerCase().includes('app');
      const bIsAppIcon = b.toLowerCase().includes('app');
      return Number(bIsAppIcon) - Number(aIsAppIcon) || a.localeCompare(b);
    });

  for (const fallbackIcon of fallbackIcons) {
    const candidatePath = path.join(resourcesDir, fallbackIcon);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

async function getMacAppIconDataUrl(appEntry) {
  const plist = await readMacInfoPlist(appEntry.path);
  const iconName =
    plist?.CFBundleIconFile ||
    plist?.CFBundleIconName ||
    plist?.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles?.slice?.(-1)?.[0];
  const iconPath = resolveMacIconFile(appEntry.path, iconName);
  if (!iconPath) {
    return null;
  }

  const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'shortcut-app-icon-'));
  const outputDir = path.join(tempDir, 'icon.iconset');

  try {
    await runExecFile('iconutil', ['-c', 'iconset', iconPath, '-o', outputDir], {
      maxBuffer: 1024 * 1024 * 4,
    });

    const pngFiles = fs.readdirSync(outputDir)
      .filter((entry) => entry.toLowerCase().endsWith('.png'))
      .sort((a, b) => {
        const aScore = a.includes('@2x') ? 1 : 0;
        const bScore = b.includes('@2x') ? 1 : 0;
        return bScore - aScore || b.localeCompare(a, undefined, { numeric: true });
      });

    const bestPng = pngFiles[0];
    if (!bestPng) {
      return null;
    }

    const pngPath = path.join(outputDir, bestPng);
    const pngBuffer = fs.readFileSync(pngPath);
    return `data:image/png;base64,${pngBuffer.toString('base64')}`;
  } catch {
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function getAppIconDataUrl(appEntry) {
  const cacheKey = `${appEntry.type || 'unknown'}:${appEntry.path}`;
  if (iconCache.has(cacheKey)) {
    return iconCache.get(cacheKey);
  }

  try {
    if (process.platform === 'darwin' && appEntry.type === 'appBundle') {
      const macIcon = await getMacAppIconDataUrl(appEntry);
      if (macIcon) {
        iconCache.set(cacheKey, macIcon);
        return macIcon;
      }
    }

    const icon = await app.getFileIcon(appEntry.path, { size: 'normal' });
    const dataUrl = icon.isEmpty() ? null : icon.toDataURL();
    iconCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch {
    iconCache.set(cacheKey, null);
    return null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 500,
    height: 200,
    show: false,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    transparent: true,
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');

  win.on('blur', () => {
    if (win && win.isVisible()) {
      win.hide();
    }
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
  }

  if (process.platform === 'darwin' && app.dock && fs.existsSync(appIconPath)) {
    app.dock.setIcon(appIconPath);
  }

  await loadAvailableApps();
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (!win) return;
    win.show();
    win.focus();
    win.webContents.send('focus-input');
  });

  ipcMain.on('perform-search', (_, query) => {
    if (!query) return;
    const encoded = encodeURIComponent(query);
    const url = `https://www.google.com/search?q=${encoded}`;

    shell.openExternal(url);
    if (win) win.hide();
  });

  ipcMain.handle('search-apps', async (_, query) => {
    const matches = findMatchingApps(query);
    return Promise.all(matches.map(async (shortcut) => ({
      name: shortcut.name,
      path: shortcut.path,
      type: shortcut.type,
      icon: await getAppIconDataUrl(shortcut),
    })));
  });

  ipcMain.handle('launch-app', async (_, appEntry) => {
    if (!appEntry || !appEntry.path) {
      return { ok: false, error: 'Missing shortcut path.' };
    }

    if (process.platform === 'win32' && appEntry.type === 'appsFolder') {
      try {
        await launchAppsFolderEntry(appEntry.path);
        if (win) {
          win.hide();
        }
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }

    const result = await shell.openPath(appEntry.path);
    if (!result && win) {
      win.hide();
    }

    return { ok: !result, error: result || null };
  });

  ipcMain.on('set-window-height', (_, height) => {
    if (!win) return;
    const display = screen.getDisplayMatching(win.getBounds());
    const maxHeight = Math.max(148, display.workAreaSize.height - 80);
    const nextHeight = Math.max(148, Math.min(maxHeight, Number(height) || 148));
    win.setSize(win.getSize()[0], nextHeight);
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
