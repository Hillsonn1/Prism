const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');

const PORT = 3000;
let mainWindow;

function waitForServer(maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      http.get(`http://localhost:${PORT}/`, () => resolve())
        .on('error', () => {
          if (++attempts >= maxAttempts) return reject(new Error('Server did not start in time'));
          setTimeout(check, 300);
        });
    };
    setTimeout(check, 300);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Prism',
    icon: path.join(__dirname, '..', 'build', process.platform === 'darwin' ? 'icon.icns' : 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Open any target="_blank" links in the system browser, not a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  process.env.ELECTRON_USER_DATA = app.getPath('userData');
  require('../server');

  try {
    await waitForServer();
    createWindow();
  } catch (err) {
    console.error('Failed to start server:', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
