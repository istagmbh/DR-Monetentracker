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
} from '../assets/js/calc.js';
import { hourKey, upsert, downsample } from './snapshot.mjs';

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

console.log(`\n${passed} Prüfungen bestanden${process.exitCode ? ' — mit Fehlern' : ''}`);
