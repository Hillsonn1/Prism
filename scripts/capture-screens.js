// Captures product screenshots for the landing page from a running Prism
// (usually one seeded with scripts/seed-demo.js):
//
//   PRISM_DATA_DIR=/tmp/demo node scripts/seed-demo.js
//   PRISM_DATA_DIR=/tmp/demo PORT=3200 npm start
//   npx electron scripts/capture-screens.js http://127.0.0.1:3200 site/shots
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [,, base = 'http://127.0.0.1:3200', outDir = path.join(__dirname, '..', 'site', 'shots')] = process.argv;
const WIDTH = 1280, HEIGHT = 820, SCALE = 2;

// A conversation for the Ask panel, so the shot doesn't need an API key
const ASK_DEMO = `
  ask.available = true; ask.model = 'claude-opus-5';
  ask.messages = [
    { role: 'user', text: 'How much did I spend on food in Tel Aviv this month?' },
    { role: 'assistant', done: true, usd: 0.02, tools: ['summarize_spending', 'search_transactions'], proposals: [], text: 'About **$412** so far — $263 on groceries (Shufersal and Rami Levy) and $149 eating out, mostly Aroma, Cofix and Wolt.\\n\\nThat is 18% less than August at this point in the month.' },
    { role: 'user', text: 'Tag the Aroma and Cofix ones as Work' },
    { role: 'assistant', done: true, usd: 0.01, tools: ['search_transactions', 'propose_changes'], text: 'Here are the 9 coffee runs — apply to tag them.', proposals: [{ id: 'demo', kind: 'update', summary: 'Tag 9 purchases as Work', affected: 9, preview: [
      { date: '2026-09-22', merchant: 'Aroma Espresso Bar', amount: 8.96 }, { date: '2026-09-19', merchant: 'Cofix', amount: 3.58 }, { date: '2026-09-17', merchant: 'Aroma Espresso Bar', amount: 12.24 }, { date: '2026-09-12', merchant: 'Cofix', amount: 5.07 } ] }] },
  ];
  toggleAsk(true); renderAsk();`;

const SHOTS = [
  { name: 'dashboard', view: 'dashboard' },
  { name: 'transactions', view: 'transactions' },
  { name: 'ask', view: 'dashboard', script: ASK_DEMO },
  { name: 'trips', view: 'trips', script: `state.tripId = state.trips[0]?.id || null; renderTrips();` },
  { name: 'dashboard-dark', view: 'dashboard', theme: 'dark' },
];

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ width: WIDTH, height: HEIGHT, show: false, webPreferences: { zoomFactor: 1, contextIsolation: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(base + '/');
  await new Promise(r => setTimeout(r, 1500));
  for (const shot of SHOTS) {
    await win.webContents.executeJavaScript(`applyTheme('${shot.theme || 'light'}'); switchView('${shot.view}', { clearHistory: true }); window.scrollTo(0, 0); ${shot.script || ''} true;`);
    await new Promise(r => setTimeout(r, 1200));
    // Freeze animations so bars and donuts are fully drawn
    await win.webContents.executeJavaScript(`document.querySelectorAll('.chart-bar[data-w]').forEach(b => { b.style.transition = 'none'; b.style.width = b.dataset.w; }); true;`);
    await new Promise(r => setTimeout(r, 400));
    const image = await win.webContents.capturePage();
    const png = image.resize({ width: WIDTH * SCALE }).toPNG();
    fs.writeFileSync(path.join(outDir, `${shot.name}.png`), png);
    console.log(`${shot.name}.png ${(png.length / 1024).toFixed(0)} KB`);
    if (shot.script?.includes('toggleAsk')) await win.webContents.executeJavaScript(`toggleAsk(false); resetAsk(); true;`);
  }
  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
