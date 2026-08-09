#!/usr/bin/env node
/**
 * Prüft die Rechenlogik ohne Test-Framework: node scripts/test-calc.mjs
 * Schwerpunkte sind die Mitternachts-Basis (inkl. Zeitumstellung) und die
 * Trennung von Kursgewinn und Ein-/Auszahlungseffekt.
 */

import assert from 'node:assert/strict';

import {
  computeState,
  periodStats,
  zurichMidnight,
  zurichDayKey,
  normaliseEntries,
  formatAxisNumber,
  assetComparison,
} from '../assets/js/calc.js';
import {
  hourKey,
  upsert,
  downsample,
  parseStooq,
  missingHours,
  satsForGap,
  parseYahoo,
  parseHistorical,
} from './snapshot.mjs';
import { pickLine, daypart } from '../assets/js/lines.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FEHLER  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const near = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `erwartet ${b}, bekommen ${a}`);

const entry = (t, sats, chf) => ({ t, sats, chf, eur: chf * 0.92, usd: chf * 1.08 });

console.log('Zeitzone');

test('Mitternacht im Sommer ist 22:00 UTC am Vortag', () => {
  assert.equal(zurichMidnight('2026-08-09').toISOString(), '2026-08-08T22:00:00.000Z');
});

test('Mitternacht im Winter ist 23:00 UTC am Vortag', () => {
  assert.equal(zurichMidnight('2026-01-15').toISOString(), '2026-01-14T23:00:00.000Z');
});

test('Mitternacht am Tag der Zeitumstellung stimmt', () => {
  // Umstellung auf Winterzeit 2026: Sonntag, 25.10. — Mitternacht ist noch Sommerzeit.
  assert.equal(zurichMidnight('2026-10-25').toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(zurichMidnight('2026-10-26').toISOString(), '2026-10-25T23:00:00.000Z');
});

test('Tagesschlüssel nutzt Zürcher Ortszeit, nicht UTC', () => {
  // 22:30 UTC am 8.8. ist in Zürich bereits der 9.8.
  assert.equal(zurichDayKey(new Date('2026-08-08T22:30:00Z')), '2026-08-09');
});

console.log('Periodenrechnung');

test('reiner Kursgewinn ohne Bewegungen', () => {
  const s = periodStats(entry('2026-08-09T00:00:00Z', 50_000_000, 90_000), entry('2026-08-09T12:00:00Z', 50_000_000, 99_000), 'chf');
  near(s.hodlDelta, 4500); // 0.5 BTC * 9000 CHF
  near(s.hodlPct, 0.1);
  near(s.actualDelta, 4500);
  near(s.moveEffect, 0);
  assert.equal(s.moved, false);
});

test('Kursverlust wird negativ ausgewiesen', () => {
  const s = periodStats(entry('2026-08-09T00:00:00Z', 100_000_000, 100_000), entry('2026-08-09T12:00:00Z', 100_000_000, 80_000), 'chf');
  near(s.hodlDelta, -20_000);
  near(s.hodlPct, -0.2);
});

test('Einzahlung fällt in moveEffect, nicht in hodlDelta', () => {
  const s = periodStats(entry('2026-08-09T00:00:00Z', 50_000_000, 90_000), entry('2026-08-09T12:00:00Z', 70_000_000, 99_000), 'chf');
  near(s.hodlDelta, 4500); // unverändert: nur der Mitternachtsbestand zählt
  near(s.moveEffect, 0.2 * 99_000); // die zusätzlichen 0.2 BTC zum Jetzt-Kurs
  near(s.actualDelta, s.hodlDelta + s.moveEffect);
  assert.equal(s.moved, true);
});

test('Auszahlung um 00:00 ergibt exakt hodlDelta als entgangenen Betrag', () => {
  // Hätte er um 00:00 alles verkauft: 45_000 CHF. Derselbe Bestand ist jetzt 49_500 wert.
  const s = periodStats(entry('2026-08-09T00:00:00Z', 50_000_000, 90_000), entry('2026-08-09T12:00:00Z', 0, 99_000), 'chf');
  near(s.valueMid, 45_000);
  near(s.hodlNow, 49_500);
  near(s.hodlDelta, 4500);
  near(s.valueNow, 0);
  near(s.moveEffect, -49_500);
});

test('leere Wallet kippt die Rechnung nicht', () => {
  const s = periodStats(entry('2026-08-09T00:00:00Z', 0, 90_000), entry('2026-08-09T12:00:00Z', 0, 99_000), 'chf');
  near(s.hodlDelta, 0);
  near(s.actualPct, 0);
});

console.log('Gesamtzustand');

const data = {
  startAt: '2026-08-09T00:00:00+02:00',
  entries: [
    entry('2026-08-08T22:00:00Z', 50_000_000, 90_000), // 09.08. 00:00 Zürich
    entry('2026-08-09T06:00:00Z', 50_000_000, 93_000),
    entry('2026-08-09T22:00:00Z', 50_000_000, 88_000), // 10.08. 00:00 Zürich
    entry('2026-08-10T06:00:00Z', 60_000_000, 92_000),
  ],
};

test('heute rechnet ab der letzten Mitternacht, gesamt ab Startdatum', () => {
  const s = computeState(data, { now: new Date('2026-08-10T06:30:00Z') });
  assert.equal(s.hasData, true);
  assert.equal(s.todayComplete, true);
  near(s.today.hodlDelta, 0.5 * (92_000 - 88_000)); // seit 00:00 heute
  near(s.total.hodlDelta, 0.5 * (92_000 - 90_000)); // seit 09.08. 00:00
  near(s.balanceBtc, 0.6);
  near(s.valueNow, 0.6 * 92_000);
});

test('Währungsumschaltung greift durch', () => {
  const s = computeState(data, { currency: 'usd', now: new Date('2026-08-10T06:30:00Z') });
  near(s.today.hodlDelta, 0.5 * (92_000 - 88_000) * 1.08);
  near(s.price, 92_000 * 1.08);
});

test('beste und schlechteste Stunde werden gefunden', () => {
  const s = computeState(data, { now: new Date('2026-08-10T06:30:00Z') });
  assert.ok(s.hours.best.delta >= s.hours.worst.delta);
});

test('Messpunkte vor dem Startschuss zählen nicht mit', () => {
  // Der Sammler lief schon, die Show beginnt aber erst am 09.08. um 00:00.
  const vorlauf = {
    startAt: '2026-08-09T00:00:00+02:00',
    entries: [entry('2026-08-08T20:00:00Z', 462_029, 52_543)],
  };
  const s = computeState(vorlauf, { now: new Date('2026-08-08T20:30:00Z') });
  assert.equal(s.hasData, false);
  assert.equal(s.pending, true);
});

test('ab dem Startschuss verankert die Gesamtperiode auf Mitternacht', () => {
  const gemischt = {
    startAt: '2026-08-09T00:00:00+02:00',
    entries: [
      entry('2026-08-08T20:00:00Z', 462_029, 52_543), // Vorlauf, muss rausfallen
      entry('2026-08-08T22:00:00Z', 462_029, 53_000), // 09.08. 00:00 Zürich
      entry('2026-08-09T04:00:00Z', 462_029, 54_000),
    ],
  };
  const s = computeState(gemischt, { now: new Date('2026-08-09T04:30:00Z') });
  assert.equal(s.hasData, true);
  assert.equal(s.entries.length, 2);
  assert.equal(s.total.from, '2026-08-08T22:00:00Z');
  near(s.total.hodlDelta, 0.00462029 * (54_000 - 53_000));
});

test('ohne Daten meldet der Zustand den Wartemodus', () => {
  const s = computeState({ startAt: '2026-08-09T00:00:00+02:00', entries: [] }, { now: new Date('2026-08-08T10:00:00Z') });
  assert.equal(s.hasData, false);
  assert.equal(s.pending, true);
});

test('kaputte Einträge werden aussortiert und sortiert', () => {
  const cleaned = normaliseEntries([
    entry('2026-08-09T06:00:00Z', 1, 1),
    { t: 'kaputt', sats: 5 },
    null,
    entry('2026-08-09T00:00:00Z', 2, 2),
  ]);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0].t, '2026-08-09T00:00:00Z');
});

console.log('Snapshot-Helfer');

test('hourKey rundet auf die volle Stunde ab', () => {
  assert.equal(hourKey('2026-08-09T13:47:22.512Z'), '2026-08-09T13:00:00Z');
});

test('upsert ersetzt denselben Stundenpunkt statt zu doppeln', () => {
  const list = [entry('2026-08-09T13:00:00Z', 1, 100)];
  const next = upsert(list, { t: '2026-08-09T13:00:00Z', sats: 2, chf: 200, eur: 1, usd: 1 });
  assert.equal(next.length, 1);
  assert.equal(next[0].sats, 2);
});

test('eine bereits erfasste Stunde wird erkannt', () => {
  // Der Workflow läuft zweimal pro Stunde; der zweite Lauf muss aufhören,
  // sobald die Stunde in der Datei steht — sonst gäbe es zwei Commits.
  const entries = [entry('2026-08-09T02:00:00Z', 1, 1)];
  const belegt = (iso) => entries.some((e) => hourKey(e.t) === hourKey(iso));
  assert.equal(belegt('2026-08-09T02:31:00Z'), true);
  assert.equal(belegt('2026-08-09T03:01:00Z'), false);
});

test('Achsenbeschriftung bekommt so viele Stellen wie der Schritt verlangt', () => {
  // Der Fehler in freier Wildbahn: Werte um 242 CHF, Schritt 0.25 — ohne
  // Nachkommastellen stand auf der Achse fünfmal dieselbe Zahl.
  // Das Tausendertrennzeichen unterscheidet sich je nach ICU-Version von Node
  // und Chromium — hier zählt die Stellenzahl, nicht die Gruppierung.
  const ohneGruppe = (s) => s.replace(/[’']/g, '');

  assert.equal(formatAxisNumber(242.25, 0.25), '242.25');
  assert.equal(formatAxisNumber(242.5, 0.5), '242.5');
  assert.equal(ohneGruppe(formatAxisNumber(44_400, 200)), '44400');
  // Schritt 0.0025: die Linien unterscheiden sich erst in der vierten Stelle.
  assert.equal(formatAxisNumber(1.005, 0.0025), '1.0050');
});

test('downsample behält frische Stunden und je einen alten Tagespunkt', () => {
  const now = new Date('2026-12-01T12:00:00Z');
  const old = [
    entry('2026-08-08T22:00:00Z', 1, 1), // 09.08. 00:00 Zürich — muss bleiben
    entry('2026-08-09T05:00:00Z', 1, 1),
    entry('2026-08-09T09:00:00Z', 1, 1),
    entry('2026-08-09T22:00:00Z', 1, 1), // 10.08. 00:00 Zürich — muss bleiben
  ];
  const fresh = [entry('2026-11-30T22:00:00Z', 1, 1), entry('2026-12-01T11:00:00Z', 1, 1)];
  const out = downsample([...old, ...fresh], now);
  assert.deepEqual(
    out.map((e) => e.t),
    ['2026-08-08T22:00:00Z', '2026-08-09T22:00:00Z', '2026-11-30T22:00:00Z', '2026-12-01T11:00:00Z'],
  );
});

console.log('Anlagenvergleich');

const VERGLEICH = { gold: { name: 'Gold' }, smi: { name: 'SMI' } };

const mitKursen = (t, sats, chf, assets) => ({ ...entry(t, sats, chf), assets });

test('Umschichtung wird auf den Mitternachtswert gerechnet', () => {
  const base = mitKursen('2026-08-09T00:00:00Z', 100_000_000, 50_000, { gold: 5000, smi: 12_000 });
  const jetzt = mitKursen('2026-08-09T06:00:00Z', 100_000_000, 49_000, { gold: 5100, smi: 12_000 });
  const rows = assetComparison(base, jetzt, { assets: VERGLEICH });

  const gold = rows.find((r) => r.key === 'gold');
  near(gold.pct, 0.02); // 5000 -> 5100
  near(gold.delta, 1000); // 2 % von 50'000
  assert.equal(gold.closed, false);
});

test('ein geschlossener Auslandsmarkt gilt trotz wackelnder Umrechnung als geschlossen', () => {
  // Der Fall in freier Wildbahn, an einem Sonntag: Gold und der S&P bewegten
  // sich um exakt dieselben −0.053 %. Das war kein Markt, sondern der aus den
  // Bitcoin-Notierungen abgeleitete Umrechnungskurs.
  const usd = { gold: { name: 'Gold', quote: 'USD' } };
  const base = {
    ...entry('2026-08-09T07:00:00Z', 100_000_000, 50_000),
    assets: { gold: 3554.26 },
    fx: { USDCHF: 0.808 },
  };
  const jetzt = {
    ...entry('2026-08-09T08:00:00Z', 100_000_000, 50_000),
    // Derselbe Dollarkurs, nur eine andere Umrechnung.
    assets: { gold: Math.round(((3554.26 / 0.808) * 0.80757) * 100) / 100 },
    fx: { USDCHF: 0.80757 },
  };
  const gold = assetComparison(base, jetzt, { assets: usd }).find((r) => r.key === 'gold');
  assert.equal(gold.closed, true);
});

test('ohne abgelegten Umrechnungskurs bleibt es beim Frankenwert', () => {
  const usd = { gold: { name: 'Gold', quote: 'USD' } };
  const base = { ...entry('2026-08-09T07:00:00Z', 100_000_000, 50_000), assets: { gold: 3554.26 } };
  const jetzt = { ...entry('2026-08-09T08:00:00Z', 100_000_000, 50_000), assets: { gold: 3554.26 } };
  const gold = assetComparison(base, jetzt, { assets: usd }).find((r) => r.key === 'gold');
  assert.equal(gold.closed, true);
});

test('ein über Stunden unveränderter Index gilt als geschlossen', () => {
  const base = mitKursen('2026-08-09T00:00:00Z', 100_000_000, 50_000, { smi: 12_000 });
  const jetzt = mitKursen('2026-08-09T06:00:00Z', 100_000_000, 49_000, { smi: 12_000 });
  const smi = assetComparison(base, jetzt, { assets: VERGLEICH }).find((r) => r.key === 'smi');
  assert.equal(smi.closed, true);
});

test('Anlagen ohne Kurs fallen still heraus', () => {
  const base = mitKursen('2026-08-09T00:00:00Z', 100_000_000, 50_000, { gold: 5000 });
  const jetzt = mitKursen('2026-08-09T06:00:00Z', 100_000_000, 49_000, {});
  const rows = assetComparison(base, jetzt, { assets: VERGLEICH });
  assert.deepEqual(rows.filter((r) => !r.self).map((r) => r.key), []);
});

test('Bitcoin steht als eigene Zeile in derselben Tabelle', () => {
  const base = mitKursen('2026-08-09T00:00:00Z', 100_000_000, 50_000, { gold: 5000 });
  const jetzt = mitKursen('2026-08-09T06:00:00Z', 100_000_000, 55_000, { gold: 5000 });
  const btc = assetComparison(base, jetzt, { assets: VERGLEICH }).find((r) => r.self);
  near(btc.pct, 0.1);
  near(btc.delta, 5000);
});

test('das Sparkonto verzinst anteilig und steht immer da', () => {
  const base = mitKursen('2026-08-09T00:00:00Z', 100_000_000, 50_000, {});
  const jahrSpaeter = mitKursen('2027-08-09T00:00:00Z', 100_000_000, 50_000, {});
  const spar = assetComparison(base, jahrSpaeter, { assets: {}, savingsRate: 0.0075 }).find((r) => r.key === 'spar');
  near(spar.pct, 0.0075);
  near(spar.delta, 375);
});

test('die Rangliste ist nach Rendite sortiert', () => {
  const base = mitKursen('2026-08-09T00:00:00Z', 100_000_000, 50_000, { gold: 100, smi: 100 });
  const jetzt = mitKursen('2026-08-09T06:00:00Z', 100_000_000, 50_000, { gold: 90, smi: 110 });
  const rows = assetComparison(base, jetzt, { assets: VERGLEICH });
  // Bitcoin steht unverändert bei 50'000 und landet damit zwischen den beiden.
  assert.deepEqual(rows.map((r) => r.key), ['smi', 'btc', 'gold']);
});

test('fehlen Kurse um Mitternacht, beginnt der Vergleich später — für alle Zeilen', () => {
  // Der Fall in freier Wildbahn: Der Sammler schrieb Vergleichskurse erst ab
  // 07:00 mit. Bitcoin ab Mitternacht gegen Gold ab 07:00 zu stellen, wäre
  // ein Vergleich zweier verschiedener Zeitfenster.
  const daten = {
    startAt: '2026-08-09T00:00:00+02:00',
    entries: [
      mitKursen('2026-08-08T22:00:00Z', 100_000_000, 50_000, undefined), // Mitternacht, keine Kurse
      mitKursen('2026-08-09T05:00:00Z', 100_000_000, 52_000, { gold: 5000 }),
      mitKursen('2026-08-09T08:00:00Z', 100_000_000, 54_000, { gold: 5100 }),
    ],
  };
  const s = computeState(daten, { now: new Date('2026-08-09T08:30:00Z'), assets: VERGLEICH });

  assert.equal(s.comparison.from, '2026-08-09T05:00:00Z');
  assert.equal(s.comparison.abMitternacht, false);
  near(s.comparison.rows.find((r) => r.key === 'gold').pct, 0.02);
  // Bitcoin ab 05:00, nicht ab Mitternacht: 52'000 -> 54'000.
  near(s.comparison.rows.find((r) => r.self).pct, 2000 / 52_000);
  // Die Hauptzahl oben rechnet weiterhin ab Mitternacht.
  near(s.today.hodlPct, 4000 / 50_000);
});

test('liegen um Mitternacht Kurse vor, beginnt der Vergleich dort', () => {
  const daten = {
    startAt: '2026-08-09T00:00:00+02:00',
    entries: [
      mitKursen('2026-08-08T22:00:00Z', 100_000_000, 50_000, { gold: 5000 }),
      mitKursen('2026-08-09T08:00:00Z', 100_000_000, 54_000, { gold: 5100 }),
    ],
  };
  const s = computeState(daten, { now: new Date('2026-08-09T08:30:00Z'), assets: VERGLEICH });
  assert.equal(s.comparison.abMitternacht, true);
  assert.equal(s.comparison.from, '2026-08-08T22:00:00Z');
});

test('eine einzelne früh vorhandene Anlage bestimmt das Fenster nicht', () => {
  // Genau der Fall in den echten Daten: um 06:00 lag nur Ethereum vor, ab
  // 07:00 alle vier. Ab 06:00 zu rechnen hätte drei Anlagen hinausgeworfen.
  const drei = { gold: { name: 'Gold' }, smi: { name: 'SMI' }, eth: { name: 'Ethereum' } };
  const daten = {
    startAt: '2026-08-09T00:00:00+02:00',
    entries: [
      mitKursen('2026-08-08T22:00:00Z', 100_000_000, 50_000, undefined),
      mitKursen('2026-08-09T04:00:00Z', 100_000_000, 51_000, { eth: 1500 }),
      mitKursen('2026-08-09T05:00:00Z', 100_000_000, 52_000, { eth: 1510, gold: 5000, smi: 12_000 }),
      mitKursen('2026-08-09T08:00:00Z', 100_000_000, 54_000, { eth: 1520, gold: 5100, smi: 12_100 }),
    ],
  };
  const s = computeState(daten, { now: new Date('2026-08-09T08:30:00Z'), assets: drei });

  assert.equal(s.comparison.from, '2026-08-09T05:00:00Z');
  assert.deepEqual(
    s.comparison.rows.map((r) => r.key).sort(),
    ['btc', 'eth', 'gold', 'smi'],
  );
});

test('ein einzelner Punkt mit Kursen ergibt noch keinen Vergleich', () => {
  // Sonst verglichen wir den letzten Punkt mit sich selbst: überall 0.00 %,
  // und jede Zeile gälte als geschlossener Markt.
  const daten = {
    startAt: '2026-08-09T00:00:00+02:00',
    entries: [
      mitKursen('2026-08-08T22:00:00Z', 100_000_000, 50_000, undefined),
      mitKursen('2026-08-09T08:00:00Z', 100_000_000, 54_000, { gold: 5100 }),
    ],
  };
  const s = computeState(daten, { now: new Date('2026-08-09T08:30:00Z'), assets: VERGLEICH });
  assert.equal(s.comparison, null);
});

test('ohne Vergleichskurse gibt es gar keine Tafel', () => {
  const daten = {
    startAt: '2026-08-09T00:00:00+02:00',
    entries: [
      mitKursen('2026-08-08T22:00:00Z', 100_000_000, 50_000, undefined),
      mitKursen('2026-08-09T08:00:00Z', 100_000_000, 54_000, undefined),
    ],
  };
  const s = computeState(daten, { now: new Date('2026-08-09T08:30:00Z'), assets: VERGLEICH });
  assert.equal(s.comparison, null);
});

console.log('Vergleichskurse einlesen');

test('Stooq-CSV wird gelesen, N/D-Zeilen fallen weg', () => {
  const csv = [
    'Symbol,Date,Time,Close',
    'XAUUSD,2026-08-09,03:58:12,3421.55',
    '^SMI,2026-08-08,17:30:00,12040.50',
    '^SPX,N/D,N/D,N/D',
  ].join('\n');
  const kurse = parseStooq(csv);
  assert.equal(kurse.xauusd, 3421.55);
  assert.equal(kurse['^smi'], 12040.5);
  assert.equal('^spx' in kurse, false);
});

test('leere oder kaputte Antworten ergeben keine Kurse', () => {
  assert.deepEqual(parseStooq(''), {});
  assert.deepEqual(parseStooq('völlig anderes Format'), {});
});

test('Yahoo-Antwort liefert Kurs samt Notierungswährung', () => {
  const payload = { chart: { result: [{ meta: { regularMarketPrice: 3421.55, currency: 'USD' } }] } };
  assert.deepEqual(parseYahoo(payload), { kurs: 3421.55, waehrung: 'USD' });
});

test('Yahoo ohne Kurs ergibt nichts', () => {
  assert.equal(parseYahoo({ chart: { result: [{ meta: {} }] } }), null);
  assert.equal(parseYahoo({}), null);
  assert.equal(parseYahoo({ chart: { error: 'Not Found' } }), null);
});

console.log('Lückenfüllung');

test('historischer Kurs wird aus USD und Wechselkursen ergänzt', () => {
  // Genau hier lag der Fehler: Die Abfrage lieferte nur eine Währung, die
  // Prüfung verlangte aber alle drei — es wurde nie etwas nachgefüllt.
  const payload = {
    prices: [{ time: 1_754_697_600, USD: 64_790 }],
    exchangeRates: { USDCHF: 0.808, USDEUR: 0.8657 },
  };
  const out = parseHistorical(payload);
  near(out.usd, 64_790);
  near(out.chf, 52_350.32, 0.01);
  near(out.eur, 56_088.7, 0.01);
});

test('liefert die Quelle die Währung direkt, wird sie genommen', () => {
  const out = parseHistorical({ prices: [{ USD: 100, CHF: 81, EUR: 87 }] });
  assert.deepEqual(out, { usd: 100, chf: 81, eur: 87 });
});

test('ohne Wechselkurse und ohne Währungen gibt es keinen Punkt', () => {
  assert.equal(parseHistorical({ prices: [{ USD: 64_790 }] }), null);
  assert.equal(parseHistorical({ prices: [] }), null);
  assert.equal(parseHistorical({}), null);
});

const reiheMitLoch = [
  entry('2026-08-09T00:00:00Z', 462_029, 52_449),
  entry('2026-08-09T02:00:00Z', 462_029, 52_349),
  entry('2026-08-09T04:00:00Z', 462_029, 52_342),
];

test('fehlende Stunden werden erkannt', () => {
  assert.deepEqual(missingHours(reiheMitLoch, new Date('2026-08-09T05:10:00Z')), [
    '2026-08-09T01:00:00Z',
    '2026-08-09T03:00:00Z',
  ]);
});

test('ohne Lücke gibt es nichts nachzufüllen', () => {
  const dicht = [entry('2026-08-09T00:00:00Z', 1, 1), entry('2026-08-09T01:00:00Z', 1, 1)];
  assert.deepEqual(missingHours(dicht, new Date('2026-08-09T02:00:00Z')), []);
});

test('der Nachfüllzeitraum ist begrenzt', () => {
  // Ohne Begrenzung wären es über 1600 Stunden zurück bis zum 1. Juni.
  const alt = [entry('2026-06-01T00:00:00Z', 1, 1), entry('2026-08-09T04:00:00Z', 1, 1)];
  assert.deepEqual(missingHours(alt, new Date('2026-08-09T05:00:00Z'), 3), [
    '2026-08-09T02:00:00Z',
    '2026-08-09T03:00:00Z',
  ]);
});

test('bei unverändertem Bestand ist die Lücke füllbar', () => {
  assert.equal(satsForGap(reiheMitLoch, '2026-08-09T01:00:00Z'), 462_029);
});

test('bewegte sich der Bestand, bleibt die Lücke offen', () => {
  const bewegt = [
    entry('2026-08-09T00:00:00Z', 462_029, 52_449),
    entry('2026-08-09T02:00:00Z', 300_000, 52_349),
  ];
  assert.equal(satsForGap(bewegt, '2026-08-09T01:00:00Z'), null);
});

console.log('Sprüche');

test('kein Spruch spricht zur falschen Tageszeit', () => {
  // Der Fehler in freier Wildbahn: "Der Abend ist jung" stand um 06:00 auf der Seite.
  // Wortgrenzen sind Pflicht: "Mitternacht" ist der Bezugspunkt der Rechnung
  // und keine Tageszeitangabe — der Spruch darf zu jeder Stunde stehen.
  const tabu = {
    nacht: /\b(morgen|mittag|abend)\b/i,
    morgen: /\b(abend|nacht|mittag)\b/i,
    tag: /\b(abend|nacht)\b/i,
    abend: /\b(morgen|nacht)\b/i,
  };

  for (let h = 0; h < 24; h += 1) {
    for (const pct of [0.05, 0.01, 0, -0.01, -0.05]) {
      const satz = pickLine(pct, h);
      const zeit = daypart(h);
      assert.ok(
        !tabu[zeit].test(satz),
        `Stunde ${h} (${zeit}) liefert einen unpassenden Spruch: "${satz}"`,
      );
    }
  }
});

test('die Tageszeiten teilen den Tag lückenlos auf', () => {
  assert.equal(daypart(0), 'nacht');
  assert.equal(daypart(4), 'nacht');
  assert.equal(daypart(5), 'morgen');
  assert.equal(daypart(10), 'morgen');
  assert.equal(daypart(11), 'tag');
  assert.equal(daypart(17), 'tag');
  assert.equal(daypart(18), 'abend');
  assert.equal(daypart(23), 'abend');
});

test('zu jeder Stunde und jeder Wucht gibt es einen Spruch', () => {
  for (let h = 0; h < 24; h += 1) {
    for (const pct of [0.5, 0.05, 0.01, 0, -0.01, -0.05, -0.5]) {
      const satz = pickLine(pct, h);
      assert.ok(typeof satz === 'string' && satz.length > 10, `Stunde ${h}, ${pct}: "${satz}"`);
    }
  }
});

test('der Spruch bleibt innerhalb derselben Stunde stabil', () => {
  assert.equal(pickLine(-0.01, 6), pickLine(-0.01, 6));
});

test('über den Tag kommt mehr als ein Spruch zum Zug', () => {
  // Mit schlichtem "hour % länge" lieferten 03, 06, 09 und 14 Uhr denselben Satz.
  const proWucht = [0.05, -0.01].map((pct) => {
    const alle = Array.from({ length: 24 }, (_, h) => pickLine(pct, h));
    return new Set(alle).size;
  });
  proWucht.forEach((anzahl) => assert.ok(anzahl >= 3, `nur ${anzahl} verschiedene Sprüche über 24 Stunden`));
});

test('die Bitcoin-Ansicht hat ihren eigenen Spruch', () => {
  assert.match(pickLine(-0.01, 6, { btcMode: true }), /rechnet man in Franken/);
});

console.log(`\n${passed} Prüfungen bestanden${process.exitCode ? ' — mit Fehlern' : ''}`);
