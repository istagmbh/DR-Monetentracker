/** Die beobachtete Wallet und der Startzeitpunkt der Show. */
export const ADDRESS = 'bc1q4cekdujg8yclq924rn7j7jnkwfk44gnrjxut6z';

/** Ab hier wird stündlich gemessen: 09.08. um Punkt 00:00 Zürcher Zeit. */
export const START_AT = '2026-08-09T00:00:00+02:00';

export const DATA_URL = 'data/history.json';
export const DEMO_URL = 'data/demo-history.json';

/** Wie oft die offene Seite nach frischen Daten schaut. */
export const REFRESH_MS = 5 * 60 * 1000;

/** Wie lange ein Filmzitat stehen bleibt. */
export const QUOTE_MS = 12_000;

/**
 * Vergleichsanlagen für die Frage "was, wenn er um 00:00 umgeschichtet hätte".
 * Alle Kurse werden in Franken abgelegt; `usd: true` heisst, die Quelle notiert
 * in Dollar und wird beim Einsammeln umgerechnet.
 *
 * Aktienindizes handeln nicht rund um die Uhr. Bleibt ein Kurs zwischen
 * Mitternacht und jetzt exakt gleich, wertet die Anzeige das als geschlossenen
 * Markt — bei einem Index über mehrere Stunden ist ein unveränderter Kurs sonst
 * praktisch ausgeschlossen.
 */
export const ASSETS = {
  gold: { name: 'Gold', stooq: 'xauusd', usd: true },
  spx: { name: 'S&P 500', stooq: '^spx', usd: true },
  smi: { name: 'SMI', stooq: '^smi', usd: false },
  eth: { name: 'Ethereum', coingecko: 'ethereum' },
};

/** Zinssatz des Vergleichs-Sparkontos, pro Jahr. */
export const SAVINGS_RATE = 0.0075;

/** So weit zurück füllt der Sammler fehlende Stunden nach. */
export const BACKFILL_HOURS = 48;
