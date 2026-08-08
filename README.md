# Dr. Monetentracker

Eine Vegas-Casino-Webapp, die eine Bitcoin-Wallet stündlich beobachtet und genau eine Frage
beantwortet:

> **Was wäre, wenn er um Punkt 00:00 weder ein- noch ausbezahlt hätte?**

Nebenbei laufen zufällige Filmzitate über die Leinwand.

Beobachtete Wallet: `bc1q4cekdujg8yclq924rn7j7jnkwfk44gnrjxut6z`
Start der Messreihe: **9. August, 00:00 Uhr** (Europe/Zurich)

## Wie das Haus rechnet

Jede Stunde werden der Wallet-Bestand und der Bitcoin-Kurs festgehalten. Bezugspunkt ist der
Stand um Mitternacht Zürcher Zeit.

| Kennzahl | Formel | Bedeutung |
| --- | --- | --- |
| `hodlDelta` | `btcMitternacht × (kursJetzt − kursMitternacht)` | die grosse Zahl auf der Startseite |
| `actualDelta` | `wertJetzt − wertMitternacht` | was tatsächlich passiert ist |
| `moveEffect` | `actualDelta − hodlDelta` | Effekt der Ein- und Auszahlungen |

`hodlDelta` ist zugleich die Antwort auf „hätte er um 00:00 ausbezahlt“: der Erlös um Mitternacht
steht fest, derselbe Bestand ist jetzt mehr oder weniger wert — die Differenz ist dieselbe Zahl.
Bewegt sich der Bestand zwischendurch, landet das in `moveEffect`, damit der reine Kursgewinn
sauber bleibt.

Berechnet wird alles in `assets/js/calc.js`, sowohl im Browser als auch in den Tests.

## Aufbau

```
index.html                  Oberfläche
assets/css/style.css        das gesamte Neon — keine Bilder, keine externen Schriften
assets/js/calc.js           Mathematik (DOM- und netzfrei)
assets/js/app.js            Zustand, Rendern, Auto-Aktualisierung
assets/js/chart.js          SVG-Verlauf ohne Fremdbibliothek
assets/js/odometer.js       Slot-Machine-Ziffern
assets/js/quotes.js         Filmzitate
data/history.json           stündliche Messpunkte, gepflegt vom Workflow
scripts/snapshot.mjs        holt Kurs und Bestand
scripts/seed-demo.mjs       erfundene Daten für die Vorschau
scripts/test-calc.mjs       Prüfungen der Rechenlogik
```

Das Frontend ruft **keine** fremden APIs auf, sondern liest ausschliesslich `data/history.json`.
Damit gibt es weder CORS- noch Rate-Limit-Probleme, und die Seite funktioniert auch dann, wenn
ein Anbieter gerade nicht erreichbar ist.

## Daten

* Wallet-Bestand: [mempool.space](https://mempool.space) `GET /api/address/<addr>`
* Kurse (CHF, EUR, USD in einem Aufruf): `GET /api/v1/prices`, Ersatzquelle CoinGecko

`.github/workflows/snapshot.yml` läuft stündlich, hängt einen Punkt an und committet ihn.
Punkte, die älter als 30 Tage sind, werden auf einen pro Tag ausgedünnt — behalten wird dabei der
Mitternachtspunkt, weil die Auswertung darauf aufbaut.

## Lokal ausprobieren

```bash
node scripts/test-calc.mjs           # Rechenlogik prüfen
node scripts/snapshot.mjs --fixture --dry-run   # Snapshot ohne Netz durchspielen
node scripts/seed-demo.mjs           # Vorschaudaten erzeugen
python3 -m http.server 8765          # dann http://localhost:8765/?demo=1 öffnen
```

`?demo=1` zeigt die Oberfläche mit erfundenen Zahlen — praktisch, solange noch keine echten
Messpunkte vorliegen. Ohne echte Daten zeigt die Seite einen Countdown bis zum Startschuss.

## Veröffentlichung

Deployment über `.github/workflows/deploy-pages.yml`. Zwei Dinge müssen einmalig von Hand
passieren:

1. **Settings → Pages → Source** auf **GitHub Actions** stellen.
2. Den Branch nach `main` mergen — GitHub startet geplante Workflows nur auf dem Default-Branch,
   der stündliche Cron greift also erst danach. Bis dahin lässt sich `Stündlicher Snapshot`
   jederzeit von Hand über „Run workflow“ auslösen.

Danach steht die Seite unter `https://istagmbh.github.io/DR-Monetentracker/`.

---

Kein Finanzrat, kein Anlagetipp — reine Unterhaltung. Zahlen können lügen, Filmzitate nie.
