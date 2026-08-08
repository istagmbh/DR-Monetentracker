/**
 * Zahlenanzeige im Spielautomaten-Stil: jede Ziffer sitzt auf einer Walze,
 * die auf den neuen Wert hochrollt. Zeichen wie Vorzeichen, Trenner und
 * Währung stehen fest daneben.
 */

const DIGITS = '0123456789';

/** Die "Form" eines Textes: alle Ziffern zu # — daran erkennen wir, ob das DOM passt. */
const shapeOf = (text) => text.replace(/\d/g, '#');

function buildCells(el, text) {
  el.textContent = '';
  const reels = [];

  for (const char of text) {
    if (DIGITS.includes(char)) {
      const reel = document.createElement('span');
      reel.className = 'odometer__reel';

      const strip = document.createElement('span');
      strip.className = 'odometer__strip';
      for (const d of DIGITS) {
        const cell = document.createElement('span');
        cell.textContent = d;
        strip.append(cell);
      }

      reel.append(strip);
      el.append(reel);
      reels.push(strip);
    } else {
      const sym = document.createElement('span');
      sym.className = 'odometer__sym';
      if (char === '+' || char === '−' || char === '-') sym.classList.add('odometer__sym--sign');
      if (/[A-Za-z₿]/.test(char)) sym.classList.add('odometer__sym--unit');
      sym.textContent = char;
      el.append(sym);
    }
  }

  return reels;
}

/**
 * Setzt den Text der Anzeige. Bleibt die Form gleich, rollen nur die Walzen;
 * ändert sich die Länge, wird neu aufgebaut und danach animiert.
 */
export function setOdometer(el, text, { animate = true } = {}) {
  const shape = shapeOf(text);
  const rebuild = el.dataset.shape !== shape;

  if (rebuild) {
    el._reels = buildCells(el, text);
    el.dataset.shape = shape;
  }

  const reels = el._reels ?? [];
  const digits = [...text].filter((c) => DIGITS.includes(c));

  const apply = () => {
    digits.forEach((d, i) => {
      const strip = reels[i];
      if (strip) strip.style.transform = `translateY(${-Number(d) * 1.12}em)`;
    });
  };

  if (rebuild && animate) {
    // Erst rendern lassen, dann rollen — sonst springt die Walze ohne Bewegung.
    requestAnimationFrame(() => requestAnimationFrame(apply));
  } else {
    apply();
  }

  el.setAttribute('aria-label', text);

  if (animate && el.dataset.prev !== undefined && el.dataset.prev !== text) {
    el.classList.remove('is-hit');
    void el.offsetWidth; // Animation neu starten
    el.classList.add('is-hit');
  }
  el.dataset.prev = text;
}
