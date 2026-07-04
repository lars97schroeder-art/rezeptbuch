# 🍳 Unser Rezeptbuch

Eine Offline-Rezept-App fürs iPhone (als Web-App / PWA) plus ein
Admin-Tool für den Mac zum Pflegen der Rezepte.

## Rezepte pflegen (am Mac)

1. Doppelklick auf **`Rezept-Admin.command`** (oder im Terminal:
   `python3 admin/admin.py`). Der Browser öffnet sich automatisch.
2. Rezept anlegen/ändern, Foto auswählen (wird automatisch verkleinert),
   **Speichern**.
3. Auf **🚀 Veröffentlichen** klicken – das pusht die Änderungen zu GitHub.
4. Am iPhone in der App auf **⟳** tippen – fertig.

## App aufs iPhone bringen (einmalig, pro Handy)

1. Die App-Adresse (GitHub-Pages-URL) in **Safari** öffnen.
2. Teilen-Symbol → **„Zum Home-Bildschirm“**.
3. Einmal öffnen und auf **⟳** tippen, damit alle Rezepte und Fotos
   heruntergeladen werden. Danach funktioniert alles offline.

## Technik

- **Kein Framework, kein Build-Schritt**: `index.html`, `app.js`, `style.css`.
- `data/recipes.json` ist die „Datenbank“, Fotos liegen in `data/images/`
  (versionierte Dateinamen, damit die Handys ersetzte Fotos erkennen).
- Der Service Worker (`sw.js`) hält App und Fotos offline vor;
  die Rezeptdaten selbst liegen im `localStorage`.
- Der ⟳-Knopf lädt `recipes.json` neu und holt nur fehlende Bilder nach.
- Das Admin-Tool (`admin/admin.py`) ist reine Python-Standardbibliothek;
  Fotoverkleinerung über das macOS-Bordmittel `sips`.

## Hosting

Gedacht für **GitHub Pages** (kostenlos, HTTPS – nötig für Offline-Modus):
Repo auf GitHub anlegen, unter *Settings → Pages* den `main`-Branch
veröffentlichen. Die App liegt dann unter
`https://<benutzername>.github.io/<repo>/`.
