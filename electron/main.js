'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { start, logCrashes } = require('../src/server');

let mainWindow;

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

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    title: 'Prism',
    icon: path.join(__dirname, '..', 'build', process.platform === 'darwin' ? 'icon.icns' : 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadURL(url);
  // Links that open a new window (Plaid, download page) go to the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}
