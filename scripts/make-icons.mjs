#!/usr/bin/env node
/**
 * Erzeugt die App-Symbole aus einem SVG — gerendert mit dem Chromium, der für
 * die Oberflächenprüfung ohnehin da ist. So braucht das Projekt weder eine
 * Bildbibliothek noch abgelegte Binärdateien, die niemand mehr nachvollziehen
 * kann: die Vorlage steht hier im Klartext.
 *
 *   node scripts/make-icons.mjs
 *
 * Chromium wird über CHROMIUM_PATH oder den Standardpfad von Playwright gesucht.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'icons');

/** Mitternachtslinie und Kursverlauf — dieselbe Bildsprache wie im Verlauf. */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#07090d"/>
  <rect x="8" y="8" width="496" height="496" rx="88" fill="none" stroke="#1b2430" stroke-width="6"/>
  <line x1="150" y1="96" x2="150" y2="416" stroke="#3a4657" stroke-width="8" stroke-dasharray="18 16"/>
  <path d="M96 300 L150 268 L214 316 L278 214 L342 250 L416 150"
        fill="none" stroke="#ffa028" stroke-width="26"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="416" cy="150" r="22" fill="#ffa028"/>
</svg>`;

const GROESSEN = [
  { datei: 'icon-192.png', px: 192 },
  { datei: 'icon-512.png', px: 512 },
  { datei: 'apple-touch-icon.png', px: 180 },
];

const chromiumPfad =
  process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const { chromium } = await import('playwright-core').catch(() => {
  throw new Error('playwright-core wird zum Erzeugen der Symbole gebraucht: npm i -D playwright-core');
});

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'icon.svg'), `${SVG.trim()}\n`, 'utf8');

const browser = await chromium.launch({ executablePath: chromiumPfad });

for (const { datei, px } of GROESSEN) {
  const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${SVG}`,
  );
  await page.screenshot({ path: join(OUT, datei), omitBackground: true });
  await page.close();
  console.log(`  ${datei} (${px}×${px})`);
}

await browser.close();
console.log('Symbole geschrieben nach assets/icons/');
