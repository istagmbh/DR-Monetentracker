#!/usr/bin/env node
/**
 * Erzeugt data/demo-history.json: erfundene Stundendaten, damit sich die
 * Oberfläche vollständig prüfen lässt, bevor am 09.08. echte Werte kommen.
 * Aufruf im Browser über index.html?demo=1
 *
 * Enthält bewusst eine Ein- und eine Auszahlung, damit der Unterschied
 * zwischen "unangetastet" und "tatsächlich" sichtbar wird.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADDRESS, START_AT } from '../assets/js/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'demo-history.json');

const HOURS = 84; // dreieinhalb Tage
const START_SATS = 42_000_000;

/** Deterministischer Zufall, damit die Demo-Datei reproduzierbar bleibt. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const rand = lcg(20260809);
const entries = [];
let chf = 91_235;
let sats = START_SATS;

// Vergleichsanlagen: Gold und Ethereum bewegen sich rund um die Uhr, die
// Aktienindizes stehen ausserhalb der Handelszeiten still — genau das soll die
// Vorschau zeigen, damit "Markt geschlossen" auch sichtbar wird.
let gold = 3_170;
let eth = 2_840;
const SMI = 12_040.5;
const SPX = 5_229.63;

for (let i = 0; i < HOURS; i += 1) {
  const t = new Date(Date.parse(START_AT) + i * 3600 * 1000);

  // Zufälliger Gang mit leichtem Aufwärtsdrall und einem Absacker in der Nacht.
  const drift = 0.0008;
  const shock = i === 30 ? -0.035 : i === 58 ? 0.028 : 0;
  chf *= 1 + drift * (rand() * 2 - 1) * 6 + shock;

  // Eine Einzahlung am zweiten Tag, eine Auszahlung am laufenden Tag —
  // damit die Zappelei-Abrechnung in der Vorschau auch wirklich auftaucht.
  if (i === 34) sats += 15_000_000;
  if (i === 78) sats -= 8_000_000;

  gold *= 1 + 0.0004 * (rand() * 2 - 1) * 4;
  eth *= 1 + 0.0012 * (rand() * 2 - 1) * 5;

  // Der SMI notiert werktags von 09:00 bis 17:30 Zürcher Zeit; ausserhalb steht
  // der Schlusskurs. Für die Vorschau genügt diese grobe Nachbildung.
  const stundeZH = (t.getUTCHours() + 2) % 24;
  const boerseOffen = stundeZH >= 9 && stundeZH < 18;
  const zeitfaktor = boerseOffen ? 1 + 0.0006 * (i % 7) : 1;

  entries.push({
    t: new Date(Math.floor(t.getTime() / 3600000) * 3600000).toISOString().replace('.000Z', 'Z'),
    sats,
    chf: Math.round(chf * 100) / 100,
    eur: Math.round(chf * 0.922 * 100) / 100,
    usd: Math.round(chf * 1.079 * 100) / 100,
    assets: {
      gold: Math.round(gold * 100) / 100,
      spx: Math.round(SPX * zeitfaktor * 100) / 100,
      smi: Math.round(SMI * zeitfaktor * 100) / 100,
      eth: Math.round(eth * 100) / 100,
    },
  });
}

const payload = {
  address: ADDRESS,
  startAt: START_AT,
  updatedAt: entries.at(-1).t,
  demo: true,
  entries,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Demo-Daten geschrieben: ${entries.length} Punkte -> data/demo-history.json`);
