/**
 * Handgezeichneter SVG-Verlauf ohne Fremdbibliothek.
 * Zwei Kurven: der unangetastete Mitternachts-Bestand (Gold) und der
 * tatsächliche Tresorinhalt (Cyan). Liegen sie übereinander, wurde nichts bewegt.
 */

const W = 1000;

const niceStep = (span) => {
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
};

const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

export function renderChart(container, { points, formatValue, formatTime, showActual = true }) {
  if (!points || points.length < 2) {
    container.innerHTML = '<p class="chart__empty">Noch zu wenig Datenpunkte — der erste Zeiger braucht zwei Stunden.</p>';
    return;
  }

  // Auf schmalen Schirmen wird die Zeichenfläche höher und die Schrift grösser,
  // sonst schrumpft die Beschriftung beim Herunterskalieren zu Staub.
  const narrow = (container.clientWidth || 1000) < 620;
  const H = narrow ? 620 : 320;
  const PAD = narrow
    ? { top: 26, right: 18, bottom: 74, left: 132 }
    : { top: 22, right: 18, bottom: 34, left: 78 };
  const fontSize = narrow ? 30 : 15;
  const strokeScale = narrow ? 2 : 1;

  const values = points.flatMap((p) => (showActual ? [p.hodl, p.actual] : [p.hodl]));
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-9) {
    // Flache Kurve braucht trotzdem etwas Luft, sonst teilt man durch null.
    hi += Math.max(Math.abs(hi) * 0.01, 1);
    lo -= Math.max(Math.abs(lo) * 0.01, 1);
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;

  const t0 = points[0].t;
  const t1 = points.at(-1).t;
  const spanT = Math.max(t1 - t0, 1);

  const x = (t) => PAD.left + ((t - t0) / spanT) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const hodlPts = points.map((p) => ({ x: x(p.t), y: y(p.hodl) }));
  const actualPts = points.map((p) => ({ x: x(p.t), y: y(p.actual) }));

  // Waagerechte Hilfslinien
  const step = niceStep(hi - lo);
  const gridLines = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    gridLines.push(
      `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid" />` +
        // Der Schritt geht mit: sonst runden eng beieinanderliegende Linien
        // auf dieselbe Zahl und die Achse liest sich "242 · 242 · 242".
        `<text x="${PAD.left - 12}" y="${(y(v) + fontSize * 0.35).toFixed(1)}" class="ylab">${formatValue(v, true, step)}</text>`,
    );
  }

  // Zeitachse: wenige Beschriftungen, sonst wird es Brei.
  const tickCount = Math.min(narrow ? 4 : 6, points.length);
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const p = points[Math.round((i * (points.length - 1)) / (tickCount - 1 || 1))];
    // Die Randbeschriftungen nach innen ziehen, damit sie nicht abgeschnitten werden.
    const anchor = i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle';
    return `<text x="${x(p.t).toFixed(1)}" y="${H - PAD.bottom + fontSize * 1.6}" class="xlab" text-anchor="${anchor}">${formatTime(p.t)}</text>`;
  }).join('');

  const baseY = y(points[0].hodl);
  const area = `${path(hodlPts)} L${(W - PAD.right).toFixed(2)} ${y(lo).toFixed(2)} L${PAD.left.toFixed(2)} ${y(lo).toFixed(2)} Z`;

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf des Wallet-Werts">
      <defs>
        <linearGradient id="fillGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ffd54a" stop-opacity="0.32" />
          <stop offset="100%" stop-color="#ffd54a" stop-opacity="0" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <style>
          .grid { stroke: rgba(255,255,255,.08); stroke-width: ${strokeScale}; }
          .ylab { fill: #a58ec7; font-size: ${fontSize}px; text-anchor: end; font-family: ui-monospace, Menlo, monospace; }
          .xlab { fill: #a58ec7; font-size: ${fontSize}px; font-family: ui-monospace, Menlo, monospace; }
          .midline { stroke: #ffd54a; stroke-width: ${1.5 * strokeScale}; stroke-dasharray: ${6 * strokeScale} ${7 * strokeScale}; opacity: .5; }
          .line-hodl { fill: none; stroke: #ffd54a; stroke-width: ${3.5 * strokeScale}; stroke-linejoin: round; stroke-linecap: round; }
          .line-actual { fill: none; stroke: #00e5ff; stroke-width: ${2.5 * strokeScale}; stroke-linejoin: round; stroke-linecap: round; opacity: .95; }
          .cross { stroke: rgba(255,255,255,.45); stroke-width: ${strokeScale}; }
          .dot-hodl { fill: #ffd54a; }
          .dot-actual { fill: #00e5ff; }
        </style>
      </defs>

      ${gridLines.join('')}
      <line class="midline" x1="${PAD.left}" x2="${W - PAD.right}" y1="${baseY.toFixed(1)}" y2="${baseY.toFixed(1)}" />
      <path d="${area}" fill="url(#fillGold)" />
      ${showActual ? `<path class="line-actual" d="${path(actualPts)}" />` : ''}
      <path class="line-hodl" d="${path(hodlPts)}" filter="url(#glow)" />
      ${ticks}

      <g id="cursor" opacity="0">
        <line class="cross" y1="${PAD.top}" y2="${H - PAD.bottom}" />
        <circle class="dot-hodl" r="${5 * strokeScale}" />
        ${showActual ? `<circle class="dot-actual" r="${4 * strokeScale}" />` : ''}
      </g>

      <rect id="hit" x="${PAD.left}" y="${PAD.top}" width="${W - PAD.left - PAD.right}" height="${H - PAD.top - PAD.bottom}" fill="transparent" />
    </svg>
    <div class="chart__tip" id="tip"></div>
  `;

  const svg = container.querySelector('svg');
  const cursor = container.querySelector('#cursor');
  const cross = cursor.querySelector('line');
  const dotHodl = cursor.querySelector('.dot-hodl');
  const dotActual = cursor.querySelector('.dot-actual');
  const tip = container.querySelector('#tip');
  const hit = container.querySelector('#hit');

  const move = (event) => {
    const box = svg.getBoundingClientRect();
    const clientX = event.touches?.[0]?.clientX ?? event.clientX;
    const svgX = ((clientX - box.left) / box.width) * W;

    let idx = 0;
    let best = Infinity;
    hodlPts.forEach((p, i) => {
      const d = Math.abs(p.x - svgX);
      if (d < best) {
        best = d;
        idx = i;
      }
    });

    const p = points[idx];
    cursor.setAttribute('opacity', '1');
    cross.setAttribute('x1', hodlPts[idx].x);
    cross.setAttribute('x2', hodlPts[idx].x);
    dotHodl.setAttribute('cx', hodlPts[idx].x);
    dotHodl.setAttribute('cy', hodlPts[idx].y);
    if (dotActual) {
      dotActual.setAttribute('cx', actualPts[idx].x);
      dotActual.setAttribute('cy', actualPts[idx].y);
    }

    tip.classList.add('is-on');
    tip.style.left = `${(hodlPts[idx].x / W) * box.width}px`;
    tip.style.top = `${(hodlPts[idx].y / H) * box.height}px`;
    tip.innerHTML =
      `${formatTime(p.t, true)}<br><b>${formatValue(p.hodl)}</b> unangetastet` +
      (showActual && Math.abs(p.actual - p.hodl) > 1e-9 ? `<br>${formatValue(p.actual)} tatsächlich` : '');
  };

  const leave = () => {
    cursor.setAttribute('opacity', '0');
    tip.classList.remove('is-on');
  };

  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}
