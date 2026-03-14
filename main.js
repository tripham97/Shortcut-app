const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let win;
let appShortcuts = [];

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

function loadAppShortcuts() {
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
  loadAppShortcuts();
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

function createWindow() {
  win = new BrowserWindow({
    width: 500,
    height: 96,
    show: false,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    transparent: true,
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

  ipcMain.handle('search-apps', (_, query) => {
    return findMatchingApps(query).map((shortcut) => ({
      name: shortcut.name,
      path: shortcut.path,
      type: shortcut.type,
    }));
  });

  ipcMain.handle('launch-app', async (_, appEntry) => {
    if (!appEntry || !appEntry.path) {
      return { ok: false, error: 'Missing shortcut path.' };
    }

    if (appEntry.type === 'appsFolder') {
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
    const nextHeight = Math.max(96, Math.min(360, Number(height) || 96));
    win.setSize(win.getSize()[0], nextHeight);
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
