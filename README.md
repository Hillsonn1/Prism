# Prism

A local-first spending tracker for people with US and Israeli cards. Runs as a desktop app (Electron) or a plain web app on `localhost`; every number stays on your own computer.

- **Bank sync** through Plaid — link a bank once, purchases arrive on their own (syncs on launch, every 15 minutes while open, and on demand). Bring your own Plaid keys.
- **Statement import** — CSV and PDF from any card; duplicates are caught against everything already imported.
- **Categorization without an API** — merchant memory, a close-match on that memory, hundreds of rules for US and Israeli merchants, the bank's or Plaid's own category, then generic business words. Claude (optional, your key) takes a pass at whatever is left.
- **Dollars and shekels** — dollars are what everything is computed from; a shekel purchase keeps its ₪ amount beside the dollar figure, converted at the day's ECB rate (cached, with a manual override for offline use).
- **Dashboard, budget, insights** — spending by category and month, recurring charges, possible duplicates, budget targets, and plain-language observations computed locally.
- **Clean-up tools** — merge duplicate merchants after reviewing the proposals, normalize names, drop card payments.
- **Cards & bills** — statement balance, minimum, due date and paid/overdue status per card (Plaid Liabilities).
- Plaid tokens and API keys are encrypted at rest with the OS keychain in the desktop app.
- Dark mode, in-app dialogs, keyboard-friendly.

## Running it

```bash
npm install
npm start          # web app at http://localhost:3000, data in ./data
npm run dev        # desktop app (Electron), data in the OS app-data folder (PRISM_DATA_DIR overrides)
npm test           # unit + API tests (node --test)
```

The server only ever listens on `127.0.0.1`. The desktop app picks a free port at launch.

## Layout

```
src/server/         Express server, assembled by index.js
  storage.js        JSON files with atomic writes, daily backups, corrupt-file recovery
  importer.js       the one import/categorize pipeline every source goes through
  categories.js     categories and the local rules (US, Israel, generic words, descriptions)
  normalize.js      raw bank descriptors → clean merchant names
  parsers/          CSV and PDF statements
  plaid.js          bank sync (Hosted Link, /transactions/sync, scheduler)
  fx.js             ILS → USD rates
  insights.js       anomalies and local insights
  dedupe.js         duplicate-merchant proposals
  ai.js             optional Claude helpers
  routes/           HTTP API, one file per area
public/             the UI: index.html, style.css, js/ (one file per view)
electron/main.js    desktop shell
scripts/            release helpers and a Plaid mock for development
tests/              node:test suites
site/               the download page (Netlify)
```

## Hosting it for several people

The same server runs as a website with accounts when `PRISM_HOSTED=1` and
`PRISM_SECRET` are set: sign up and sign in at `/login`, every user gets their
own data folder under `<data dir>/users/<id>/`, and Plaid tokens and API keys
are sealed with a key derived from `PRISM_SECRET` (the desktop app uses the OS
keychain instead). Bank sync runs for every user on the same 15-minute cycle.

```bash
PRISM_SECRET="$(openssl rand -hex 32)" PRISM_DATA_DIR=/srv/prism npm run start:hosted
```

Put it behind HTTPS (cookies are marked Secure when `NODE_ENV=production`).
There's a `Dockerfile` and a `fly.toml` for a one-command deploy on Fly.io:

```bash
fly launch --copy-config --no-deploy
fly volumes create prism_data --size 1
fly secrets set PRISM_SECRET="$(openssl rand -hex 32)"
fly deploy
```

Point the landing page at it by setting the `PRISM_APP_URL` repository
variable (the site deploy writes it into `site/config.js`).

## Releasing

Bump `version` in `package.json`, commit, then tag: `git tag v2.0.0 && git push --tags`. The Release workflow builds the Windows installer and Mac zip, publishes a GitHub release, and deploys `site/` with a matching `version.json` (the workflow refuses a tag that doesn't match `package.json`).

## Developing against Plaid without keys

```bash
node scripts/mock-plaid.js
PRISM_PLAID_HOST=http://localhost:3999 npm start
```

Then save the keys `mock-client` / `mock-secret` in Settings and connect a bank.
