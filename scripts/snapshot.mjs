#!/usr/bin/env node
/**
 * Holt einmal pro Stunde den Wallet-Bestand und die Bitcoin-Kurse und hängt
 * einen Datenpunkt an data/history.json an. Läuft im GitHub-Actions-Cron.
 *
 *   node scripts/snapshot.mjs             # echte APIs
 *   node scripts/snapshot.mjs --fixture   # Offline-Test gegen scripts/fixtures/
 *   node scripts/snapshot.mjs --dry-run   # nichts schreiben, nur ausgeben
 *
 * Grundsatz: lieber gar nichts schreiben als Müll schreiben. Schlägt eine
 * Quelle fehl, endet das Skript mit Exit-Code 1 und lässt die Datei unberührt.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADDRESS, START_AT } from '../assets/js/config.js';
import { normaliseEntries, toTime, zurichDayKey, CURRENCIES } from '../assets/js/calc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'data', 'history.json');
const FIXTURES = join(ROOT, 'scripts', 'fixtures');

const args = new Set(process.argv.slice(2));
const USE_FIXTURES = args.has('--fixture');
const DRY_RUN = args.has('--dry-run');

/** Aeltere Punkte werden ausgedünnt, damit die Datei nicht endlos wächst. */
const FULL_RESOLUTION_DAYS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, { attempts = 3, timeoutMs = 20_000 } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'dr-monetentracker/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      console.warn(`  Versuch ${i}/${attempts} fehlgeschlagen für ${url}: ${err.message}`);
      if (i < attempts) await sleep(1000 * 2 ** i);
    }
  }
  throw lastError;
}

const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), 'utf8'));

/** Bestätigte Beträge plus noch unbestätigte Mempool-Bewegungen. */
function satsFromAddress(payload) {
  const chain = payload?.chain_stats ?? {};
  const mem = payload?.mempool_stats ?? {};
  const sats =
    Number(chain.funded_txo_sum ?? 0) -
    Number(chain.spent_txo_sum ?? 0) +
    Number(mem.funded_txo_sum ?? 0) -
    Number(mem.spent_txo_sum ?? 0);
  if (!Number.isFinite(sats) || sats < 0) throw new Error('Unbrauchbarer Wallet-Bestand');
  return sats;
}

async function loadBalance() {
  if (USE_FIXTURES) return satsFromAddress(await readFixture('address.json'));
  return satsFromAddress(await fetchJson(`https://mempool.space/api/address/${ADDRESS}`));
}

function pricesFromMempool(payload) {
  const out = { chf: Number(payload?.CHF), eur: Number(payload?.EUR), usd: Number(payload?.USD) };
  return CURRENCIES.every((c) => Number.isFinite(out[c]) && out[c] > 0) ? out : null;
}

function pricesFromCoingecko(payload) {
  const btc = payload?.bitcoin ?? {};
  const out = { chf: Number(btc.chf), eur: Number(btc.eur), usd: Number(btc.usd) };
  return CURRENCIES.every((c) => Number.isFinite(out[c]) && out[c] > 0) ? out : null;
}

/** mempool.space liefert CHF, EUR und USD in einem Aufruf; CoinGecko ist der Ersatz. */
async function loadPrices() {
  if (USE_FIXTURES) {
    const prices = pricesFromMempool(await readFixture('prices.json'));
    if (!prices) throw new Error('Fixture-Kurse unbrauchbar');
    return prices;
  }

  try {
    const prices = pricesFromMempool(await fetchJson('https://mempool.space/api/v1/prices'));
    if (prices) return prices;
    console.warn('  mempool.space lieferte unvollständige Kurse, weiche auf CoinGecko aus');
  } catch (err) {
    console.warn(`  mempool.space Kurse fehlgeschlagen: ${err.message}`);
  }

  const prices = pricesFromCoingecko(
    await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=chf,eur,usd'),
  );
  if (!prices) throw new Error('Auch CoinGecko lieferte keine brauchbaren Kurse');
  return prices;
}

async function loadHistory() {
  if (!existsSync(DATA_FILE)) return { address: ADDRESS, startAt: START_AT, updatedAt: null, entries: [] };
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    return { ...parsed, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    throw new Error(`data/history.json ist nicht lesbar (${err.message}) — bitte prüfen statt überschreiben`);
  }
}

/** Auf die volle Stunde abgerundeter UTC-Zeitstempel, unser Schlüssel je Datenpunkt. */
export function hourKey(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace('.000Z', 'Z');
}

/**
 * Punkte älter als 30 Tage auf einen pro Tag reduzieren — und zwar auf den
 * ersten des Tages. Der ist der Mitternachts-Bezugspunkt, den die Auswertung
 * braucht; er darf nie wegfallen.
 */
export function downsample(entries, now = new Date()) {
  const cutoff = toTime(now) - FULL_RESOLUTION_DAYS * 24 * 3600 * 1000;
  const keptDays = new Set();
  const out = [];

  for (const entry of entries) {
    if (toTime(entry.t) >= cutoff) {
      out.push(entry);
      continue;
    }
    const day = zurichDayKey(new Date(toTime(entry.t)));
    if (!keptDays.has(day)) {
      keptDays.add(day);
      out.push(entry);
    }
  }
  return out;
}

/** Hängt den Punkt an bzw. ersetzt den Punkt derselben Stunde. */
export function upsert(entries, entry) {
  const rest = entries.filter((e) => hourKey(e.t) !== entry.t);
  return normaliseEntries([...rest, entry]);
}

async function main() {
  const now = new Date();
  console.log(`Monetentracker-Snapshot ${now.toISOString()}${USE_FIXTURES ? ' (Fixtures)' : ''}`);

  const [sats, prices] = await Promise.all([loadBalance(), loadPrices()]);
  const entry = { t: hourKey(now), sats, ...prices };

  console.log(`  Bestand: ${(sats / 1e8).toFixed(8)} BTC`);
  console.log(`  Kurse:   ${prices.chf.toLocaleString('de-CH')} CHF / ${prices.eur} EUR / ${prices.usd} USD`);

  const history = await loadHistory();
  const next = {
    address: ADDRESS,
    startAt: START_AT,
    updatedAt: now.toISOString(),
    entries: downsample(upsert(history.entries, entry), now),
  };

  if (DRY_RUN) {
    console.log('  --dry-run: nichts geschrieben');
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`  Geschrieben: ${next.entries.length} Datenpunkte in data/history.json`);
}

// Nur ausführen, wenn direkt aufgerufen — die Tests importieren die Helfer.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`Snapshot fehlgeschlagen: ${err.message}`);
    process.exitCode = 1;
  });
}
