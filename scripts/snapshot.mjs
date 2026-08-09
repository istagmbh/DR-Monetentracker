#!/usr/bin/env node
/**
 * Holt einmal pro Stunde den Wallet-Bestand, die Bitcoin-Kurse und die Kurse
 * der Vergleichsanlagen und hängt einen Datenpunkt an data/history.json an.
 * Läuft im GitHub-Actions-Cron.
 *
 *   node scripts/snapshot.mjs             # echte APIs
 *   node scripts/snapshot.mjs --fixture   # Offline-Test gegen scripts/fixtures/
 *   node scripts/snapshot.mjs --dry-run   # nichts schreiben, nur ausgeben
 *   node scripts/snapshot.mjs --force     # auch schreiben, wenn die Stunde schon steht
 *
 * Grundsatz: lieber gar nichts schreiben als Müll schreiben. Schlägt eine
 * Pflichtquelle fehl, endet das Skript mit Exit-Code 1 und lässt die Datei
 * unberührt. Vergleichskurse sind Kür — fällt einer aus, fehlt eben diese
 * Anlage für diese Stunde, und die Anzeige blendet sie aus.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADDRESS, START_AT, ASSETS, BACKFILL_HOURS } from '../assets/js/config.js';
import { normaliseEntries, toTime, zurichDayKey, CURRENCIES } from '../assets/js/calc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'data', 'history.json');
const FIXTURES = join(ROOT, 'scripts', 'fixtures');

const args = new Set(process.argv.slice(2));
const USE_FIXTURES = args.has('--fixture');
const DRY_RUN = args.has('--dry-run');
const FORCE = args.has('--force');

/** Ältere Punkte werden ausgedünnt, damit die Datei nicht endlos wächst. */
const FULL_RESOLUTION_DAYS = 30;

const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { attempts = 3, timeoutMs = 20_000 } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'text/csv,application/json', 'user-agent': 'dr-monetentracker/1.0' },
      });
      if (!res.ok) {
        // Der Anfang der Antwort steht im Protokoll — ein blosser Statuscode
        // liess beim letzten Fehlschlag offen, ob Symbol, Pfad oder Sperre schuld war.
        const koerper = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
        throw new Error(`HTTP ${res.status} ${res.statusText}${koerper ? ` — ${koerper}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastError = err;
      console.warn(`  Versuch ${i}/${attempts} fehlgeschlagen für ${url}: ${err.message}`);
      if (i < attempts) await sleep(1000 * 2 ** i);
    }
  }
  throw lastError;
}

const fetchJson = async (url, opts) => JSON.parse(await fetchText(url, opts));

const readFixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), 'utf8'));

/* --- Pflichtquellen: Bestand und Bitcoin-Kurs ----------------------------- */

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

/* --- Kür: Vergleichsanlagen ----------------------------------------------- */

/**
 * Stooq liefert mehrere Symbole als CSV in einem Aufruf:
 *   Symbol,Date,Time,Close
 *   XAUUSD,2026-08-09,03:58:00,3421.55
 * Nicht gelieferte Werte stehen als "N/D" drin.
 */
export function parseStooq(csv) {
  const out = {};
  const zeilen = String(csv).trim().split(/\r?\n/);
  if (zeilen.length < 2) return out;

  const spalten = zeilen[0].toLowerCase().split(',');
  const iSym = spalten.indexOf('symbol');
  const iClose = spalten.indexOf('close');
  if (iSym < 0 || iClose < 0) return out;

  for (const zeile of zeilen.slice(1)) {
    const felder = zeile.split(',');
    const symbol = (felder[iSym] || '').trim().toLowerCase();
    const kurs = Number(felder[iClose]);
    if (symbol && Number.isFinite(kurs) && kurs > 0) out[symbol] = kurs;
  }
  return out;
}

/**
 * Kurs und Notierungswährung aus der Chart-Antwort von Yahoo. Die Währung
 * steht in der Antwort selbst — verlässlicher, als sie in der Konfiguration
 * zu raten.
 */
export function parseYahoo(payload) {
  const meta = payload?.chart?.result?.[0]?.meta;
  const kurs = Number(meta?.regularMarketPrice ?? meta?.previousClose);
  if (!Number.isFinite(kurs) || kurs <= 0) return null;
  return { kurs, waehrung: String(meta?.currency || '').toUpperCase() || null };
}

/**
 * Alle Vergleichskurse in Franken. Der Dollarkurs kommt aus den beiden
 * Bitcoin-Notierungen — CHF je BTC geteilt durch USD je BTC ist der
 * USD/CHF-Kurs, ein zusätzlicher Aufruf erübrigt sich damit.
 *
 * Jedes Symbol wird einzeln geholt: Eine Sammelabfrage nimmt beim ersten
 * unbekannten Symbol alle anderen mit ins Verderben — die erste Fassung
 * scheiterte genau daran mit einem 404 für die ganze Liste.
 */
async function loadAssets(prices) {
  const usdchf = prices.chf / prices.usd;
  const assets = {};

  /** Rechnet einen Kurs anhand seiner Notierungswährung in Franken um. */
  const inFranken = (kurs, waehrung) => {
    if (waehrung === 'CHF') return kurs;
    if (waehrung === 'USD') return kurs * usdchf;
    if (waehrung === 'EUR') return kurs * (prices.chf / prices.eur);
    return null;
  };

  for (const [key, meta] of Object.entries(ASSETS)) {
    if (!meta.yahoo && !meta.stooq) continue;

    if (USE_FIXTURES) {
      const kurse = parseStooq(await readFile(join(FIXTURES, 'stooq.csv'), 'utf8'));
      const roh = meta.stooq && kurse[meta.stooq.toLowerCase()];
      if (roh) assets[key] = Math.round(inFranken(roh, meta.quote) * 100) / 100;
      continue;
    }

    let franken = null;

    if (meta.yahoo) {
      try {
        const payload = await fetchJson(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.yahoo)}?interval=1d&range=1d`,
          { attempts: 2 },
        );
        const gelesen = parseYahoo(payload);
        if (gelesen) franken = inFranken(gelesen.kurs, gelesen.waehrung || meta.quote);
      } catch (err) {
        console.warn(`  ${key}: Yahoo nicht erreichbar (${err.message})`);
      }
    }

    if (franken === null && meta.stooq) {
      try {
        const csv = await fetchText(
          `https://stooq.com/q/l/?s=${encodeURIComponent(meta.stooq)}&f=sd2t2c&h&e=csv`,
          { attempts: 2 },
        );
        const roh = parseStooq(csv)[meta.stooq.toLowerCase()];
        if (roh) franken = inFranken(roh, meta.quote);
      } catch (err) {
        console.warn(`  ${key}: Stooq nicht erreichbar (${err.message})`);
      }
    }

    if (Number.isFinite(franken) && franken > 0) {
      assets[key] = Math.round(franken * 100) / 100;
    } else {
      console.warn(`  ${key}: kein Kurs von einer der Quellen.`);
    }
  }

  const geckoIds = Object.entries(ASSETS).filter(([, a]) => a.coingecko);
  if (geckoIds.length && !USE_FIXTURES) {
    try {
      const ids = geckoIds.map(([, a]) => a.coingecko).join(',');
      const payload = await fetchJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=chf`,
        { attempts: 2 },
      );
      for (const [key, meta] of geckoIds) {
        const kurs = Number(payload?.[meta.coingecko]?.chf);
        if (Number.isFinite(kurs) && kurs > 0) assets[key] = Math.round(kurs * 100) / 100;
      }
    } catch (err) {
      console.warn(`  Vergleichskurse von CoinGecko nicht erreichbar: ${err.message}`);
    }
  }

  return assets;
}

/* --- Nachfüllen ----------------------------------------------------------- */

/** Auf die volle Stunde abgerundeter UTC-Zeitstempel, unser Schlüssel je Datenpunkt. */
export function hourKey(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace('.000Z', 'Z');
}

/**
 * Welche vollen Stunden fehlen zwischen dem letzten Eintrag und jetzt?
 * GitHub verwirft geplante Läufe unter Last — ohne Nachfüllen bleiben die
 * Lücken für immer in der Reihe stehen.
 */
export function missingHours(entries, now, maxHours = BACKFILL_HOURS) {
  if (!entries.length) return [];

  const vorhanden = new Set(entries.map((e) => hourKey(e.t)));
  const bis = new Date(hourKey(now)).getTime();
  const frueheste = bis - maxHours * HOUR;
  const ab = Math.max(new Date(hourKey(entries[0].t)).getTime(), frueheste);

  const fehlend = [];
  for (let t = ab; t < bis; t += HOUR) {
    const key = hourKey(new Date(t));
    if (!vorhanden.has(key)) fehlend.push(key);
  }
  return fehlend;
}

/**
 * Der Bestand einer fehlenden Stunde lässt sich nur dann verlässlich angeben,
 * wenn er davor und danach derselbe war. Hat sich in der Lücke etwas bewegt,
 * bleibt sie offen — eine erfundene Zahl wäre schlimmer als ein Loch.
 */
export function satsForGap(entries, hour) {
  const t = new Date(hour).getTime();
  const davor = [...entries].reverse().find((e) => toTime(e.t) < t);
  const danach = entries.find((e) => toTime(e.t) > t);
  if (!davor || !danach) return null;
  return davor.sats === danach.sats ? davor.sats : null;
}

/**
 * Wandelt die Antwort von /api/v1/historical-price in unsere drei Währungen.
 *
 * Wird die Abfrage auf eine Währung eingeschränkt, liefert die Quelle auch nur
 * diese — genau daran scheiterte das Nachfüllen zuvor: Der Aufruf verlangte
 * CHF, die Prüfung danach aber alle drei. Ohne Einschränkung kommt USD plus
 * eine Tabelle der Wechselkurse, aus der sich der Rest ergibt.
 */
export function parseHistorical(payload) {
  const eintrag = Array.isArray(payload?.prices) ? payload.prices[0] : payload;
  if (!eintrag) return null;

  const kurse = payload?.exchangeRates ?? {};
  const usd = Number(eintrag.USD ?? eintrag.usd);
  const usdchf = Number(kurse.USDCHF ?? kurse.usdchf);
  const usdeur = Number(kurse.USDEUR ?? kurse.usdeur);

  const out = {
    usd,
    chf: Number(eintrag.CHF ?? eintrag.chf ?? (usd > 0 && usdchf > 0 ? usd * usdchf : NaN)),
    eur: Number(eintrag.EUR ?? eintrag.eur ?? (usd > 0 && usdeur > 0 ? usd * usdeur : NaN)),
  };

  if (!CURRENCIES.every((c) => Number.isFinite(out[c]) && out[c] > 0)) return null;
  return {
    chf: Math.round(out.chf * 100) / 100,
    eur: Math.round(out.eur * 100) / 100,
    usd: Math.round(out.usd * 100) / 100,
  };
}

/** Historischer Bitcoin-Kurs zu einem Zeitpunkt, in allen drei Währungen. */
async function historicalPrices(hour) {
  const stamp = Math.floor(new Date(hour).getTime() / 1000);
  const payload = await fetchJson(
    `https://mempool.space/api/v1/historical-price?timestamp=${stamp}`,
    { attempts: 2 },
  );

  const out = parseHistorical(payload);
  if (!out) {
    // Damit der nächste Lauf nicht wieder raten muss, was zurückkam.
    console.warn(`    unerwartete Antwortform: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return out;
}

async function backfill(entries, now) {
  const luecken = missingHours(entries, now);
  if (!luecken.length) return { entries, gefuellt: 0, uebersprungen: 0 };
  if (USE_FIXTURES) {
    console.log(`  ${luecken.length} Lücke(n) erkannt — im Fixture-Modus wird nicht nachgefüllt.`);
    return { entries, gefuellt: 0, uebersprungen: luecken.length };
  }

  console.log(`  ${luecken.length} fehlende Stunde(n) gefunden, fülle nach…`);
  let ergaenzt = [...entries];
  let gefuellt = 0;
  let uebersprungen = 0;

  for (const hour of luecken) {
    const sats = satsForGap(ergaenzt, hour);
    if (sats === null) {
      console.warn(`  ${hour}: Bestand hat sich in der Lücke bewegt — nicht nachfüllbar.`);
      uebersprungen += 1;
      continue;
    }
    try {
      const prices = await historicalPrices(hour);
      if (!prices) {
        console.warn(`  ${hour}: kein brauchbarer historischer Kurs.`);
        uebersprungen += 1;
        continue;
      }
      ergaenzt = normaliseEntries([...ergaenzt, { t: hour, sats, ...prices, bf: true }]);
      gefuellt += 1;
      await sleep(300); // die Quelle nicht überrennen
    } catch (err) {
      console.warn(`  ${hour}: Nachfüllen fehlgeschlagen (${err.message}).`);
      uebersprungen += 1;
    }
  }

  return { entries: ergaenzt, gefuellt, uebersprungen };
}

/* --- Datei ---------------------------------------------------------------- */

async function loadHistory() {
  if (!existsSync(DATA_FILE)) return { address: ADDRESS, startAt: START_AT, updatedAt: null, entries: [] };
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    return { ...parsed, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    throw new Error(`data/history.json ist nicht lesbar (${err.message}) — bitte prüfen statt überschreiben`);
  }
}

/**
 * Punkte älter als 30 Tage auf einen pro Tag reduzieren — und zwar auf den
 * ersten des Tages. Der ist der Mitternachts-Bezugspunkt, den die Auswertung
 * braucht; er darf nie wegfallen.
 */
export function downsample(entries, now = new Date()) {
  const cutoff = toTime(now) - FULL_RESOLUTION_DAYS * 24 * HOUR;
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
  const hour = hourKey(now);
  console.log(`Monetentracker-Snapshot ${now.toISOString()}${USE_FIXTURES ? ' (Fixtures)' : ''}`);

  const history = await loadHistory();

  // Der Workflow läuft zweimal pro Stunde, weil GitHub geplante Läufe unter Last
  // verschiebt oder ganz auslässt. Steht die Stunde schon in der Datei, bleibt
  // nur noch zu prüfen, ob ältere Lücken zu füllen sind.
  const stundeSteht = !FORCE && history.entries.some((e) => hourKey(e.t) === hour);

  let entries = normaliseEntries(history.entries);

  if (!stundeSteht) {
    const [sats, prices] = await Promise.all([loadBalance(), loadPrices()]);
    const assets = await loadAssets(prices);

    console.log(`  Bestand: ${(sats / 1e8).toFixed(8)} BTC`);
    console.log(`  Kurse:   ${prices.chf.toLocaleString('de-CH')} CHF / ${prices.eur} EUR / ${prices.usd} USD`);
    const namen = Object.keys(assets);
    console.log(`  Vergleich: ${namen.length ? namen.join(', ') : 'keine Quelle erreichbar'}`);

    entries = upsert(entries, { t: hour, sats, ...prices, ...(namen.length ? { assets } : {}) });
  } else {
    console.log(`  Stunde ${hour} ist bereits erfasst.`);
  }

  const nachgefuellt = await backfill(entries, now);
  entries = nachgefuellt.entries;
  if (nachgefuellt.gefuellt || nachgefuellt.uebersprungen) {
    console.log(`  Nachgefüllt: ${nachgefuellt.gefuellt}, übersprungen: ${nachgefuellt.uebersprungen}`);
  }

  if (stundeSteht && !nachgefuellt.gefuellt) {
    console.log('  Nichts zu tun.');
    return;
  }

  const next = {
    address: ADDRESS,
    startAt: START_AT,
    updatedAt: now.toISOString(),
    entries: downsample(entries, now),
  };

  if (DRY_RUN) {
    console.log('  --dry-run: nichts geschrieben');
    console.log(JSON.stringify(next.entries.at(-1), null, 2));
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
