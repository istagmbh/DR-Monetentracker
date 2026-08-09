/**
 * Zusammenbau der Oberfläche: Daten laden, rechnen lassen, anzeigen.
 * Rechnet nichts selbst — das macht calc.js — und ruft keine fremden APIs auf.
 * Die Seite lebt allein von data/history.json, das der stündliche Workflow pflegt.
 */

import { computeState, formatAxisNumber, TZ } from './calc.js';
import { ADDRESS, START_AT, DATA_URL, DEMO_URL, REFRESH_MS, QUOTE_MS } from './config.js';
import { setOdometer } from './odometer.js';
import { renderChart } from './chart.js';
import { createQuoteDeck } from './quotes.js';

const $ = (sel) => document.querySelector(sel);
const isDemo = new URLSearchParams(location.search).has('demo');

const UNITS = { chf: 'CHF', eur: 'EUR', usd: 'USD', btc: '₿' };

const state = {
  data: null,
  display: localStorage.getItem('mt-currency') || 'chf',
  range: 'today',
};

/* --- Formatierung --------------------------------------------------------- */

const decimal = (min, max) => new Intl.NumberFormat('de-CH', { minimumFractionDigits: min, maximumFractionDigits: max });

const fmt2 = decimal(2, 2);
const fmt0 = decimal(0, 0);
/** Bitcoin-Beträge: bis zu acht Nachkommastellen, aber ohne Null-Friedhof. */
const fmtBtc = decimal(2, 8);

/** In der BTC-Ansicht rechnen wir intern weiter in Franken. */
const dataCurrency = (display) => (display === 'btc' ? 'chf' : display);

function money(value, { compact = false, unit = true, currency = state.display } = {}) {
  const abs = Math.abs(value);
  const body = compact && abs >= 10_000 ? fmt0.format(value) : fmt2.format(value);
  return unit ? `${body} ${UNITS[currency]}` : body;
}

/** Mit Vorzeichen — das echte Minuszeichen sieht in der Walze besser aus. */
function signed(value, opts = {}) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return `${sign}${money(Math.abs(value), opts)}`;
}

const pct = (value) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${fmt2.format(Math.abs(value * 100))} %`;

const timeFmt = new Intl.DateTimeFormat('de-CH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('de-CH', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const clockOf = (t) => timeFmt.format(new Date(t));
const stampOf = (t) => dateTimeFmt.format(new Date(t));

/* --- Sprüche ------------------------------------------------------------- */

/** Kommentar des Hauses, abhängig von Richtung und Wucht der Bewegung. */
function punchline(stats, display) {
  if (display === 'btc') {
    return 'In Bitcoin gerechnet hat er exakt nichts gewonnen. Genau deshalb rechnet man in Franken.';
  }

  const p = stats.hodlPct;
  const lines = {
    bigWin: [
      'Nichtstun war heute die bestbezahlte Tätigkeit der Schweiz.',
      'Er hat geschlafen und dabei mehr verdient als das halbe Grossraumbüro.',
      'Die beste Anlagestrategie des Tages: Hände weg vom Gerät.',
    ],
    win: [
      'Ein solider Tag für die Fraktion Hände-in-den-Taschen.',
      'Faulheit zahlt sich aus. Heute jedenfalls.',
    ],
    flat: [
      'Bewegung: keine der Rede wert.',
      'Der Kurs steht so still, dass man die Uhr danach stellen könnte.',
    ],
    loss: [
      'Hätte er um Mitternacht ausbezahlt, sässe er jetzt entspannter.',
      'Kleiner Dämpfer. Der Abend ist jung.',
    ],
    bigLoss: [
      'Um Punkt 00:00 auszahlen wäre die Idee des Tages gewesen.',
      'Diese Zahl ersetzt jeden Kaffee.',
      'Der Markt hat heute eine Meinung, und sie ist nicht schmeichelhaft.',
    ],
  };

  const key = p > 0.03 ? 'bigWin' : p > 0.002 ? 'win' : p < -0.03 ? 'bigLoss' : p < -0.002 ? 'loss' : 'flat';
  const pool = lines[key];
  // Ueber die Stunde gestreut, damit der Spruch nicht bei jedem Rendern springt.
  return pool[new Date().getHours() % pool.length];
}

/* --- Rendern -------------------------------------------------------------- */

function setTone(el, value) {
  el.classList.toggle('is-win-text', value > 0);
  el.classList.toggle('is-loss-text', value < 0);
}

function renderHero(s) {
  const hero = $('#hero');
  const btc = state.display === 'btc';
  const delta = btc ? 0 : s.today.hodlDelta;

  hero.classList.toggle('is-win', delta > 0);
  hero.classList.toggle('is-loss', delta < 0);

  const text = btc ? `±${fmtBtc.format(0)} ₿` : signed(s.today.hodlDelta);
  setOdometer($('#hero-odometer'), text);

  $('#hero-question').textContent = s.todayComplete
    ? 'Hätte er heute um Punkt 00:00 weder ein- noch ausbezahlt, dann stünde er jetzt bei'
    : 'Seit der ersten Messung heute — Mitternacht lag vor dem Start — steht er bei';

  const badge = $('#hero-pct');
  badge.textContent = btc ? '±0.00 %' : pct(s.today.hodlPct);

  $('#hero-since').textContent = `seit ${clockOf(s.today.from)} · Stand ${clockOf(s.latest.t)}`;
  $('#hero-punchline').textContent = punchline(s.today, state.display);
}

function renderCards(s) {
  const btc = state.display === 'btc';

  $('#card-value').textContent = btc ? `${fmtBtc.format(s.balanceBtc)} ₿` : money(s.valueNow, { compact: true });
  $('#card-value-note').textContent = btc
    ? `entspricht ${fmt2.format(s.valueNow)} CHF`
    : `${fmtBtc.format(s.balanceBtc)} ₿ zum Kurs von ${money(s.price, { compact: true })}`;

  $('#card-balance').textContent = `${fmtBtc.format(s.balanceBtc)} ₿`;
  $('#card-balance-note').textContent = `${fmt0.format(s.balanceSats)} Satoshi`;

  $('#card-price').textContent = money(s.price, { compact: true, currency: dataCurrency(state.display) });
  $('#card-price-note').textContent = 'pro Bitcoin';

  const total = $('#card-total');
  total.textContent = btc ? `±${fmtBtc.format(0)} ₿` : signed(s.total.hodlDelta, { compact: true });
  setTone(total, btc ? 0 : s.total.hodlDelta);
  $('#card-total-note').textContent = btc
    ? 'Bitcoin bleibt Bitcoin — der Bestand ändert sich nur durch Ein- und Auszahlungen.'
    : `seit ${stampOf(s.total.from)} · ${pct(s.total.hodlPct)}`;

  const best = $('#card-best');
  const worst = $('#card-worst');

  if (s.hours.best && !btc) {
    best.textContent = signed(s.hours.best.delta, { compact: true });
    setTone(best, s.hours.best.delta);
    $('#card-best-note').textContent = `um ${clockOf(s.hours.best.t)}`;
    worst.textContent = signed(s.hours.worst.delta, { compact: true });
    setTone(worst, s.hours.worst.delta);
    $('#card-worst-note').textContent = `um ${clockOf(s.hours.worst.t)}`;
  } else {
    best.textContent = '—';
    worst.textContent = '—';
    $('#card-best-note').textContent = btc ? 'in Franken interessanter' : 'noch keine volle Stunde gemessen';
    $('#card-worst-note').textContent = $('#card-best-note').textContent;
  }

  // Ein- und Auszahlungen bekommen ihre eigene Abrechnung, damit die Hauptzahl sauber bleibt.
  const moveCard = $('#card-move');
  moveCard.hidden = !s.today.moved || btc;
  if (!moveCard.hidden) {
    const el = $('#card-move-value');
    el.textContent = signed(s.today.moveEffect, { compact: true });
    setTone(el, s.today.moveEffect);
    const direction = s.today.btcDelta > 0 ? 'eingezahlt' : 'ausbezahlt';
    $('#card-move-note').textContent =
      `Seit Mitternacht wurden ${fmtBtc.format(Math.abs(s.today.btcDelta))} ₿ ${direction}. ` +
      'Dieser Betrag steckt im aktuellen Wert, hat mit dem Kurs aber nichts zu tun.';
  }
}

function renderChartPanel(s) {
  const points = state.range === 'today' ? s.chartToday : s.chart;
  const long = state.range === 'all';
  const showActual = points.some((p) => Math.abs(p.actual - p.hodl) > 1e-9);

  renderChart($('#chart'), {
    points,
    showActual,
    formatValue: (v, axis = false, step = 1) =>
      axis ? formatAxisNumber(v, step) : money(v, { compact: true, currency: dataCurrency(state.display) }),
    formatTime: (t, detailed = false) => (long || detailed ? stampOf(t) : clockOf(t)),
  });
}

function renderLive(s) {
  const minutes = Math.round((Date.now() - new Date(s.latest.t).getTime()) / 60000);
  const age = minutes < 90 ? `vor ${Math.max(minutes, 0)} Min.` : `am ${stampOf(s.latest.t)}`;
  $('#chip-live-text').textContent = isDemo ? 'Vorschaumodus mit erfundenen Zahlen' : `Letzte Messung ${age}`;
  $('#foot-updated').textContent = `Stand ${stampOf(s.latest.t)} Uhr.`;
}

function render() {
  const s = computeState(state.data, { currency: dataCurrency(state.display) });

  $('#countdown').hidden = s.hasData;
  $('#app').hidden = !s.hasData;

  if (!s.hasData) {
    $('#chip-live-text').textContent = s.pending
      ? 'Startschuss am 9. August um 00:00'
      : 'Warte auf die erste Messung';
    $('#foot-updated').textContent = '';
    renderCountdown();
    return;
  }

  renderHero(s);
  renderCards(s);
  renderChartPanel(s);
  renderLive(s);
}

/* --- Wartezustand --------------------------------------------------------- */

let countdownTimer = null;

function renderCountdown() {
  const start = new Date(START_AT);
  const tick = () => {
    const left = start.getTime() - Date.now();
    if (left <= 0) {
      $('#countdown-clock').textContent = '00 : 00 : 00';
      $('#countdown-note').textContent =
        'Der Startschuss ist gefallen — die erste stündliche Messung landet gleich hier.';
      clearInterval(countdownTimer);
      return;
    }
    const d = Math.floor(left / 86400000);
    const h = Math.floor(left / 3600000) % 24;
    const m = Math.floor(left / 60000) % 60;
    const sec = Math.floor(left / 1000) % 60;
    const pad = (n) => String(n).padStart(2, '0');
    $('#countdown-clock').textContent = (d > 0 ? `${d} T · ` : '') + `${pad(h)} : ${pad(m)} : ${pad(sec)}`;
  };

  tick();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
}

/* --- Filmzitate ----------------------------------------------------------- */

function startQuotes() {
  const stage = document.querySelector('.quote');
  const textEl = $('#quote-text');
  const citeEl = $('#quote-cite');
  const draw = createQuoteDeck();
  let timer = null;

  const show = (immediate = false) => {
    const { q, film, year } = draw();
    const paint = () => {
      textEl.textContent = `„${q}“`;
      citeEl.textContent = `${film} · ${year}`;
      stage.classList.remove('is-swapping');
    };

    if (immediate) {
      paint();
      return;
    }
    stage.classList.add('is-swapping');
    setTimeout(paint, 350);
  };

  const restart = () => {
    clearInterval(timer);
    timer = setInterval(() => show(), QUOTE_MS);
  };

  show(true);
  restart();

  $('#quote-next').addEventListener('click', () => {
    show();
    restart();
  });
}

/* --- Daten und Bedienung -------------------------------------------------- */

async function loadData() {
  const url = `${isDemo ? DEMO_URL : DATA_URL}?ts=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    console.warn('Daten konnten nicht geladen werden:', err.message);
    state.data ??= { startAt: START_AT, entries: [] };
    $('#chip-live-text').textContent = 'Keine Verbindung zum Tresor';
  }
  render();
}

function wireSwitches() {
  document.querySelectorAll('[data-currency]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.currency === state.display);
    btn.addEventListener('click', () => {
      state.display = btn.dataset.currency;
      localStorage.setItem('mt-currency', state.display);
      document
        .querySelectorAll('[data-currency]')
        .forEach((b) => b.classList.toggle('is-active', b === btn));
      render();
    });
  });

  document.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('is-active', b === btn));
      render();
    });
  });
}

$('#chip-address').textContent = `${ADDRESS.slice(0, 8)}…${ADDRESS.slice(-6)}`;
$('.chip--addr').title = ADDRESS;

wireSwitches();
startQuotes();
loadData();
setInterval(loadData, REFRESH_MS);

// Beim Zurückwechseln auf den Tab sofort nachschauen statt aufs Intervall zu warten.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadData();
});

// Der Chart hängt an der Pixelbreite des Containers.
let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.data) render();
  }, 200);
});
