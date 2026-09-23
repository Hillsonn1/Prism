// Talking to the local server.

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadAll() {
  const [txns, merchants, settings, merchantInfo] = await Promise.all([
    api('GET', '/api/transactions'),
    api('GET', '/api/merchants'),
    api('GET', '/api/settings'),
    api('GET', '/api/merchants/intel').catch(() => ({})),
  ]);
  state.transactions = Array.isArray(txns) ? txns : [];
  state.merchants = merchants && typeof merchants === 'object' ? merchants : {};
  state.merchantInfo = merchantInfo && typeof merchantInfo === 'object' ? merchantInfo : {};
  applySettings(settings);
  state.txVersion++;
  clearDashboardCaches();
}

function applySettings(settings) {
  state.budgets = settings.budgets || {};
  state.monthlyBudget = settings.monthlyBudget || 0;
  state.hasApiKey = !!settings.hasApiKey;
  state.prefs = settings.prefs || {};
  state.currency = settings.currency || { ilsRate: 'auto', latest: null };
  state.dismissedAnomalies = new Set(state.prefs.dismissedAnomalies || []);
  setCategories(settings.categories);
  state.trips = settings.trips || [];
  applyTheme(state.prefs.theme || 'system');
}

// UI preferences live with the data on the server (see /api/prefs)
async function savePrefs(patch) {
  Object.assign(state.prefs, patch);
  try { await api('PUT', '/api/prefs', patch); } catch {}
}

// Server-sent progress stream → callbacks; resolves with the final event
function streamProgress(url, onProgress) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(url);
    es.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.done || data.error) {
        es.close();
        if (data.error) reject(new Error(data.message || 'Failed'));
        else resolve(data);
      } else if (onProgress) {
        onProgress(data.progress, data.message);
      }
    };
    es.onerror = () => { es.close(); reject(new Error('Lost connection to the app — is it still running?')); };
  });
}
