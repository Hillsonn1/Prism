// Update banner, checked through the server so the download site never has
// to answer a cross-origin request from the app.

async function checkForUpdate() {
  try {
    const u = await api('GET', '/api/update');
    if (!u.updateAvailable || state.prefs.dismissedUpdate === u.latest) return;
    const bar = document.getElementById('update-bar');
    if (!bar) return;
    bar.dataset.version = u.latest;
    bar.querySelector('.update-bar-text').textContent = `Prism v${u.latest} is available — you have v${u.current}.`;
    const link = document.getElementById('update-bar-link');
    if (link) link.href = u.siteUrl;
    bar.style.display = 'flex';
  } catch {}
}

function dismissUpdateBanner() {
  const bar = document.getElementById('update-bar');
  if (!bar) return;
  if (bar.dataset.version) savePrefs({ dismissedUpdate: bar.dataset.version });
  bar.style.display = 'none';
}
