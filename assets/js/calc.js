/**
 * Die gesamte Mathematik des Monetentrackers — bewusst frei von DOM und Netzwerk,
 * damit sie sowohl im Browser als auch in Node (Tests, Snapshot-Skript) läuft.
 *
 * Kernfrage der App:
 *   "Was wäre, wenn er um Punkt 00:00 weder ein- noch ausbezahlt hätte?"
 *
 * Antwort: der Mitternachts-Bestand, bewertet zum jetzigen Kurs, minus sein Wert
 * um Mitternacht. Das ist zugleich die Antwort auf "hätte er um 00:00 ausbezahlt" —
 * der Erlös um Mitternacht wäre valueMid gewesen, derselbe Bestand ist jetzt
 * hodlNow wert, die Differenz ist identisch.
 */

export const TZ = 'Europe/Zurich';
export const SATS_PER_BTC = 100_000_000;
export const CURRENCIES = ['chf', 'eur', 'usd'];

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Datums-/Zeitbestandteile eines Zeitpunkts in Zürcher Ortszeit. */
export function zurichParts(date) {
  const out = {};
  for (const { type, value } of partsFormatter.formatToParts(date)) {
    if (type !== 'literal') out[type] = value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** Tagesschlüssel in Zürcher Ortszeit, z.B. "2026-08-09". */
export function zurichDayKey(date) {
  const p = zurichParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Offset der Zone zum gegebenen Zeitpunkt in Millisekunden (DST-korrekt). */
function tzOffsetMs(date) {
  const p = zurichParts(date);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * 00:00 Zürcher Ortszeit eines Tages als echter UTC-Zeitpunkt.
 * Zwei Durchläufe, damit auch die Zeitumstellungs-Nächte stimmen.
 */
export function zurichMidnight(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let ts = naive - tzOffsetMs(new Date(naive));
  ts = naive - tzOffsetMs(new Date(ts));
  return new Date(ts);
}

export const toTime = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
export const btcOf = (entry) => (entry ? entry.sats / SATS_PER_BTC : 0);
export const priceOf = (entry, cur) => (entry ? Number(entry[cur] ?? 0) : 0);

/** Einträge aufsteigend nach Zeit, ohne kaputte Datensätze. */
export function normaliseEntries(entries) {
  return (entries || [])
    .filter((e) => e && Number.isFinite(Number(e.sats)) && Number.isFinite(toTime(e.t)))
    .map((e) => ({ ...e, sats: Number(e.sats) }))
    .sort((a, b) => toTime(a.t) - toTime(b.t));
}

/**
 * Der Eintrag, der eine Periode eröffnet: der erste ab dem Stichtag.
 * Gibt es keinen (Tracking startete später), fällt es auf den ersten
 * vorhandenen Eintrag zurück — dann ist die Periode eben kürzer.
 */
export function baselineAt(entries, from) {
  if (!entries.length) return null;
  const target = toTime(from);
  return entries.find((e) => toTime(e.t) >= target) || null;
}

/**
 * Kennzahlen einer Periode zwischen Basis- und Jetzt-Eintrag.
 *
 *   hodlDelta   btcMid * (pNow - pMid)   die Hauptzahl der App
 *   actualDelta valueNow - valueMid      was tatsächlich passiert ist
 *   moveEffect  actualDelta - hodlDelta  Effekt der Ein-/Auszahlungen
 */
export function periodStats(baseEntry, nowEntry, cur) {
  if (!baseEntry || !nowEntry) return null;

  const pMid = priceOf(baseEntry, cur);
  const pNow = priceOf(nowEntry, cur);
  const btcMid = btcOf(baseEntry);
  const btcNow = btcOf(nowEntry);

  const valueMid = btcMid * pMid;
  const valueNow = btcNow * pNow;
  const hodlNow = btcMid * pNow;
  const hodlDelta = hodlNow - valueMid;
  const actualDelta = valueNow - valueMid;

  return {
    from: baseEntry.t,
    to: nowEntry.t,
    priceMid: pMid,
    priceNow: pNow,
    btcMid,
    btcNow,
    btcDelta: btcNow - btcMid,
    valueMid,
    valueNow,
    hodlNow,
    hodlDelta,
    hodlPct: pMid > 0 ? pNow / pMid - 1 : 0,
    actualDelta,
    actualPct: valueMid > 0 ? valueNow / valueMid - 1 : 0,
    moveEffect: actualDelta - hodlDelta,
    moved: Math.abs(btcNow - btcMid) > 1e-12,
  };
}

/**
 * Beste und schlechteste Stunde einer Periode, jeweils in Hodl-Logik gerechnet:
 * der Bestand zu Beginn der Stunde, bewertet mit der Kursbewegung dieser Stunde.
 */
export function extremeHours(entries, cur) {
  let best = null;
  let worst = null;
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const cell = {
      t: entries[i].t,
      delta: btcOf(prev) * (priceOf(entries[i], cur) - priceOf(prev, cur)),
    };
    if (!best || cell.delta > best.delta) best = cell;
    if (!worst || cell.delta < worst.delta) worst = cell;
  }
  return { best, worst };
}

/**
 * Zwei Kurven für den Chart:
 *   hodl   — der Mitternachts-Bestand über die Zeit bewertet (unangetastet)
 *   actual — der echte Bestand über die Zeit bewertet
 * Bei einer Wallet ohne Bewegungen liegen sie exakt übereinander.
 */
export function series(entries, baseEntry, cur) {
  const btcMid = btcOf(baseEntry);
  return entries.map((e) => ({
    t: toTime(e.t),
    hodl: btcMid * priceOf(e, cur),
    actual: btcOf(e) * priceOf(e, cur),
    price: priceOf(e, cur),
    sats: e.sats,
  }));
}

/**
 * Alles, was die Oberfläche braucht, in einem Rutsch.
 * `now` ist injizierbar, damit Tests nicht von der Systemuhr abhängen.
 */
export function computeState(data, { currency = 'chf', now = new Date() } = {}) {
  const cur = CURRENCIES.includes(currency) ? currency : 'chf';
  const entries = normaliseEntries(data?.entries);
  const startAt = data?.startAt ? new Date(data.startAt) : null;

  if (!entries.length) {
    return {
      currency: cur,
      entries,
      startAt,
      latest: null,
      hasData: false,
      pending: !!startAt && toTime(now) < toTime(startAt),
    };
  }

  const latest = entries[entries.length - 1];
  const todayMidnight = zurichMidnight(zurichDayKey(new Date(toTime(latest.t))));

  const todayBase = baselineAt(entries, todayMidnight) || entries[0];
  const startBase = (startAt && baselineAt(entries, startAt)) || entries[0];

  const todayEntries = entries.filter((e) => toTime(e.t) >= toTime(todayBase.t));

  return {
    currency: cur,
    entries,
    startAt,
    latest,
    hasData: true,
    pending: false,
    todayMidnight,
    // War um Mitternacht schon ein Messpunkt da, oder startete das Tracking mittendrin?
    todayComplete: toTime(todayBase.t) - toTime(todayMidnight) < 90 * 60 * 1000,
    today: periodStats(todayBase, latest, cur),
    total: periodStats(startBase, latest, cur),
    hours: extremeHours(todayEntries.length > 1 ? todayEntries : entries, cur),
    chart: series(entries, startBase, cur),
    chartToday: series(todayEntries, todayBase, cur),
    balanceBtc: btcOf(latest),
    balanceSats: latest.sats,
    price: priceOf(latest, cur),
    valueNow: btcOf(latest) * priceOf(latest, cur),
  };
}
