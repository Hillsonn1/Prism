'use strict';
const { app, BrowserWindow, shell, safeStorage } = require('electron');
const path = require('path');
const { start, logCrashes } = require('../src/server');

let mainWindow;

// PRISM_DATA_DIR points the app at another data folder (development, tests)
if (process.env.PRISM_DATA_DIR) app.setPath('userData', process.env.PRISM_DATA_DIR);

// A second launch just focuses the existing window instead of starting a second server
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const dataDir = app.getPath('userData');
    logCrashes(dataDir);
    let url;
    try {
      ({ url } = await start({
        dataDir,
        uploadsDir: path.join(app.getPath('temp'), 'PrismUploads'),
        port: 0,
        openExternal: target => { shell.openExternal(target); return true; },
        openFolder: dir => shell.openPath(dir),
        safeStorage,
      }));
    } catch (err) {
      console.error('Failed to start server:', err.message);
      app.quit();
      return;
    }
    createWindow(url);
  });

  app.on('window-all-closed', () => app.quit());
}

// Window size and position survive relaunches
const fs = require('fs');
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    const { screen } = require('electron');
    const onScreen = screen.getAllDisplays().some(d => b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width && b.y < d.bounds.y + d.bounds.height);
    return onScreen && b.width >= 720 && b.height >= 560 ? b : null;
  } catch { return null; }
}
function rememberBounds(win) {
  let timer;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => { try { fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds())); } catch {} }, 300); };
  win.on('resize', save);
  win.on('move', save);
}

function createWindow(url) {
  const bounds = savedBounds();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    ...(bounds || {}),
    minWidth: 720,
    minHeight: 560,
    title: 'Prism',
    icon: path.join(__dirname, '..', 'build', process.platform === 'darwin' ? 'icon.icns' : 'icon.ico'),
    autoHideMenuBar: true,
    // macOS: traffic lights sit over the sidebar instead of a separate title bar
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } } : {}),
    backgroundColor: '#f8fafc',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  rememberBounds(mainWindow);
  mainWindow.loadURL(url);
  // Links that open a new window (Plaid, download page) go to the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}
