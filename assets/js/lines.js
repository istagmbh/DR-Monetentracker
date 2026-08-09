/**
 * Die Kommentare des Hauses zur Hauptzahl.
 *
 * Getrennt von der Oberfläche, weil sie sonst nicht prüfbar wären — und weil
 * genau hier ein Fehler passiert ist: "Der Abend ist jung" stand um sechs Uhr
 * morgens auf der Seite. Sprüche, die eine Tageszeit voraussetzen, tragen
 * deshalb `when` und erscheinen nur dann.
 */

/** Nacht bis fünf, Morgen bis elf, Tag bis achtzehn, danach Abend. */
export function daypart(hour) {
  if (hour < 5) return 'nacht';
  if (hour < 11) return 'morgen';
  if (hour < 18) return 'tag';
  return 'abend';
}

const LINES = {
  bigWin: [
    { text: 'Nichtstun war die bestbezahlte Tätigkeit der Schweiz.' },
    { text: 'Die beste Anlagestrategie: Hände weg vom Gerät.' },
    { text: 'Er hat geschlafen und dabei mehr verdient als das halbe Grossraumbüro.', when: ['nacht', 'morgen'] },
    { text: 'Ein Tagwerk, für das er keinen Finger krumm gemacht hat.', when: ['tag', 'abend'] },
  ],
  win: [
    { text: 'Ein solider Lauf für die Fraktion Hände-in-den-Taschen.' },
    { text: 'Faulheit zahlt sich aus. Heute jedenfalls.' },
    { text: 'Der Tag fängt versöhnlich an.', when: ['morgen'] },
    { text: 'So lässt sich der Abend aushalten.', when: ['abend'] },
  ],
  flat: [
    { text: 'Bewegung: keine der Rede wert.' },
    { text: 'Der Kurs steht so still, dass man die Uhr danach stellen könnte.' },
    { text: 'Ruhige Nacht am Markt. Auch eine Qualität.', when: ['nacht'] },
  ],
  loss: [
    { text: 'Hätte er um Mitternacht ausbezahlt, sässe er jetzt entspannter.' },
    { text: 'Kleiner Dämpfer, mehr nicht.' },
    { text: 'Kein Grund, den Tag darauf aufzubauen.', when: ['morgen'] },
    { text: 'Kleiner Dämpfer. Der Abend ist noch jung.', when: ['abend'] },
    { text: 'Dafür lohnt es sich nicht, wach zu bleiben.', when: ['nacht'] },
  ],
  bigLoss: [
    { text: 'Um Punkt 00:00 auszahlen wäre die Idee des Tages gewesen.' },
    { text: 'Der Markt hat eine Meinung, und sie ist nicht schmeichelhaft.' },
    { text: 'Diese Zahl ersetzt jeden Kaffee.', when: ['morgen'] },
    { text: 'Man sollte nicht mit dieser Zahl im Kopf einschlafen.', when: ['abend', 'nacht'] },
  ],
};

/** Welcher Topf passt zur Wucht der Bewegung? */
export function bucket(pct) {
  if (pct > 0.03) return 'bigWin';
  if (pct > 0.002) return 'win';
  if (pct < -0.03) return 'bigLoss';
  if (pct < -0.002) return 'loss';
  return 'flat';
}

/**
 * `hour` ist die Zürcher Stunde des Messpunkts, nicht die Uhr des Betrachters:
 * Der Spruch soll zu der Zeit passen, aus der die Zahl stammt. Er wird über die
 * Stunde gestreut, damit er nicht bei jedem Neuzeichnen springt.
 */
export function pickLine(pct, hour, { btcMode = false } = {}) {
  if (btcMode) {
    return 'In Bitcoin gerechnet hat er exakt nichts gewonnen. Genau deshalb rechnet man in Franken.';
  }

  const jetzt = daypart(hour);
  const topf = LINES[bucket(pct)];
  const passend = topf.filter((l) => !l.when || l.when.includes(jetzt));

  // Gemischt statt schlicht `hour % länge`: bei Stundenabständen, die ein
  // Vielfaches der Topfgrösse sind, fiele die Auswahl sonst immer gleich aus —
  // 03, 06 und 09 Uhr lieferten denselben Satz.
  const streuung = ((hour + 1) * 2654435761) >>> 0;

  // Zeitneutrale Sprüche gibt es in jedem Topf, die Auswahl kann nicht leer sein.
  return passend[streuung % passend.length].text;
}

export { LINES };
