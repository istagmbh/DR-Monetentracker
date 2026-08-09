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

### Und wenn er umgeschichtet hätte?

Die Anschlussfrage beantwortet die Rangliste: Für Gold, den S&P 500, den SMI, Ethereum und ein
Sparkonto wird derselbe Mitternachtswert mit der Kursentwicklung der jeweiligen Anlage
fortgeschrieben. Angezeigt werden Prozent **und** Frankenbetrag, damit die Zahl greifbar bleibt.

Aktienindizes handeln nicht rund um die Uhr. Steht ein Kurs zwischen Mitternacht und jetzt auf
die Stelle genau still, wertet die Anzeige das als geschlossenen Markt und zeigt keine Zahl —
bei einem Index über mehrere Stunden ist ein unveränderter Kurs sonst praktisch ausgeschlossen.

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
* Gold, S&P 500, SMI: [Stooq](https://stooq.com) als CSV, ohne Schlüssel
* Ethereum: CoinGecko

Bestand und Bitcoin-Kurs sind Pflicht — fällt eine dieser Quellen aus, endet der Lauf mit
Fehler und lässt die Datei unberührt. Die Vergleichskurse sind Kür: Fällt eine Quelle aus, fehlt
diese Anlage für diese Stunde, und die Rangliste blendet sie aus. Der Dollarkurs für die
Umrechnung kommt aus den beiden Bitcoin-Notierungen (CHF je BTC geteilt durch USD je BTC), ein
zusätzlicher Aufruf erübrigt sich damit.

`.github/workflows/snapshot.yml` läuft zweimal pro Stunde, hängt einen Punkt an und committet
ihn. Der zweite Lauf schreibt nur, wenn der erste ausgefallen ist — GitHub verschiebt oder
verwirft geplante Läufe unter Last.

**Nachfüllen.** Fehlt eine Stunde trotzdem, ergänzt der nächste Lauf sie rückwirkend über
`GET /api/v1/historical-price`. Das geschieht nur, wenn der Bestand vor und nach der Lücke
derselbe war — hat sich in der Lücke etwas bewegt, bleibt sie offen, denn eine erfundene Zahl
wäre schlimmer als ein Loch. Nachgefüllte Punkte tragen `"bf": true`.

Punkte, die älter als 30 Tage sind, werden auf einen pro Tag ausgedünnt — behalten wird dabei der
Mitternachtspunkt, weil die Auswertung darauf aufbaut.

## Lokal ausprobieren

```bash
node scripts/test-calc.mjs           # Rechenlogik prüfen
node scripts/snapshot.mjs --fixture --dry-run   # Snapshot ohne Netz durchspielen
node scripts/seed-demo.mjs           # Vorschaudaten erzeugen
node scripts/make-icons.mjs          # App-Symbole neu erzeugen (braucht playwright-core)
python3 -m http.server 8765          # dann http://localhost:8765/?demo=1 öffnen
```

Die App-Symbole liegen nicht als undurchschaubare Binärdateien im Repo herum: Die Vorlage steht
als SVG im Klartext in `scripts/make-icons.mjs` und wird von dort mit Chromium in die nötigen
PNG-Grössen gerendert.

`?demo=1` zeigt die Oberfläche mit erfundenen Zahlen — praktisch, solange noch keine echten
Messpunkte vorliegen. Ohne echte Daten zeigt die Seite einen Countdown bis zum Startschuss.

## Veröffentlichung

Deployment über `.github/workflows/deploy-pages.yml`. Zwei Einstellungen mussten einmalig von
Hand gesetzt werden — beide kann kein Workflow selbst vornehmen; für dieses Repo sind sie
erledigt und hier nur noch als Gedächtnisstütze festgehalten:

1. **Settings → Pages → Source** auf **GitHub Actions**.
   Ohne das bricht `configure-pages` mit *„Get Pages site failed … Not Found“* ab. Der
   Parameter `enablement: true` ist keine Abkürzung: das Anlegen der Seite verlangt
   Repo-Admin-Rechte, die das `GITHUB_TOKEN` eines Workflows nie besitzt — der Versuch endet
   mit *„Create Pages site failed. Resource not accessible by integration“*.
2. **Settings → Actions → General → Workflow permissions** auf **Read and write permissions**.
   Sonst darf der stündliche Snapshot seinen Datenpunkt nicht committen. GitHub setzt neue
   Repos auf „read-only“, und die `permissions:`-Angaben in den Workflow-Dateien können dieses
   Repo-Limit nicht überschreiben, nur unterschreiten.

Der stündliche Cron läuft nur auf dem Default-Branch — Arbeitsstände auf einem Feature-Branch
messen also nichts, bis sie in `main` sind.

### Adresse

Standard-Adresse: `https://istagmbh.github.io/DR-Monetentracker/`

Eigene Domain: `https://moneten.drhome.ch` — dafür liegt die Datei `CNAME` im Repo-Wurzelverzeichnis.
Nötig ist zusätzlich ein DNS-Eintrag bei der Verwaltung von `drhome.ch`:

```
Typ    CNAME
Name   moneten
Wert   istagmbh.github.io.
```

Kein A-Record, keine IP: der Wert zeigt auf `istagmbh.github.io.`, nicht auf den Repo-Pfad — den
stellt GitHub anhand der `CNAME`-Datei selbst her.

Solange dieser Eintrag fehlt, ist die Seite **auch unter der Standard-Adresse nicht erreichbar**:
Bei gesetzter Custom domain liefert GitHub ausschliesslich unter dieser aus und leitet
`github.io` dorthin um. Wer die Seite ohne eigene Domain betreiben will, löscht `CNAME`.

**Enforce HTTPS** unter *Settings → Pages* anhaken, sobald das Zertifikat ausgestellt ist (nach
dem DNS-Eintrag meist einige Minuten).

Alle Pfade in der Seite sind relativ, sie funktioniert deshalb unter beiden Adressen — unter
`/DR-Monetentracker/` genauso wie direkt auf der Domainwurzel.

---

Kein Finanzrat, kein Anlagetipp — reine Unterhaltung. Zahlen können lügen, Filmzitate nie.
