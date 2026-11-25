'use strict';

// FUNKTIONALITÄTEN-TIMESTAMP: bei JEDER Code-Änderung aktualisieren (App allgemein, Wochenplan, Tindern)
// ISO-Format mit Berlin-Zeitzone, Vergleich läuft über Datums-Parsing (nie String-Vergleich!)
const APP_BUILD_TIME = '2026-11-25T20:00:00+01:00';

const DATA_KEY = 'rezeptbuch-data';
const IMG_CACHE = 'rezept-bilder-v1';
const OFFLINE_MODE_KEY = 'rezeptbuch-offline-mode';

const CATEGORY_EMOJI = {
  'Pasta & Gnocchi': '🍝', 'Pasta': '🍝', 'Spätzle': '🧀',
  'Asia': '🍜', 'Asiatisch': '🍜', 'Streetfood': '🍔',
  'Zünftig': '🥨', 'Eintöpfe & Suppen': '🍲', 'Suppe': '🍲',
  'Ofen & Pfanne': '🥘', 'Ist das Kochen?': '🥗', 'Salat': '🥗',
  'Breakky': '🍳', 'Frühstück': '🍳', 'Süßes': '🍮', 'Dessert': '🍰',
  'Fleisch': '🥩', 'Fisch': '🐟', 'Vegetarisch': '🥦', 'Backen': '🥐',
};

// Drei Welten: umschaltbar per Tipp auf den Titel
const MODE_KEY = 'rezeptbuch-mode';
const MODES = {
  fruehstueck: { label: 'Frühstück', emoji: '🥐' },
  kochen: { label: 'Kochen', emoji: '🍳' },
  backen: { label: 'Backen', emoji: '🧁' },
};

let data = { version: 0, updated: '', recipes: [] };
let activeCategory = 'Alle';
let query = '';
// Was beim Öffnen der App erscheint (Einstellungen → App)
const START_KEY = 'rezeptbuch-start';
const START_OPTIONS = {
  kochen: 'Startseite Kochen',
  backen: 'Startseite Backen',
  fruehstueck: 'Startseite Frühstück',
  weekplan: 'Wochenplan',
  tinder: 'Food Match',
};
const startPage = () => {
  const v = localStorage.getItem(START_KEY);
  return Object.hasOwn(START_OPTIONS, v) ? v : 'kochen';
};
// Wochenplan und Food Match liegen über der Kochen-Startseite
let mode = MODES[startPage()] ? startPage() : 'kochen';
localStorage.setItem(MODE_KEY, mode);

function recipeMode(r) {
  return r.bereich || 'kochen';
}

const $ = s => document.querySelector(s);

// Linien-Icons für die Bedienung (Stroke = currentColor, einheitliche Strichstärke)
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON = {
  heart: `<svg ${ICON_ATTRS}><path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/></svg>`,
  cross: `<svg ${ICON_ATTRS}><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  star: `<svg ${ICON_ATTRS}><path d="M12 3.8l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.6-5 2.6.9-5.6-4-4 5.6-.8z"/></svg>`,
};

// Sperrt/entsperrt native Touch-Gesten (Scrollen etc.) UND Text-Markieren
// für den GESAMTEN Bildschirm während eines eigenen Drags (Backlog↔
// Wochenplan). Ohne das touch-action-Sperren kann der Finger, sobald er
// über ein Element ohne eigenes touch-action:none wandert (z.B. die
// Backlog-Überschrift), vom Browser als native Scroll-Geste übernommen
// werden — das unterbricht dann unsere pointermove-Events mittendrin, als
// würde die gezogene Kachel an einer unsichtbaren Wand hängenbleiben. Ohne
// das Sperren von user-select/-webkit-touch-callout kann der Finger beim
// Ziehen über benachbarte Zeilen/Text hinweg dort eine native Text-
// markieren-Geste auslösen, obwohl gerade eigentlich gezogen wird.
// document.body statt nur des Griffs, damit es wirklich überall auf dem
// Bildschirm funktioniert, nicht nur direkt am Griff.
let touchActionLockCount = 0;
function lockTouchAction() {
  if (touchActionLockCount++ === 0) {
    document.body.style.touchAction = 'none';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    document.body.style.webkitTouchCallout = 'none';
  }
}
function unlockTouchAction() {
  if (--touchActionLockCount <= 0) {
    touchActionLockCount = 0;
    document.body.style.touchAction = '';
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    document.body.style.webkitTouchCallout = '';
  }
}

// Kategorien immer als Array behandeln: der Editor speichert Arrays, ältere Daten sind Strings
function recipeCategories(r) {
  if (Array.isArray(r.category)) return r.category.filter(Boolean);
  return r.category ? [r.category] : [];
}

function categoryLabel(r) {
  return recipeCategories(r).join(', ');
}

// Standard-Emoji je Bereich, wenn Rezept und Kategorie keins hergeben
const BEREICH_EMOJI = { kochen: '🍳', backen: '🍰', fruehstueck: '🥐' };

function emojiFor(recipe) {
  return recipe.emoji
    || CATEGORY_EMOJI[recipeCategories(recipe)[0]]
    || BEREICH_EMOJI[recipeMode(recipe)]
    || '🍽️';
}

// Titel mit Emoji dahinter, z. B. "Pizzaaaaa 🍕" (nur bei eigenem Emoji)
function titleWithEmoji(recipe) {
  return esc(recipe.title) + (recipe.emoji ? ' ' + esc(recipe.emoji) : '');
}

// Alle Fotos eines Rezepts (unterstützt altes Einzel-Feld und neue Liste)
function imagesOf(r) {
  if (r.images && r.images.length) return r.images;
  return r.image ? [r.image] : [];
}

// Zufälliges Titelbild für die Übersicht
function randomImage(r) {
  const imgs = imagesOf(r);
  return imgs.length ? imgs[Math.floor(Math.random() * imgs.length)] : '';
}

// Zutaten mit Zwischenüberschriften: eine Zeile, die mit "*" beginnt
// (z.B. "*Teig"), wird als Oberkategorie gerendert statt als Zutat —
// praktisch für Rezepte mit mehreren Teilen (Teig + Füllung o.ä.)
function ingredientsHTML(ingredients) {
  let html = '';
  let listOpen = false;
  for (const raw of ingredients) {
    const text = String(raw).trim();
    const heading = text.match(/^\*\s*(.+)/);
    if (heading) {
      if (listOpen) { html += '</ul>'; listOpen = false; }
      html += `<div class="ingredient-heading">${esc(heading[1])}</div>`;
    } else {
      if (!listOpen) { html += '<ul>'; listOpen = true; }
      html += `<li>${esc(text)}</li>`;
    }
  }
  if (listOpen) html += '</ul>';
  return html;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (raw) {
      data = JSON.parse(raw);
    }
  } catch (e) {
    console.error('Fehler beim Laden von localStorage:', e);
    localStorage.removeItem(DATA_KEY);
  }
}

function saveLocal() {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
    console.log('✅ saveLocal() erfolgreich');
  } catch (e) {
    console.error('🔴 FEHLER beim Speichern in localStorage:', e.message);
    throw e;
  }
}

/* Gemeinsame Basis für alle data/*.json-Dateien (Rezepte, Wochenplan,
   Rezept-Backlog): mit Token direkt über die GitHub-API (sofort aktuell),
   sonst über GitHub Pages (Fallback, kann nach einem Save ein paar Minuten
   hinterherhängen). Wurde vorher für jede Datei einzeln dupliziert. */
async function fetchRemoteJSON(path) {
  if (typeof ghGet === 'function' && typeof ghToken === 'function' && ghToken()) {
    try {
      const info = await ghGet(path);
      return JSON.parse(utf8b64(info.content));
    } catch (e) { /* API nicht erreichbar → Pages-Fallback */ }
  }
  try {
    const res = await fetch(path + '?t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch (e) { /* offline */ }
  return null;
}

// Schreibt eine JSON-Datei ins Repo (legt sie neu an oder überschreibt sie)
let syncErrorShown = false;
async function pushRemoteJSON(path, payload, message) {
  if (typeof ghToken !== 'function' || !ghToken()) return false;
  let sha;
  try { sha = (await ghGet(path)).sha; } catch (e) { /* erste Übertragung */ }
  try {
    await ghPut(path, b64utf8(JSON.stringify(payload, null, 2)), message, sha);
  } catch (e) {
    // Läuft im Hintergrund (Debounce-Timer) — ohne Meldung würde ein
    // abgelaufener Token wochenlang unbemerkt bleiben. Einmal pro Sitzung zeigen.
    console.error('Sync zu GitHub fehlgeschlagen:', e);
    if (!syncErrorShown) { syncErrorShown = true; toast('⚠️ Nicht gespeichert: ' + e.message); }
    throw e;
  }
  return true;
}

// true, wenn remote.updated (ISO) neuer ist als der lokal gespeicherte Wert
function isRemoteNewer(remote, localUpdatedKey) {
  if (!remote || !remote.updated) return false;
  const localUpdated = new Date(localStorage.getItem(localUpdatedKey)).getTime() || 0;
  const remoteUpdated = new Date(remote.updated).getTime() || 0;
  return remoteUpdated > localUpdated;
}

// Frische Rezepte holen (Sync-Logik pro Rezept läuft separat in
// checkAndUpdateIfNeeded, da hier einzelne Rezepte verglichen werden müssen,
// nicht nur "ist die ganze Datei neuer")
async function fetchRemoteRecipes() {
  return fetchRemoteJSON('data/recipes.json');
}

// Auto-Check: Prüfe ob neue Rezepte vom Server verfügbar sind
// Gibt true zurück wenn Updates gefunden wurden, false wenn aktuell
// opts.quiet: keine Toast-Meldung (der Aufrufer meldet selbst, z.B. beim Rezept-Klick)
async function checkAndUpdateIfNeeded(opts = {}) {
  // Skip wenn Offline-Modus aktiv
  if (localStorage.getItem(OFFLINE_MODE_KEY) === 'true') {
    console.log('ℹ️ Offline-Modus aktiv - kein Abgleich mit Server');
    return false;
  }

  try {
    const fresh = await fetchRemoteRecipes();
    if (!fresh) return false;

    // Erfolgreicher Abgleich mit dem Server → "Zuletzt aktualisiert" stempeln
    localStorage.setItem(LAST_UPDATE_KEY, new Date().toLocaleString('de-DE',
      { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));

    // Vergleiche global updated Datum (ISO-Parse für robuste Vergleiche)
    const oldDate = new Date(data.updated).getTime();
    const freshDate = new Date(fresh.updated).getTime();
    if (freshDate === oldDate) {
      console.log('✅ Rezepte sind aktuell');
      return false; // Nichts geändert
    }

    console.log('🔄 Neue Rezepte verfügbar (lokal:', data.updated, 'remote:', fresh.updated + ')');

    // Erstbefüllung (noch keine lokalen Rezepte): still übernehmen,
    // sonst würden ALLE Rezepte als "aktualisiert" gemeldet
    const ersteBefuellung = data.recipes.length === 0;

    // Finde geänderte Rezepte
    const oldMap = new Map(data.recipes.map(r => [r.id, r]));
    const updated = [];

    for (const newRecipe of fresh.recipes) {
      const oldRecipe = oldMap.get(newRecipe.id);
      if (!oldRecipe || JSON.stringify(oldRecipe) !== JSON.stringify(newRecipe)) {
        // Rezept ist neu oder geändert
        updated.push(newRecipe.id);
      }
    }

    if (updated.length > 0) {
      // Update: ganze recipes ersetzen und Ansicht auffrischen
      // version mitspeichern, sonst verwirft der Versions-Check in index.html
      // die lokalen Rezepte beim nächsten Start (offline: leere Liste)
      data.version = fresh.version;
      data.recipes = fresh.recipes;
      data.updated = fresh.updated;
      saveLocal();
      render();
      // Neue Bilder im Hintergrund fürs Offline-Kochen holen
      precacheImages(fresh.recipes);
      console.log('🔄 ' + updated.length + ' Rezept(e) aktualisiert: ' + updated.join(', '));
      if (!opts.quiet && !ersteBefuellung) {
        toast('🔄 ' + updated.length + ' Rezept(e) aktualisiert');
      }
      return true;
    }
    return true; // Auch wenn keine Rezepte geändert, aber Struktur aktualisiert
  } catch (e) {
    console.log('ℹ️ Konnte nicht nach Updates prüfen (offline?)');
    return false;
  }
}

/* ---------- Aktualisieren ---------- */

// Bilder fürs Offline-Kochen vorladen und nicht mehr benötigte aufräumen.
// Läuft im Hintergrund, wenn neue Rezepte übernommen wurden.
async function precacheImages(recipes) {
  try {
    const cache = await caches.open(IMG_CACHE);
    const wanted = new Set();
    for (const r of recipes) {
      for (const img of imagesOf(r)) {
        wanted.add(new URL(img, location.href).href);
        if (await cache.match(img)) continue;
        try {
          const imgRes = await fetch(img, { cache: 'no-store' });
          if (imgRes.ok) await cache.put(img, imgRes);
        } catch (e) { /* einzelnes Bild fehlgeschlagen – beim nächsten Update erneut */ }
      }
    }
    for (const req of await cache.keys()) {
      if (!wanted.has(req.url)) await cache.delete(req);
    }
  } catch (e) { /* Bild-Cache optional */ }
}

// Funktionalitäten-Timestamp der Server-Version auslesen (aus app.js).
// WICHTIG: bewusst NUR über GitHub Pages (die relative app.js), NICHT über
// die GitHub-API. Die API liefert sofort den neuesten Commit, aber beim
// Neuladen kommt die App von Pages, das dem API-Stand ein paar Minuten
// hinterherhängt. Verglichen mit der API würde "Update verfügbar" endlos
// wiederkommen, weil das Update auf Pages noch gar nicht ankommt. Gegen
// Pages verglichen verschwindet der Hinweis, sobald das Update wirklich da ist.
async function fetchRemoteBuildTime() {
  try {
    const res = await fetch('app.js?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/APP_BUILD_TIME\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/* ---------- Anzeige ---------- */

// Sortierung der Übersicht: 'alpha' (Standard) | 'time' | 'recent'
const SORT_KEY = 'rezeptbuch-sort';
let sortMode = localStorage.getItem(SORT_KEY) || 'alpha';

function itemTitle(item) {
  return item.group ? item.group : item.recipe.title;
}

// Titel ab dem ersten echten Buchstaben — führende Klammern, Emojis, Zahlen
// usw. werden übersprungen. "(Veggie) Burger" → "Veggie) Burger", "🍕 Pizza"
// → "Pizza". Wird für Sortierung UND Buchstaben-Divider genutzt, damit beides
// konsistent ist. Ohne jeden Buchstaben (reiner Emoji-Titel) bleibt das Original.
function sortableTitle(item) {
  const t = itemTitle(item);
  const m = t.match(/\p{L}/u);
  return m ? t.slice(m.index) : t;
}

// Führende Zahl aus einer Zeitangabe ("30 Min." → 30); ohne Angabe ans Ende
function parseTimeMinutes(t) {
  const m = String(t || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : Infinity;
}

// Anzeige-Format für Dauer: unter 1 Std. nur Minuten, ab 1 Std. "Std. mm"
// (führende Nullen weggelassen, "mm" entfällt bei glatten Stunden)
function formatDuration(totalMinutes) {
  const mins = Math.round(totalMinutes);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m === 0 ? `${h} Std.` : `${h} Std. ${m}`;
}

// r.time bleibt als Freitext-String gespeichert (Altbestand), aber bei
// erkennbarer Minutenzahl wird für die Anzeige einheitlich formatiert
function displayDuration(timeStr) {
  const mins = parseTimeMinutes(timeStr);
  return isFinite(mins) ? formatDuration(mins) : (timeStr || '');
}

// Für das Rad-Eingabefeld (input[type=time]) im Editor
function minutesToHHMM(totalMinutes) {
  if (!isFinite(totalMinutes)) return '';
  const h = Math.floor(totalMinutes / 60), m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return isFinite(h) && isFinite(m) ? h * 60 + m : null;
}

function itemTime(item) {
  const recs = item.group ? item.members : [item.recipe];
  return Math.min(...recs.map(r => parseTimeMinutes(r.time)));
}

// Sortierschlüssel "zuletzt hinzugefügt": created-Timestamp falls vorhanden,
// sonst Array-Position (später im File = neuer). Größer = neuer.
function itemRecentKey(item) {
  const recs = item.group ? item.members : [item.recipe];
  let best = -Infinity;
  for (const r of recs) {
    const key = r.created ? new Date(r.created).getTime() : data.recipes.indexOf(r);
    if (key > best) best = key;
  }
  return best;
}

function sortItems(items) {
  const arr = items.slice();
  const byTitle = (a, b) => sortableTitle(a).localeCompare(sortableTitle(b), 'de');
  if (sortMode === 'time') {
    arr.sort((a, b) => itemTime(a) - itemTime(b) || byTitle(a, b));
  } else if (sortMode === 'recent') {
    arr.sort((a, b) => itemRecentKey(b) - itemRecentKey(a) || byTitle(a, b));
  } else {
    arr.sort(byTitle);
  }
  return arr;
}

// Buchstabe für den Divider in der alphabetischen "Alle"-Ansicht.
// Nutzt den Titel ab dem ersten echten Buchstaben (s. sortableTitle).
function dividerLetter(item) {
  let c = (sortableTitle(item).trim()[0] || '#').toUpperCase();
  const map = { 'Ä': 'A', 'Ö': 'O', 'Ü': 'U' };
  if (map[c]) c = map[c];
  if (!/[A-ZÀ-Þ]/.test(c)) c = '#'; // reine Emoji-/Zahlen-Titel sammeln sich unter #
  return c;
}

// Neu/Update-Hinweis: erscheint für einen Tag nach Erstellen bzw. Ändern.
// Gilt geräteübergreifend, weil created/updated als ISO-Zeit im Rezept stehen.
const RECIPE_BADGE_MS = 24 * 60 * 60 * 1000;

function recipeBadge(r) {
  const now = Date.now();
  const created = r.created ? new Date(r.created).getTime() : NaN;
  const updated = r.updated ? new Date(r.updated).getTime() : NaN;
  if (!isNaN(created) && now - created < RECIPE_BADGE_MS) return 'neu';
  if (!isNaN(updated) && now - updated < RECIPE_BADGE_MS) return 'update';
  return null;
}

// Für eine Kachel (Einzelrezept oder Gruppe): 'neu' schlägt 'update'
function itemBadge(item) {
  const recs = item.group ? item.members : [item.recipe];
  const badges = recs.map(recipeBadge);
  if (badges.includes('neu')) return 'neu';
  if (badges.includes('update')) return 'update';
  return null;
}

function categories() {
  const inMode = data.recipes.filter(r => recipeMode(r) === mode);
  const cats = [...new Set(inMode.flatMap(r => recipeCategories(r)))];
  cats.sort((a, b) => String(a).localeCompare(String(b), 'de'));
  return ['Alle', ...cats];
}

function filtered() {
  const q = query.trim().toLowerCase();
  return data.recipes.filter(r => {
    if (recipeMode(r) !== mode) return false;
    if (activeCategory !== 'Alle' && !recipeCategories(r).includes(activeCategory)) return false;
    if (!q) return true;
    const hay = [r.title, ...recipeCategories(r), ...(r.ingredients || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

// Rezepte mit gleicher "group" werden zu einer Kachel zusammengefasst.
// Bei aktiver Suche werden Einzelrezepte gezeigt, damit Treffer direkt sichtbar sind.
function groupedList() {
  const list = filtered();
  if (query.trim()) return list.map(r => ({ recipe: r }));
  const items = [];
  const seen = new Set();
  for (const r of list) {
    if (!r.group) { items.push({ recipe: r }); continue; }
    if (seen.has(r.group)) continue;
    seen.add(r.group);
    items.push({ group: r.group, members: list.filter(x => x.group === r.group) });
  }
  return items;
}

// Scroll-Label für Buchstaben beim Alphabetischen Sortieren
function setupScrollLabel() {
  const grid = $('#grid');
  if (!grid) return;

  let scrollLabelEl = document.querySelector('.scroll-letter-label');
  if (!scrollLabelEl) {
    scrollLabelEl = document.createElement('div');
    scrollLabelEl.className = 'scroll-letter-label';
    document.body.appendChild(scrollLabelEl);
  }

  let hideTimer = null;
  let lastLetter = null;

  const updateLabel = () => {
    // Nur bei alphabetischer Sortierung ohne Suche
    if (sortMode !== 'alpha' || activeCategory !== 'Alle' || query.trim()) {
      scrollLabelEl.hidden = true;
      return;
    }

    // Finde das oberste linke Rezept (erste Zeile, linke Seite) im sichtbaren Bereich
    const cards = grid.querySelectorAll('.card');
    if (!cards.length) return;

    let topLeftCard = null;
    let minY = Infinity;
    let minX = Infinity;

    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      // Nur sichtbare Cards betrachten (im Viewport oder gerade oben raus)
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

      if (rect.top < minY) {
        minY = rect.top;
        minX = rect.left;
        topLeftCard = card;
      } else if (Math.abs(rect.top - minY) < 5 && rect.left < minX) {
        // Gleiche Zeile aber weiter links
        minX = rect.left;
        topLeftCard = card;
      }
    }

    if (!topLeftCard) return;
    const titleEl = topLeftCard.querySelector('.title');
    const title = titleEl?.textContent || '';
    const currentLetter = title.charAt(0)?.toUpperCase();

    if (currentLetter && currentLetter !== lastLetter) {
      lastLetter = currentLetter;
      scrollLabelEl.textContent = currentLetter;
      scrollLabelEl.hidden = false;

      // Verstecke nach 1 Sekunde, falls kein neuer Buchstaben-Wechsel kommt
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        scrollLabelEl.hidden = true;
      }, 1000);
    }
  };

  window.addEventListener('scroll', updateLabel, { passive: true });
}

function render() {
  // Kategorie-Chips
  const chips = $('#chips');
  chips.innerHTML = '';
  for (const cat of categories()) {
    const b = document.createElement('button');
    b.className = 'chip' + (cat === activeCategory ? ' active' : '');
    b.textContent = cat;
    b.onclick = () => { activeCategory = cat; render(); };
    chips.appendChild(b);
  }

  // Rezept-Karten
  const grid = $('#grid');
  grid.innerHTML = '';
  const items = sortItems(groupedList());

  if (!data.recipes.length) {
    grid.innerHTML = `<div class="empty">Noch keine Rezepte geladen.<br>
      Tippe oben auf <strong>⟳</strong>, wenn du Internet hast.</div>`;
  } else if (!items.length) {
    grid.innerHTML = `<div class="empty">Nichts gefunden.</div>`;
  }

  // Scroll-Label orientiert sich am linken Rezept der Zeile (alphabetische Sortierung)
  const showDividers = sortMode === 'alpha' && activeCategory === 'Alle' && !query.trim();

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'card';
    if (item.group) {
      const groupImgs = item.members.flatMap(m => imagesOf(m));
      card.innerHTML = groupImgs.length
        ? `<img class="photo" src="${esc(groupImgs[Math.floor(Math.random() * groupImgs.length)])}" alt="" loading="lazy">`
        : `<div class="photo placeholder">${emojiFor(item.members[0])}</div>`;
      const info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = `<div class="title">${esc(item.group)}</div>
        <div class="meta">${item.members.length} ${item.members.length === 1 ? 'Variante' : 'Varianten'} ›</div>`;
      card.appendChild(info);
      card.onclick = () => openGroup(item.group);
    } else {
      const r = item.recipe;
      const cover = randomImage(r);
      card.innerHTML = cover
        ? `<img class="photo" src="${esc(cover)}" alt="" loading="lazy">`
        : `<div class="photo placeholder">${emojiFor(r)}</div>`;
      const info = document.createElement('div');
      info.className = 'info';
      const meta = [categoryLabel(r), displayDuration(r.time)].filter(Boolean).join(' · ');
      info.innerHTML = `<div class="title">${titleWithEmoji(r)}</div>` +
        (meta ? `<div class="meta">${esc(meta)}</div>` : '');
      card.appendChild(info);
      card.onclick = () => openRecipe(r.id);
    }
    // Neu/Update-Hinweis: Umrandung + Ecken-Badge (für einen Tag)
    const badge = itemBadge(item);
    if (badge) {
      card.classList.add('badge-' + badge);
      const b = document.createElement('span');
      b.className = 'card-badge ' + badge;
      b.textContent = badge === 'neu' ? 'Neu' : 'Update';
      card.appendChild(b);
    }
    grid.appendChild(card);
  }

  // „＋ Neues Rezept“-Kachel, wenn Bearbeiten auf diesem Gerät aktiviert ist
  if (window.editorGridCard) {
    const addCard = window.editorGridCard();
    if (addCard) grid.appendChild(addCard);
  }

  $('#status').textContent = data.recipes.length
    ? `${data.recipes.length} Rezepte · Stand: ${data.updated ? new Date(data.updated).toLocaleString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'}`
    : '';

  setupScrollLabel();
}

/* ---------- Detailansicht ---------- */

function openRecipe(id, opts = {}) {
  rememberScroll();
  renderDetail(id, opts);
  $('#detail').scrollTop = 0;
  pushView({ view: 'recipe', id, random: !!opts.random });
  // ISO-Check im Hintergrund: hat sich GENAU DIESES Rezept geändert,
  // wird die offene Ansicht sofort mit den frischen Daten neu gezeichnet
  const shownBefore = JSON.stringify(data.recipes.find(r => r.id === id) || null);
  checkAndUpdateIfNeeded({ quiet: true }).then(changed => {
    if (!changed) return;
    const now = data.recipes.find(r => r.id === id);
    if (!now || JSON.stringify(now) === shownBefore) return; // dieses Rezept unverändert
    const detail = $('#detail');
    // Nur neu zeichnen, wenn die Detailansicht noch offen ist (und kein Wochenplan drin)
    if (!detail.hidden && !detail.querySelector('.weekplan-container')) {
      renderDetail(id);
      toast('🔄 Rezept aktualisiert');
    }
  });
}

function openGroup(name) {
  rememberScroll();
  renderGroup(name);
  $('#detail').scrollTop = 0;
  pushView({ view: 'group', group: name });
}

function renderGroup(name) {
  const members = data.recipes.filter(r => r.group === name);
  if (!members.length) return;
  const el = $('#detail');
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <button class="detail-home" aria-label="Startseite">🏠</button>
    <div class="detail-body group-body">
      <h2>${esc(name)}</h2>
      <div class="detail-meta">${members.length} ${members.length === 1 ? 'Variante' : 'Varianten'} – such dir eine aus</div>
      <div class="variant-list">
        ${members.map(m => `
          <button class="variant" data-id="${esc(m.id)}">
            ${imagesOf(m).length
              ? `<img src="${esc(imagesOf(m)[0])}" alt="">`
              : `<span class="v-emoji">${emojiFor(m)}</span>`}
            <span class="v-text">${titleWithEmoji(m)}${m.time ? `<small>${esc(m.time)}</small>` : ''}</span>
            <span class="v-arrow">›</span>
          </button>`).join('')}
      </div>
    </div>`;
  el.querySelector('.detail-close').onclick = () => closeOverlay();
  el.querySelector('.detail-home').onclick = () => goHome();
  for (const b of el.querySelectorAll('.variant')) {
    b.onclick = () => openRecipe(b.dataset.id);
  }
  el.hidden = false;
  document.body.style.overflow = 'hidden';
}

// Foto-Bereich der Detailansicht: ein Foto, oder Wisch-Galerie mit Punkten
function detailPhotosHTML(r) {
  const imgs = imagesOf(r);
  if (!imgs.length) return `<div class="detail-photo placeholder">${emojiFor(r)}</div>`;
  if (imgs.length === 1) return `<img class="detail-photo" src="${esc(imgs[0])}" alt="">`;
  return `<div class="detail-photos-wrap">
      <div class="detail-photos">
        ${imgs.map(i => `<img class="detail-photo" src="${esc(i)}" alt="">`).join('')}
      </div>
      <button class="photo-nav prev" aria-label="Vorheriges Foto">‹</button>
      <button class="photo-nav next" aria-label="Nächstes Foto">›</button>
    </div>
    <div class="photo-dots">${imgs.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('')}</div>`;
}

function wirePhotoDots(el) {
  const strip = el.querySelector('.detail-photos');
  if (!strip) return;
  const dots = el.querySelectorAll('.photo-dots span');
  const update = () => {
    const i = Math.round(strip.scrollLeft / strip.clientWidth);
    dots.forEach((d, n) => d.classList.toggle('on', n === i));
  };
  strip.addEventListener('scroll', update, { passive: true });

  // Pfeil-Buttons an den Fotoseiten: ein Bild weiter/zurück scrollen
  const count = strip.children.length;
  el.querySelector('.photo-nav.prev')?.addEventListener('click', () => {
    const i = Math.max(0, Math.round(strip.scrollLeft / strip.clientWidth) - 1);
    strip.scrollTo({ left: i * strip.clientWidth, behavior: 'smooth' });
  });
  el.querySelector('.photo-nav.next')?.addEventListener('click', () => {
    const i = Math.min(count - 1, Math.round(strip.scrollLeft / strip.clientWidth) + 1);
    strip.scrollTo({ left: i * strip.clientWidth, behavior: 'smooth' });
  });
}

// Zeigt "Hinzugefügt am" / "Zuletzt bearbeitet am" ganz unten auf der
// Rezeptseite — nur im DOM, NICHT im geteilten Foto (shareRecipeAsImage()
// zeichnet ein komplett eigenes Canvas-Bild, das nie hier vorbeischaut).
// Ältere Bestandsrezepte haben evtl. kein "created", dann entfällt nur die erste Zeile.
function detailDatesHTML(r) {
  const fmt = iso => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const lines = [];
  if (r.updated) lines.push(`Zuletzt bearbeitet am ${fmt(r.updated)}`);
  if (r.created) lines.push(`Hinzugefügt am ${fmt(r.created)}`);
  if (!lines.length) return '';
  return `<div class="detail-dates">${lines.map(esc).join('<br>')}</div>`;
}

/* ---------- Fotos groß ansehen ---------- */

// Vollbild mit allen Fotos des offenen Rezepts: seitlich wischen blättert,
// ✕, nach unten wischen oder Zurück schließt
function openLightbox(index) {
  if (document.querySelector('.lightbox')) return;
  const srcs = [...$('#detail').querySelectorAll('img.detail-photo')].map(img => img.getAttribute('src'));
  const many = srcs.length > 1;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Foto groß');
  box.innerHTML = `
    <div class="lightbox-strip">${srcs.map(src => `<div class="lightbox-slide"><img src="${esc(src)}" alt=""></div>`).join('')}</div>
    <button class="lightbox-close" aria-label="Schließen">✕</button>
    ${many ? `<button class="lightbox-nav prev" aria-label="Vorheriges Foto">‹</button>
      <button class="lightbox-nav next" aria-label="Nächstes Foto">›</button>
      <div class="lightbox-count"></div>` : ''}`;
  document.body.appendChild(box);
  history.pushState({ ...history.state, view: 'photo', depth: navDepth() + 1 }, '');

  const strip = box.querySelector('.lightbox-strip');
  const current = () => Math.round(strip.scrollLeft / strip.clientWidth);
  const update = () => {
    if (!many) return;
    const i = current();
    box.dataset.index = i;
    box.querySelector('.lightbox-count').textContent = `${i + 1} / ${srcs.length}`;
    box.querySelector('.prev').hidden = i === 0;
    box.querySelector('.next').hidden = i === srcs.length - 1;
  };
  box.dataset.index = index;
  strip.scrollLeft = index * strip.clientWidth;
  update();
  strip.addEventListener('scroll', update, { passive: true });

  const close = () => history.back();
  box.querySelector('.lightbox-close').onclick = close;
  box.querySelector('.prev')?.addEventListener('click', () => strip.scrollBy({ left: -strip.clientWidth, behavior: 'smooth' }));
  box.querySelector('.next')?.addEventListener('click', () => strip.scrollBy({ left: strip.clientWidth, behavior: 'smooth' }));

  let start = null;
  box.addEventListener('touchstart', e => {
    start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  box.addEventListener('touchend', e => {
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    start = null;
    if (dy > 90 && dy > Math.abs(dx) * 1.5) close();
  });
}

// Schließen und die kleine Galerie auf das zuletzt gesehene Foto stellen
function closeLightbox(box) {
  const index = Number(box.dataset.index) || 0;
  box.remove();
  const small = $('#detail').querySelector('.detail-photos');
  if (small) small.scrollLeft = index * small.clientWidth;
}

function renderDetail(id, opts = {}) {
  const r = data.recipes.find(x => x.id === id);
  if (!r) return;
  const el = $('#detail');
  const meta = [categoryLabel(r), displayDuration(r.time), r.servings].filter(Boolean).join(' · ');
  // Verlinkte Rezepte ("Dazu passt auch") — nur die, die noch existieren
  const related = (r.related || []).map(rid => data.recipes.find(x => x.id === rid)).filter(Boolean);
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="detail-actions-right">
      <button class="detail-share" aria-label="Rezept teilen">📤</button>
      ${opts.random ? '<button class="detail-random" aria-label="Nochmal würfeln">🎲</button>' : ''}
      <button class="detail-home" aria-label="Startseite">🏠</button>
    </div>
    ${detailPhotosHTML(r)}
    <div class="detail-body">
      <h2>${titleWithEmoji(r)}</h2>
      ${meta ? `<div class="detail-meta">${esc(meta)}</div>` : ''}
      ${(r.ingredients || []).length ? `<h3>Zutaten</h3>
        ${ingredientsHTML(r.ingredients)}` : ''}
      ${(r.steps || []).length ? `<h3>Zubereitung</h3>
        <ol>${r.steps.map(s => `<li><span>${esc(s)}</span></li>`).join('')}</ol>` : ''}
      ${r.notes ? `<div class="detail-notes">${esc(r.notes)}</div>` : ''}
      ${related.length ? `<h3>Dazu passt auch</h3>
        <div class="related-list">
          ${related.map(rel => `<button class="related-item" data-id="${esc(rel.id)}">
            ${imagesOf(rel).length ? `<img src="${esc(randomImage(rel))}" alt="">` : `<span class="related-emoji">${emojiFor(rel)}</span>`}
            <span class="related-text">${titleWithEmoji(rel)}</span>
          </button>`).join('')}
        </div>` : ''}
      ${detailDatesHTML(r)}
    </div>`;
  for (const b of el.querySelectorAll('.related-item')) {
    b.onclick = () => openRecipe(b.dataset.id);
  }
  el.querySelector('.detail-close').onclick = () => closeOverlay();
  el.querySelector('.detail-home').onclick = () => goHome();
  el.querySelector('.detail-share').onclick = () => shareRecipeAsImage(r);
  const rnd = el.querySelector('.detail-random');
  if (rnd) {
    rnd.onclick = () => {
      const list = filtered().filter(x => x.id !== id);
      if (!list.length) return toast('Mehr gibt es nicht 🤷');
      const next = list[Math.floor(Math.random() * list.length)];
      renderDetail(next.id, { random: true });
      // ersetzt den Verlaufseintrag: einmal zurück führt immer zur Übersicht
      replaceView({ view: 'recipe', id: next.id, random: true });
    };
  }
  wirePhotoDots(el);
  el.querySelectorAll('img.detail-photo').forEach((img, i) => { img.onclick = () => openLightbox(i); });
  if (window.editorEnhanceDetail) window.editorEnhanceDetail(el, id);
  el.hidden = false;
  document.body.style.overflow = 'hidden';
}

/* ---------- Rezept als Bild teilen (One-Pager) ---------- */

// Zeilenumbruch für Canvas-Text: bricht bei Wortgrenzen um auf maxWidth
function wrapCanvasText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Zeichnet ein Bild zugeschnitten (object-fit: cover) in ein Rechteck
function drawImageCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale, sh = h / scale;
  const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// Erstellt ein Poster-Bild des Rezepts (Foto, Titel, Zutaten, Zubereitung,
// Wasserzeichen) und öffnet damit den nativen Teilen-Dialog des Handys.
async function shareRecipeAsImage(r) {
  toast('Erstelle Bild …');
  try {
    const W = 900;
    const MARGIN = 56;
    const CONTENT_W = W - MARGIN * 2;
    const MAX_H = 3000; // großzügig bemessen, wird am Ende zugeschnitten

    // Farben/Schriften wie in der App (siehe :root in style.css)
    const PAPER = '#F8F4EE', INK = '#1D1814', MUTED = '#6F645B', ACCENT = '#B8470F', HAIR = '#E7DED2', SOFT = '#F4E7DA';
    const SERIF = "Fraunces, 'Iowan Old Style', Georgia, serif";
    const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    // Canvas zeichnet mit der Schrift nur, wenn sie schon geladen ist
    try {
      await Promise.all([
        document.fonts.load(`600 52px ${SERIF}`),
        document.fonts.load(`500 28px ${SERIF}`),
        document.fonts.load(`italic 500 27px ${SERIF}`),
      ]);
    } catch (e) { /* Fallback-Serife */ }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = MAX_H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, MAX_H);

    // Foto-Banner mit abgerundetem Unterrand (wie die Rezeptseite)
    const roundedBottom = (h, rad) => {
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.lineTo(W, h - rad);
      ctx.quadraticCurveTo(W, h, W - rad, h); ctx.lineTo(rad, h);
      ctx.quadraticCurveTo(0, h, 0, h - rad); ctx.closePath();
    };

    let y = 0;
    const BANNER_H = 520;
    const imgs = imagesOf(r);
    if (imgs.length) {
      try {
        const img = await loadImageEl(imgs[0]);
        ctx.save(); roundedBottom(BANNER_H, 40); ctx.clip();
        drawImageCover(ctx, img, 0, 0, W, BANNER_H);
        ctx.restore();
        y = BANNER_H;
      } catch (e) { /* Bild nicht ladbar — ohne Banner weiter */ }
    }
    if (!y) {
      const emojiBannerH = 300;
      ctx.save(); roundedBottom(emojiBannerH, 40); ctx.clip();
      ctx.fillStyle = SOFT;
      ctx.fillRect(0, 0, W, emojiBannerH);
      ctx.restore();
      ctx.font = '150px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emojiFor(r), W / 2, emojiBannerH / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      y = emojiBannerH;
    }

    y += 62;
    ctx.fillStyle = INK;
    ctx.font = `600 54px ${SERIF}`;
    const titleText = r.title + (r.emoji ? ' ' + r.emoji : '');
    for (const line of wrapCanvasText(ctx, titleText, CONTENT_W)) { y += 58; ctx.fillText(line, MARGIN, y); }

    const meta = [categoryLabel(r), displayDuration(r.time), r.servings].filter(Boolean).join('  ·  ').toUpperCase();
    if (meta) {
      y += 44;
      ctx.font = `500 22px ${SANS}`;
      ctx.fillStyle = MUTED;
      ctx.fillText(meta, MARGIN, y);
    }

    y += 34;
    ctx.strokeStyle = HAIR;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(MARGIN, y); ctx.lineTo(W - MARGIN, y); ctx.stroke();

    if ((r.ingredients || []).length) {
      y += 58;
      ctx.font = `600 38px ${SERIF}`;
      ctx.fillStyle = INK;
      ctx.fillText('Zutaten', MARGIN, y);
      for (const ing of r.ingredients) {
        const heading = String(ing).trim().match(/^\*\s*(.+)/);
        if (heading) {
          y += 46;
          ctx.font = `700 21px ${SANS}`;
          ctx.fillStyle = ACCENT;
          for (const line of wrapCanvasText(ctx, heading[1].toUpperCase(), CONTENT_W)) { y += 28; ctx.fillText(line, MARGIN, y); }
        } else {
          ctx.font = `400 27px ${SANS}`;
          ctx.fillStyle = INK;
          const lines = wrapCanvasText(ctx, String(ing), CONTENT_W - 28);
          y += 12;
          lines.forEach((line, li) => { y += 38; ctx.fillText(line, MARGIN + 28, y); });
          ctx.fillStyle = ACCENT;
          ctx.beginPath(); ctx.arc(MARGIN + 7, y - lines.length * 38 + 28, 4, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    if ((r.steps || []).length) {
      y += 84;
      ctx.font = `600 38px ${SERIF}`;
      ctx.fillStyle = INK;
      ctx.fillText('Zubereitung', MARGIN, y);
      r.steps.forEach((step, i) => {
        ctx.font = `400 27px ${SANS}`;
        const lines = wrapCanvasText(ctx, String(step), CONTENT_W - 56);
        y += 14;
        const top = y;
        lines.forEach(line => { y += 40; ctx.fillStyle = INK; ctx.fillText(line, MARGIN + 56, y); });
        // Serifen-Ziffer, auf Höhe der ersten Zeile
        ctx.font = `500 40px ${SERIF}`;
        ctx.fillStyle = ACCENT;
        ctx.fillText(String(i + 1), MARGIN, top + 40);
        y += 8;
      });
    }

    if (r.notes) {
      y += 44;
      ctx.font = `italic 500 28px ${SERIF}`;
      const lines = wrapCanvasText(ctx, r.notes, CONTENT_W - 28);
      const start = y;
      ctx.fillStyle = INK;
      for (const line of lines) { y += 40; ctx.fillText(line, MARGIN + 28, y); }
      ctx.fillStyle = ACCENT;
      ctx.fillRect(MARGIN, start + 8, 4, y - start);
    }

    // Wasserzeichen — rechtsbündig, mit MARGIN Abstand zum rechten Rand
    // (gleicher Abstand wie der Rest des Posters, für ein einheitliches Bild)
    y += 72;
    ctx.font = `500 24px ${SERIF}`;
    ctx.fillStyle = '#A39588';
    ctx.textAlign = 'right';
    const watermarkText = 'Made by Schrödamskis Schlemmerliste';
    ctx.fillText(watermarkText, W - MARGIN, y);
    ctx.textAlign = 'left';
    // Fester Sicherheitsabstand unter dem Wasserzeichen statt gemessener Textbox
    // (actualBoundingBoxDescent ist für Glyphen wie Emoji browserübergreifend unzuverlässig).
    const WATERMARK_SAFETY_PADDING = 40;

    // Auf die tatsächlich genutzte Höhe zuschneiden
    const finalH = Math.min(MAX_H, Math.ceil(y + WATERMARK_SAFETY_PADDING));
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = W;
    finalCanvas.height = finalH;
    finalCanvas.getContext('2d').drawImage(canvas, 0, 0, W, finalH, 0, 0, W, finalH);

    finalCanvas.toBlob(async (blob) => {
      if (!blob) return toast('❌ Bild konnte nicht erstellt werden');
      const file = new File([blob], r.id + '.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: r.title });
        } catch (e) { /* Nutzer hat den Teilen-Dialog abgebrochen */ }
      } else {
        // Fallback (z. B. Desktop ohne Web-Share-API): Bild in neuem Tab öffnen
        window.open(URL.createObjectURL(blob), '_blank');
        toast('📥 Bild geöffnet — zum Teilen speichern');
      }
    }, 'image/png');
  } catch (e) {
    console.error('Teilen fehlgeschlagen:', e);
    toast('❌ Teilen fehlgeschlagen');
  }
}

/* ---------- Navigation / Verlauf ----------
   Jede Ansicht hat genau einen Verlaufseintrag mit "depth" (Abstand zur
   Startseite). So führt Zurück immer zur vorherigen Ansicht, der Home-Knopf
   räumt den ganzen Verlauf auf, und Einstellungen/Editor ("overlay") liegen
   als eigene Einträge ÜBER der Ansicht, die darunter unverändert bleibt. */

const navDepth = () => history.state?.depth || 0;

// Abbilder der verlassenen Seiten (je Verlaufstiefe): sie liegen während der
// Zurück-Geste unter der aktuellen Seite, damit man die vorherige schon sieht
const underlays = [];
function snapshotView() {
  const depth = navDepth();
  const editor = $('#editor');
  const top = editor.hidden ? $('#detail') : editor;
  if (!depth || top.hidden) return;
  const node = top.cloneNode(true);
  node.removeAttribute('id');
  node.removeAttribute('style');
  node.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  node.className = 'nav-underlay';
  underlays[depth] = { node, scroll: top.scrollTop, isEditor: top === editor };
}

// Scroll-Position der aktuellen Ansicht merken, damit Zurück dort wieder landet
function rememberScroll() {
  snapshotView();
  const top = $('#editor').hidden ? $('#detail') : $('#editor');
  if (history.state && !top.hidden) {
    history.replaceState({ ...history.state, scroll: top.scrollTop }, '');
  }
}
function pushView(state) { history.pushState({ ...state, depth: navDepth() + 1 }, ''); }
function replaceView(state) { history.replaceState({ ...state, depth: navDepth() || 1 }, ''); }

// Einstellungen/Editor öffnen: einmal pro Seite ein Eintrag (Neuzeichnen zählt nicht)
function enterOverlay(page) {
  if (history.state?.view === 'overlay' && history.state.page === page) return;
  rememberScroll();
  pushView({ view: 'overlay', page });
}

// Reine Anzeige-Schließung (kein History-Eingriff)
function hideDetail() {
  // Sicherheitsnetz: falls Wochenplan oder Backlog gerade einen ausstehenden
  // Upload haben (Debounce-Timer läuft noch), beim Verlassen sofort sichern
  // statt bis zum Timer-Ablauf zu warten. No-op, wenn nichts aussteht.
  if (typeof flushWeekplanUpload === 'function') flushWeekplanUpload();
  if (typeof flushBacklogUpload === 'function') flushBacklogUpload();
  $('#detail').hidden = true;
  document.body.style.overflow = '';
}

// Schließen läuft IMMER über die History (history.back), damit der Verlauf
// synchron bleibt. Die kurze Sperre verhindert, dass zwei Auslöser derselben
// Geste (eigener Wisch + iPhone-Zurückgeste, Doppeltipp) zwei Ebenen springen.
let lastBackAt = 0;
function closeOverlay() {
  const now = Date.now();
  if (now - lastBackAt < 450) return;
  lastBackAt = now;
  if (history.state) history.back();
  else { closeEditor(); hideDetail(); }
}

// Home-Knopf: Ansichten schließen UND den Verlauf bis zur Startseite abräumen
function goHome() {
  const depth = navDepth();
  closeEditor();
  hideDetail();
  if (depth) history.go(-depth);
}

function renderOverlayPage(page) {
  if (page === 'settings') openSettings();
  else if (page === 'library-recipes') openLibraryRecipes();
  else if (page === 'library-categories') openLibraryCategories();
  else if (page === 'token') openTokenSetup();
  else closeEditor();
}

// Zurück-Navigation: null = Übersicht, sonst die jeweilige Ansicht wiederherstellen
window.addEventListener('popstate', e => {
  lastBackAt = Date.now();
  resetSwipe();
  document.querySelectorAll('.ed-modal-overlay, .token-share-modal').forEach(m => m.remove());
  // War ein Foto groß offen, schließt Zurück nur das: die Ansicht bleibt stehen
  const lightbox = $('.lightbox');
  if (lightbox) return closeLightbox(lightbox);
  const s = e.state;
  if (s?.view === 'overlay') {
    renderOverlayPage(s.page);
    $('#editor').scrollTop = s.scroll || 0;
    return;
  }
  const detail = $('#detail');
  if (!$('#editor').hidden) {
    closeEditor();
    // Die Ansicht unter den Einstellungen/dem Editor ist noch da: so lassen
    if (s && !detail.hidden) return;
  }
  if (!s) return hideDetail();
  if (s.view === 'group') {
    if (!data.recipes.some(r => r.group === s.group)) return goHome();
    renderGroup(s.group);
  } else if (s.view === 'recipe') {
    if (!data.recipes.some(r => r.id === s.id)) return goHome();
    renderDetail(s.id, { random: s.random });
  } else if (s.view === 'weekplan') renderWeekplan();
  else if (s.view === 'tinder') renderTinder();
  else if (s.view === 'tinder-result') renderTinderResult(s.ids || []);
  else if (s.view === 'tinder-result-recipe') renderDetail((s.ids || [])[s.winnerIndex]);
  else return hideDetail();
  detail.scrollTop = s.scroll || 0;
});

// Nach Neuladen (z.B. Update) startet die App auf der Übersicht — alter Zustand weg
history.replaceState(null, '');

/* ---------- Rezept-Tinder 🔥 ---------- */

let tinder = null; // { deck: [Rezepte], likes: [Rezepte] }

function openTinder() {
  rememberScroll();
  renderTinder();
  pushView({ view: 'tinder' });
}

// Welche Woche gerade im Wochenplan angezeigt wird (Standard: aktuelle Woche)
let weekplanViewDate = new Date();
let weekplanViewKey = null;

function openWeekplan() {
  weekplanViewDate = new Date(); // beim Öffnen immer zurück auf die laufende Woche
  clearWeekplanUpdateDot();
  rememberScroll();
  renderWeekplan();
  $('#detail').scrollTop = 0;
  pushView({ view: 'weekplan' });
}

const WEEKPLAN_KEY = 'rezeptbuch-weekplan';
const WEEKPLAN_UPDATED_KEY = 'rezeptbuch-weekplan-updated';

// "off" ist eine Liste ausgeblendeter Wochentage (z. B. "diese Woche kochen
// wir montags nicht") — wird wie ein normaler Tages-Eintrag mitgespeichert.
const emptyDays = () => ({ mo: [], di: [], mi: [], do: [], fr: [], sa: [], so: [], off: [] });

// Alte String-Werte zu Arrays normalisieren
function normalizeDays(plan) {
  const days = emptyDays();
  for (const k in days) {
    const v = plan ? plan[k] : null;
    days[k] = Array.isArray(v) ? v : (v ? [v] : []);
  }
  return days;
}

// Alle Wochen als { "2026-W28": {mo:[],...}, ... }.
// Migriert das alte Einzelwochen-Format in die aktuelle Woche.
function getAllWeekplans() {
  try {
    const raw = localStorage.getItem(WEEKPLAN_KEY);
    if (!raw) return {};
    const stored = JSON.parse(raw);
    if (stored && stored.weeks) return stored.weeks;
    if (stored && ('mo' in stored || 'di' in stored)) return { [weekKey()]: normalizeDays(stored) };
    return {};
  } catch (e) { return {}; }
}

function persistWeekplans(weeks) {
  localStorage.setItem(WEEKPLAN_KEY, JSON.stringify({ weeks }));
  localStorage.setItem(WEEKPLAN_UPDATED_KEY, new Date().toISOString());
}

// Tage einer bestimmten Woche
function getWeekplanFor(key) {
  return normalizeDays(getAllWeekplans()[key]);
}

// Eine Woche speichern (setzt auch den Daten-Timestamp, wie bei den Rezepten)
function saveWeekplanFor(key, days) {
  const weeks = getAllWeekplans();
  weeks[key] = days;
  persistWeekplans(weeks);
}

// Bequemer Wrapper: speichert in die gerade angezeigte Woche
function saveWeekplan(days) {
  saveWeekplanFor(weekplanViewKey, days);
}

/* Wochenplan-Sync über GitHub (data/weekplan.json):
   Speichern lädt alle Wochen hoch, beim Öffnen wird der neueste Stand geholt.
   Neuester ISO-Timestamp gewinnt (ganze Datei). Nutzt fetchRemoteJSON /
   pushRemoteJSON / isRemoteNewer — die gemeinsame Basis mit den Rezept-Backlog. */

// Remote-Struktur → Wochen-Map (migriert altes { days }-Format in die aktuelle Woche)
function remoteToWeeks(remote) {
  if (!remote) return null;
  if (remote.weeks) return remote.weeks;
  if (remote.days) return { [weekKey()]: normalizeDays(remote.days) };
  return null;
}

// Holt den Remote-Stand und übernimmt ihn, wenn er neuer ist als der lokale
async function syncWeekplanFromRemote() {
  const remote = await fetchRemoteJSON('data/weekplan.json');
  const weeks = remoteToWeeks(remote);
  if (!weeks || !isRemoteNewer(remote, WEEKPLAN_UPDATED_KEY)) return false;
  localStorage.setItem(WEEKPLAN_KEY, JSON.stringify({ weeks }));
  localStorage.setItem(WEEKPLAN_UPDATED_KEY, remote.updated);
  return true;
}

// Lädt ALLE lokalen Wochen zu GitHub hoch, damit andere Geräte sie sehen.
// Läuft automatisch im Hintergrund (siehe weekplanUploadDebounced/
// flushWeekplanUpload) — daher bewusst ohne Toast, wie beim Backlog.
async function uploadWeekplan() {
  if (typeof ghToken !== 'function' || !ghToken()) return;
  const payload = { updated: new Date().toISOString(), weeks: getAllWeekplans() };
  await pushRemoteJSON('data/weekplan.json', payload, 'Wochenplan aktualisiert (aus der App)');
  localStorage.setItem(WEEKPLAN_UPDATED_KEY, payload.updated);
}

// Speichert lokal SOFORT (bereits über saveWeekplan geschehen, siehe
// Aufrufstellen) und lädt 5 Sekunden nach der letzten Änderung hoch.
// flushWeekplanUpload() erzwingt das sofort (z. B. beim Verlassen der
// Ansicht), falls gerade noch ein Upload aussteht.
let weekplanUploadTimer = null;
let weekplanUploadPending = false;
function weekplanUploadDebounced() {
  weekplanUploadPending = true;
  clearTimeout(weekplanUploadTimer);
  weekplanUploadTimer = setTimeout(() => {
    weekplanUploadPending = false;
    uploadWeekplan();
  }, 5000);
}
function flushWeekplanUpload() {
  if (!weekplanUploadPending) return;
  clearTimeout(weekplanUploadTimer);
  weekplanUploadPending = false;
  uploadWeekplan();
}

/* Rezept-Backlog: Liste einzelner Einträge unter dem Wochenplan zum Sammeln
   von Rezepten, die man irgendwann mal kochen will. Nicht an eine Woche
   gebunden — bleibt beim Wechseln der Wochen unverändert. Sync läuft exakt
   wie beim Wochenplan: ISO-Timestamp-Vergleich, neuester gewinnt.
   Frühere Version speicherte einen einzigen Fließtext (ein Eintrag pro
   Zeile) — wird beim ersten Lesen automatisch in einzelne Einträge migriert. */

const BACKLOG_KEY = 'rezeptbuch-notes';
const BACKLOG_UPDATED_KEY = 'rezeptbuch-notes-updated';
const BACKLOG_LONGPRESS_MS = 200; // 0.2 Sekunden gedrückt halten, bevor sich die Zeile löst

// Migriert einen einzelnen Eintrag: Rezept-IDs und "TEXT:..." bleiben
// unverändert, alte reine Freitext-Einträge (aus der Zeit vor der
// Rezept-Suche im Backlog) bekommen automatisch das "TEXT:"-Präfix, damit
// sie nicht mehr stillschweigend beim Rendern verschwinden (backlogRowHTML
// gibt für einen Eintrag ohne Treffer sonst einen leeren String zurück).
function migrateBacklogEntry(entry) {
  if (entry.startsWith('TEXT:')) return entry;
  if (data.recipes.some(r => r.id === entry)) return entry;
  return 'TEXT:' + entry;
}

function getBacklogItems() {
  const raw = localStorage.getItem(BACKLOG_KEY);
  if (!raw) return [];
  let items;
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : null;
  } catch (e) { /* alter Fließtext, kein JSON — unten migrieren */ }
  if (!items) items = raw.split('\n').map(s => s.trim()).filter(Boolean);
  const migrated = items.map(migrateBacklogEntry);
  if (JSON.stringify(migrated) !== JSON.stringify(items)) saveBacklogItemsLocal(migrated);
  return migrated;
}

function saveBacklogItemsLocal(items) {
  localStorage.setItem(BACKLOG_KEY, JSON.stringify(items));
  localStorage.setItem(BACKLOG_UPDATED_KEY, new Date().toISOString());
}

// Holt den Remote-Stand und übernimmt ihn, wenn er neuer ist als der lokale.
// Akzeptiert sowohl das neue "items"-Array als auch den alten "text"-Fließtext
// (falls ein anderes Gerät noch die alte App-Version nutzt).
async function syncBacklogFromRemote() {
  const remote = await fetchRemoteJSON('data/backlog.json');
  if (!remote || !isRemoteNewer(remote, BACKLOG_UPDATED_KEY)) return false;
  const items = Array.isArray(remote.items) ? remote.items.filter(x => typeof x === 'string')
    : (typeof remote.text === 'string' ? remote.text.split('\n').map(s => s.trim()).filter(Boolean) : null);
  if (!items) return false;
  localStorage.setItem(BACKLOG_KEY, JSON.stringify(items));
  localStorage.setItem(BACKLOG_UPDATED_KEY, remote.updated);
  return true;
}

// Lädt die lokale Liste zu GitHub hoch, damit andere Geräte sie sehen.
// "text" wird als Fließtext-Kopie mitgeschickt, damit ein Gerät mit noch
// alter App-Version den Stand übergangsweise weiterlesen kann.
async function uploadBacklog(items) {
  if (typeof ghToken !== 'function' || !ghToken()) return;
  const payload = { updated: new Date().toISOString(), items, text: items.join('\n') };
  await pushRemoteJSON('data/backlog.json', payload, 'Backlog aktualisiert (aus der App)');
  localStorage.setItem(BACKLOG_UPDATED_KEY, payload.updated);
}

// Speichert lokal SOFORT (kein Datenverlust) und lädt 5 Sekunden nach der
// letzten Änderung hoch, damit nicht bei jedem Tastendruck ein
// GitHub-Commit ausgelöst wird. flushBacklogUpload() erzwingt das sofort
// (z. B. beim Verlassen der Ansicht), falls gerade noch ein Upload aussteht.
let backlogUploadTimer = null;
let backlogUploadPending = false;
function saveBacklogDebounced(items) {
  saveBacklogItemsLocal(items);
  backlogUploadPending = true;
  clearTimeout(backlogUploadTimer);
  backlogUploadTimer = setTimeout(() => {
    backlogUploadPending = false;
    uploadBacklog(items);
  }, 5000);
}
function flushBacklogUpload() {
  if (!backlogUploadPending) return;
  clearTimeout(backlogUploadTimer);
  backlogUploadPending = false;
  uploadBacklog(getBacklogItems());
}

// HTML für eine Backlog-Zeile: Griff links zum Verschieben (Finger-Drag),
// Löschen-Button rechts. Einträge können Rezept-IDs oder TEXT:... Freitext sein.
function backlogRowHTML(entry, i) {
  let displayName = '';
  let emoji = '👨‍🍳'; // Freitext-Notizen ohne verknüpftes Rezept: Koch-Emoji
  const isText = entry.startsWith('TEXT:');
  if (isText) {
    displayName = entry.substring(5);
  } else {
    const recipe = data.recipes.find(r => r.id === entry);
    displayName = recipe ? recipe.title : '';
    // Rezept gefunden: dessen eigenes hinterlegtes Emoji übernehmen
    emoji = recipe ? emojiFor(recipe) : '❓';
  }
  if (!displayName) return '';
  // Freitext-Notizen sind nachträglich editierbar (Klick auf den Text),
  // Rezept-Einträge nicht — deren Name hängt am Rezept, nicht am Eintrag.
  return `<div class="backlog-row" data-i="${i}" data-entry="${esc(entry)}">
    <button type="button" class="backlog-drag" aria-label="Verschieben">⠿</button>
    <span class="backlog-entry-display${isText ? ' editable' : ''}">${emoji} ${esc(displayName)}</span>
    <button type="button" class="backlog-remove" aria-label="Entfernen">✕</button>
  </div>`;
}

function backlogListHTML(items) {
  return items.map((e, i) => backlogRowHTML(e, i)).join('');
}

// Verdrahtet die Backlog-Liste mit Autocomplete (wie Wochenplan). Einträge
// können Rezept-IDs oder TEXT:... Freitext sein. Gibt ein Controller-Objekt
// mit refresh() zurück, damit ein Remote-Sync die Liste von außen neu
// einlesen kann.
function wireBacklogList(el, weekplan) {
  const list = el.querySelector('#backlog-list');
  const autocompleteDiv = el.querySelector('.backlog-autocomplete');
  if (!list || !autocompleteDiv) return null;

  let items = getBacklogItems();
  // WICHTIG: attachDragHandlers() muss nach JEDEM Neuzeichnen erneut laufen —
  // list.innerHTML ersetzt alle Zeilen komplett, die neuen .backlog-drag-
  // Griffe haben sonst keinerlei Pointer-Handler mehr (Bug: nach Löschen/
  // Bearbeiten/Hinzufügen eines Eintrags ließ sich plötzlich GAR NICHTS
  // mehr per Touch verschieben, weil rerender() das bisher vergessen hat).
  const rerender = () => { list.innerHTML = backlogListHTML(items); reattachListeners(); attachDragHandlers(); };
  const controller = {
    refresh() {
      items = getBacklogItems();
      rerender();
    },
    // Fügt einen Eintrag hinzu (z.B. ein aus dem Wochenplan zurückgezogenes Gericht)
    addItem(entry) {
      items.push(entry);
      saveBacklogDebounced(items);
      rerender();
    },
  };

  const searchInput = autocompleteDiv.querySelector('.backlog-search');
  const addBtn = autocompleteDiv.querySelector('.backlog-add-btn');
  const suggestionsDiv = autocompleteDiv.querySelector('.backlog-suggestions');

  // Suche implementieren. Absichtlich mit try/catch + sichtbarem Toast bei
  // einem Fehler statt eines stillen Fehlschlags — falls z.B. ein Rezept
  // mit unerwarteten/fehlenden Feldern in data.recipes steckt, würde die
  // Suche sonst kommentarlos für IMMER aufhören, Vorschläge zu zeigen
  // (ein einmal geworfener Fehler in .filter() bricht den kompletten
  // Aufruf ab, ohne dass man das ohne Entwicklertools bemerken würde).
  searchInput.addEventListener('input', (e) => {
    try {
      const query = e.target.value.toLowerCase().trim();
      if (!query) {
        suggestionsDiv.hidden = true;
        return;
      }

      // Nach Rezepten im aktuellen Modus suchen
      const matches = data.recipes.filter(r => {
        if (recipeMode(r) !== mode) return false; // nur aktueller Modus
        const title = String(r.title || '').toLowerCase();
        const category = Array.isArray(r.category) ? r.category.join(' ').toLowerCase() : String(r.category || '').toLowerCase();
        return title.includes(query) || category.includes(query);
      }).slice(0, 8);

      if (matches.length === 0) {
        suggestionsDiv.hidden = true;
        return;
      }

      // Zeige Vorschläge
      suggestionsDiv.innerHTML = matches.map(r =>
        `<div class="backlog-suggestion" data-id="${esc(r.id)}">${emojiFor(r)} ${esc(r.title)}</div>`
      ).join('');
      suggestionsDiv.hidden = false;

      // Click Handler für Vorschläge
      for (const suggEl of suggestionsDiv.querySelectorAll('.backlog-suggestion')) {
        suggEl.onclick = () => {
          const recipeId = suggEl.dataset.id;
          items.push(recipeId);
          saveBacklogDebounced(items);
          searchInput.value = '';
          suggestionsDiv.hidden = true;
          rerender();
        };
      }
    } catch (err) {
      console.error('Backlog-Suche fehlgeschlagen:', err);
      toast('❌ Suche fehlgeschlagen: ' + err.message);
    }
  });

  // Add-Button für Freitext
  addBtn.onclick = () => {
    const text = searchInput.value.trim();
    if (!text) return;
    const entry = 'TEXT:' + text;
    items.push(entry);
    saveBacklogDebounced(items);
    searchInput.value = '';
    suggestionsDiv.hidden = true;
    rerender();
  };

  // Enter-Key
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!suggestionsDiv.hidden && suggestionsDiv.children.length > 0) {
        suggestionsDiv.children[0].click();
      } else {
        addBtn.click();
      }
    }
  });

  // Löschen-Button: Eintrag sofort entfernen; Klick auf eine Freitext-Notiz
  // wandelt sie in ein Eingabefeld um (nachträglich bearbeitbar)
  function reattachListeners() {
    for (const removeBtn of list.querySelectorAll('.backlog-remove')) {
      removeBtn.onclick = (e) => {
        e.preventDefault();
        const row = removeBtn.closest('.backlog-row');
        const i = Number(row.dataset.i);
        items.splice(i, 1);
        saveBacklogDebounced(items);
        rerender();
      };
    }

    for (const display of list.querySelectorAll('.backlog-entry-display.editable')) {
      display.onclick = () => {
        const row = display.closest('.backlog-row');
        const i = Number(row.dataset.i);
        const currentText = items[i].substring(5); // "TEXT:" abschneiden

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'backlog-edit-input';
        input.value = currentText;
        display.replaceWith(input);
        input.focus();
        input.select();

        const finishEdit = (save) => {
          if (save) {
            const newText = input.value.trim();
            if (newText) {
              items[i] = 'TEXT:' + newText;
              saveBacklogDebounced(items);
            } else {
              // leer gelassen → Eintrag entfernen
              items.splice(i, 1);
              saveBacklogDebounced(items);
            }
          }
          rerender();
        };

        input.addEventListener('blur', () => finishEdit(true));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
        });
      };
    }
  }

  // Griff: mit dem Finger ziehen zum Umsortieren oder auf Wochentag verschieben
  let drag = null;
  const autoScrollZone = () => el.clientHeight * 0.25;
  const AUTOSCROLL_MAX_SPEED = 18;

  function updateDragTargets(clientX, clientY) {
    const dayEl = document.elementFromPoint(clientX, clientY)?.closest('.weekplan-day');
    if (dayEl !== drag.overDay) {
      drag.overDay?.classList.remove('backlog-drop-target');
      dayEl?.classList.add('backlog-drop-target');
      drag.overDay = dayEl || null;
    }
    if (drag.overDay) return;

    const draggedIdx = Number(drag.row.dataset.i);
    for (const sib of list.querySelectorAll('.backlog-row')) {
      if (sib === drag.row) continue;
      const sIdx = Number(sib.dataset.i);
      if (sIdx >= items.length) continue;
      const rect = sib.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      // Einsortieren statt Tauschen: schrittweise mit dem jeweiligen Nachbarn
      // tauschen, bis die gezogene Zeile am Ziel steht. So bleibt die Reihenfolge
      // der übrigen Einträge erhalten, auch wenn ein schneller Wisch mehrere
      // Zeilen in einem einzigen Bewegungsereignis überspringt. Es wird immer
      // nur die NACHBAR-Zeile verschoben, nie drag.row selbst (Pointer Capture).
      const byIdx = new Map([...list.querySelectorAll('.backlog-row')].map(el => [Number(el.dataset.i), el]));
      const dir = sIdx < draggedIdx ? -1 : 1;
      let cur = draggedIdx;
      while (cur !== sIdx) {
        const next = cur + dir;
        const neighbor = byIdx.get(next);
        [items[cur], items[next]] = [items[next], items[cur]];
        if (dir < 0) list.insertBefore(neighbor, drag.row.nextSibling);
        else list.insertBefore(neighbor, drag.row);
        neighbor.dataset.i = cur;
        byIdx.set(cur, neighbor);
        cur = next;
      }
      drag.row.dataset.i = sIdx;
      break;
    }
  }

  function maybeAutoScroll(y) {
    const zone = autoScrollZone();
    if (y < zone) {
      el.scrollBy(0, -AUTOSCROLL_MAX_SPEED * (1 - y / zone));
      return true;
    }
    if (y > el.clientHeight - zone) {
      el.scrollBy(0, AUTOSCROLL_MAX_SPEED * (1 - (el.clientHeight - y) / zone));
      return true;
    }
    return false;
  }

  let autoScrollTimer = null;
  function autoScrollTick() {
    if (!drag) {
      clearInterval(autoScrollTimer);
      autoScrollTimer = null;
      return;
    }
    if (maybeAutoScroll(drag.lastClientY)) updateDragTargets(drag.lastClientX, drag.lastClientY);
  }

  function attachDragHandlers() {
    for (const handle of list.querySelectorAll('.backlog-drag')) {
      handle.onclick = null; // clearen
      handle.onpointerdown = null;
    }
    for (const handle of list.querySelectorAll('.backlog-drag')) {
      // Erst nach 0.5s Gedrückthalten auf dem Griff löst sich die Zeile zum
      // Verschieben — sofortiges Aktivieren war auf echten Geräten nicht
      // zuverlässig (Konflikt mit der nativen Scroll-Gesten-Erkennung).
      let pendingPointerId = null;
      let pendingStartX = 0, pendingStartY = 0;
      let pressTimer = null;

      const activate = (row, startX, startY, pointerId) => {
        hapticPulse();
        const rect = row.getBoundingClientRect();
        const ghost = row.cloneNode(true);
        ghost.classList.add('backlog-ghost');
        ghost.style.position = 'fixed';
        ghost.style.left = rect.left + 'px';
        ghost.style.top = rect.top + 'px';
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        ghost.style.margin = '0';
        ghost.style.pointerEvents = 'none';
        document.body.appendChild(ghost);

        drag = {
          row, ghost, pointerId, startClientX: startX, startClientY: startY,
          overDay: null, lastClientX: startX, lastClientY: startY,
        };
        row.classList.add('dragging');
        row.style.opacity = '0';
        row.style.pointerEvents = 'none';
        lockTouchAction();
        if (!autoScrollTimer) autoScrollTimer = setInterval(autoScrollTick, 16);

        const handleMove = (e) => {
          if (!drag || e.pointerId !== drag.pointerId) return;
          drag.ghost.style.transform = `translate(${e.clientX - drag.startClientX}px, ${e.clientY - drag.startClientY}px)`;
          drag.lastClientX = e.clientX;
          drag.lastClientY = e.clientY;
          maybeAutoScroll(e.clientY);
          updateDragTargets(e.clientX, e.clientY);
        };
        const handleEnd = (e) => {
          if (!drag || (e && e.pointerId !== drag.pointerId)) return;
          const { row, ghost, overDay } = drag;
          unlockTouchAction();
          ghost.remove();
          row.classList.remove('dragging');
          row.style.opacity = '';
          row.style.pointerEvents = '';
          document.removeEventListener('pointermove', handleMove);
          document.removeEventListener('pointerup', handleEnd);
          document.removeEventListener('pointercancel', handleEnd);
          drag = null;

          if (overDay) {
            overDay.classList.remove('backlog-drop-target');
            const dayKey = overDay.dataset.day;
            const i = Number(row.dataset.i);
            const entry = items[i];
            items.splice(i, 1);
            saveBacklogDebounced(items);

            if (!weekplan[dayKey]) weekplan[dayKey] = [];
            weekplan[dayKey].push(entry);
            saveWeekplan(weekplan);
            weekplanUploadDebounced();
            const selectedDiv = overDay.querySelector('.weekplan-selected');
            if (selectedDiv) {
              let displayName = '';
              if (entry.startsWith('TEXT:')) {
                displayName = entry.substring(5);
              } else {
                const recipe = data.recipes.find(r => r.id === entry);
                displayName = recipe ? titleWithEmoji(recipe) : '';
              }
              if (displayName) {
                selectedDiv.insertAdjacentHTML('beforeend', weekplanTagHTML(entry, displayName, dayKey));
                attachTagHandlers(selectedDiv, weekplan, controller);
              }
            }
            toast('📅 In den Wochenplan verschoben');
          } else {
            // Nur umsortiert (nicht auf einen Wochentag gezogen) — die
            // neue Reihenfolge muss hier explizit gespeichert werden,
            // sonst geht sie beim nächsten Sync/Neuladen wieder verloren.
            saveBacklogDebounced(items);
          }
          rerender();
        };
        document.addEventListener('pointermove', handleMove);
        document.addEventListener('pointerup', handleEnd);
        document.addEventListener('pointercancel', handleEnd);
      };

      handle.onpointerdown = (e) => {
        const row = handle.closest('.backlog-row');
        const i = Number(row.dataset.i);
        if (i >= items.length) return;
        e.preventDefault();
        e.stopPropagation();

        pendingPointerId = e.pointerId;
        pendingStartX = e.clientX;
        pendingStartY = e.clientY;
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* synthetische Events */ }

        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (pendingPointerId === null) return; // Finger schon losgelassen
          activate(row, pendingStartX, pendingStartY, pendingPointerId);
        }, BACKLOG_LONGPRESS_MS);
      };

      handle.onpointermove = (e) => {
        if (pendingPointerId !== e.pointerId || drag) return;
        // Noch in der Long-Press-Wartezeit: zu viel Bewegung = kein Zug-
        // Wunsch, sondern Scroll-Versuch o.ä. — Long-Press abbrechen
        const dx = e.clientX - pendingStartX, dy = e.clientY - pendingStartY;
        if (Math.hypot(dx, dy) > 12) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };

      const cancelPending = (e) => {
        if (pendingPointerId !== null && (!e || e.pointerId === pendingPointerId)) {
          clearTimeout(pressTimer);
          pressTimer = null;
          pendingPointerId = null;
        }
      };
      handle.onpointerup = cancelPending;
      handle.onpointercancel = cancelPending;
    }
  }

  reattachListeners();
  attachDragHandlers();

  return controller;
}

// HTML für einen Wochenplan-Eintrag — Rezepte sind anklickbar (öffnen das Rezept).
// In vergangenen Wochen (readonly) entfällt der X-Button zum Entfernen.
function weekplanTagHTML(entry, displayName, dayKey, readonly = false) {
  const isRecipe = !entry.startsWith('TEXT:');
  // Ziehgriff links (wie beim Backlog): nur so kann man die Pille verschieben,
  // das ausschließlich dort verankerte Long-Press verhindert, dass das Handy
  // ein Gedrückthalten auf dem Text als "Text markieren" interpretiert.
  // Ohne Griff (ausgeblendeter/vergangener Tag, nur lesbar) bekommt die
  // Pille die Klasse "no-drag" — sonst bliebe die für den Griff gedachte
  // eckige linke Ecke ohne Griff stehen und die Pille wirkt "gequetscht".
  return `<span class="weekplan-tag${readonly ? ' no-drag' : ''}" data-entry="${esc(entry)}" data-day="${dayKey}">` +
    (readonly ? '' : `<span class="weekplan-tag-drag" aria-label="Verschieben">⠿</span>`) +
    `<span class="weekplan-tag-text${isRecipe ? ' clickable' : ''}">${esc(displayName)}</span>` +
    (readonly ? '' : `<button class="weekplan-tag-remove" data-entry="${esc(entry)}" data-day="${dayKey}" aria-label="Entfernen">✕</button>`) +
    `</span>`;
}

// Vibriert kurz, falls das Gerät die Vibration API unterstützt (Android
// Chrome ja, iOS Safari leider nicht — dort bleibt es einfach stumm/no-op)
// UND der Nutzer das nicht in den Einstellungen abgeschaltet hat.
const VIBRATION_KEY = 'rezeptbuch-vibration';
function vibrationEnabled() { return localStorage.getItem(VIBRATION_KEY) !== 'false'; }
let hapticSwitchLabel = null;
function hapticPulse(ms = 40) {
  if (!vibrationEnabled()) return;
  // Android/Chrome: Vibration API
  if (typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(ms); return; } catch (e) { /* weiter zum Ersatz */ }
  }
  // iPhone/Safari (ab iOS 17.4) kennt navigator.vibrate nicht, löst aber beim
  // Umschalten eines <input switch> einen kurzen Haptik-Tick aus. Dafür liegt
  // ein unsichtbarer Schalter im Dokument, der bei Bedarf per Skript "angetippt"
  // wird. Auf älteren Geräten passiert schlicht nichts.
  try {
    if (!hapticSwitchLabel) {
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      label.appendChild(input);
      document.body.appendChild(label);
      hapticSwitchLabel = label;
    }
    hapticSwitchLabel.click();
  } catch (e) { /* kein Haptik-Ersatz verfügbar */ }
}

const TAG_LONGPRESS_MS = 300; // 0.3 Sekunden gedrückt halten, bevor sich die Pille löst

// Handler pro Tag: X entfernt den Eintrag, Klick auf einen Rezept-Namen
// öffnet das Rezept, Gedrückt-Halten (~1s) löst die Pille zum Verschieben
// (mit haptischem Feedback), danach folgt ein "Geist" (position:fixed-
// Kopie) exakt dem Finger — gleiches robustes Muster wie beim Backlog-Drag,
// das unabhängig vom Flex-Layout der Pillen-Reihe ist und deshalb nicht
// mehr "herumfliegt", wenn sich die Umgebung während des Ziehens verschiebt.
function attachTagHandlers(selectedDiv, weekplan, backlogCtl) {
  for (const removeBtn of selectedDiv.querySelectorAll('.weekplan-tag-remove')) {
    removeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = removeBtn.dataset.entry;
      const dayKey = removeBtn.dataset.day;
      if (!weekplan[dayKey]) return;
      const idx = weekplan[dayKey].indexOf(entry);
      if (idx > -1) {
        weekplan[dayKey].splice(idx, 1);
        saveWeekplan(weekplan);
        weekplanUploadDebounced();
        removeBtn.closest('.weekplan-tag').remove();
      }
    };
  }

  for (const tag of selectedDiv.querySelectorAll('.weekplan-tag')) {
    const textEl = tag.querySelector('.weekplan-tag-text.clickable');
    const entry = tag.dataset.entry;
    if (textEl) {
      textEl.onclick = () => {
        if (tag.dataset.justDragged) { delete tag.dataset.justDragged; return; }
        if (entry && data.recipes.some(r => r.id === entry)) openRecipe(entry);
      };
    }

    // Ziehen (zu anderem Tag oder zurück ins Backlog) — nur möglich, wenn
    // der Eintrag einen Entfernen-Button hat (also nicht in einer
    // vergangenen Woche oder einem ausgeblendeten/"ausgegrauten" Tag steht)
    const dragHandle = tag.querySelector('.weekplan-tag-drag');
    if (!backlogCtl || !dragHandle) continue;

    // #detail ist der scrollende Container (position:fixed + eigenes
    // overflow-y:auto) — das Backlog liegt meist erst weiter unten
    // außerhalb des sichtbaren Bereichs, daher Auto-Scroll wie beim
    // Backlog-Drag.
    const detailEl = selectedDiv.closest('#detail');
    const AUTOSCROLL_MAX_SPEED = 18;
    function autoScrollZoneTag() { return (detailEl?.clientHeight || 0) * 0.25; }
    function maybeAutoScrollTag(y) {
      if (!detailEl) return false;
      const zone = autoScrollZoneTag();
      if (y < zone) { detailEl.scrollBy(0, -AUTOSCROLL_MAX_SPEED * (1 - y / zone)); return true; }
      if (y > detailEl.clientHeight - zone) { detailEl.scrollBy(0, AUTOSCROLL_MAX_SPEED * (1 - (detailEl.clientHeight - y) / zone)); return true; }
      return false;
    }

    let tagDrag = null; // aktiver Ghost-Drag (erst nach Long-Press)
    let pressTimer = null; // Timer bis zur Aktivierung
    let pendingPointerId = null;
    let pendingStartX = 0, pendingStartY = 0;

    function updateDragTargetsTag(x, y) {
      const targetEl = document.elementFromPoint(x, y);
      const overBacklog = !!targetEl?.closest('.backlog-section');
      const overDayEl = targetEl?.closest('.weekplan-day');
      const overDay = overDayEl?.dataset.day || null;

      if (overBacklog !== tagDrag.overBacklog) {
        document.querySelector('.backlog-section')?.classList.toggle('backlog-drop-target', overBacklog);
        tagDrag.overBacklog = overBacklog;
      }
      if (overDay !== tagDrag.overDay) {
        document.querySelector(`.weekplan-day[data-day="${tagDrag.overDay}"]`)?.classList.remove('backlog-drop-target');
        if (overDay && overDay !== tagDrag.fromDay) overDayEl.classList.add('backlog-drop-target');
        tagDrag.overDay = (overDay && overDay !== tagDrag.fromDay) ? overDay : null;
      }
    }

    let tagScrollTimer = null;
    function tagScrollTick() {
      if (!tagDrag) { clearInterval(tagScrollTimer); tagScrollTimer = null; return; }
      if (maybeAutoScrollTag(tagDrag.lastY)) updateDragTargetsTag(tagDrag.lastX, tagDrag.lastY);
    }

    // Aktiviert den eigentlichen Ghost-Drag nach abgeschlossenem Long-Press
    function activateDrag(startX, startY) {
      hapticPulse();
      const rect = tag.getBoundingClientRect();
      const ghost = tag.cloneNode(true);
      ghost.classList.add('weekplan-tag-ghost');
      ghost.style.position = 'fixed';
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      ghost.style.margin = '0';
      ghost.style.pointerEvents = 'none';
      document.body.appendChild(ghost);

      tag.style.opacity = '0';
      tag.style.pointerEvents = 'none';
      tagDrag = {
        ghost, startClientX: startX, startClientY: startY,
        lastX: startX, lastY: startY, overBacklog: false, overDay: null, fromDay: tag.dataset.day,
      };
      lockTouchAction();
      if (!tagScrollTimer) tagScrollTimer = setInterval(tagScrollTick, 16);
    }

    // WICHTIG: .onpointerdown = statt addEventListener() — attachTagHandlers()
    // wird bei jedem neuen Eintrag erneut für ALLE Tags des Tages aufgerufen
    // (nicht nur den neuen), addEventListener würde sich dadurch bei jedem
    // Aufruf zusätzlich aufsummieren und Gesten mehrfach auslösen.
    // Die Handler hängen bewusst NUR am kleinen Ziehgriff links (⠿), nicht
    // an der ganzen Pille: hält man stattdessen auf dem Text gedrückt,
    // interpretieren manche Handys das sonst als "Text markieren"-Geste.
    dragHandle.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingPointerId = e.pointerId;
      pendingStartX = e.clientX;
      pendingStartY = e.clientY;
      try { dragHandle.setPointerCapture(e.pointerId); } catch (err) { /* synthetische Events */ }
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (pendingPointerId === null) return; // Finger schon losgelassen
        activateDrag(pendingStartX, pendingStartY);
      }, TAG_LONGPRESS_MS);
    };

    dragHandle.onpointermove = (e) => {
      if (pendingPointerId !== e.pointerId) return;
      if (!tagDrag) {
        // Noch in der Long-Press-Wartezeit: zu viel Bewegung = kein Zug-Wunsch,
        // sondern Scroll-Versuch o.ä. — Long-Press abbrechen
        const dx = e.clientX - pendingStartX, dy = e.clientY - pendingStartY;
        if (Math.hypot(dx, dy) > 12) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
        return;
      }
      tagDrag.ghost.style.transform = `translate(${e.clientX - tagDrag.startClientX}px, ${e.clientY - tagDrag.startClientY}px)`;
      tagDrag.lastX = e.clientX;
      tagDrag.lastY = e.clientY;
      maybeAutoScrollTag(e.clientY); // sofortige Reaktion bei Fingerbewegung
      updateDragTargetsTag(e.clientX, e.clientY);
    };

    const endTagDrag = (e) => {
      if (pendingPointerId !== null && (!e || e.pointerId === pendingPointerId)) {
        clearTimeout(pressTimer);
        pressTimer = null;
        pendingPointerId = null;
      }
      if (!tagDrag) return;
      const { ghost, overBacklog, overDay } = tagDrag;
      unlockTouchAction();
      ghost.remove();
      tag.style.opacity = '';
      tag.style.pointerEvents = '';
      document.querySelector('.backlog-section')?.classList.remove('backlog-drop-target');
      document.querySelectorAll('.weekplan-day.backlog-drop-target').forEach(d => d.classList.remove('backlog-drop-target'));
      tagDrag = null;
      tag.dataset.justDragged = '1';

      const fromDay = tag.dataset.day;

      // Tag zu anderem Wochentag
      if (overDay && overDay !== fromDay) {
        const idx = (weekplan[fromDay] || []).indexOf(entry);
        if (idx > -1) {
          weekplan[fromDay].splice(idx, 1);
          if (!weekplan[overDay]) weekplan[overDay] = [];
          weekplan[overDay].push(entry);
          saveWeekplan(weekplan);
          weekplanUploadDebounced();
          const displayName = tag.querySelector('.weekplan-tag-text')?.textContent || '';
          tag.remove();
          const targetDayEl = document.querySelector(`.weekplan-day[data-day="${overDay}"]`);
          const targetSelectedDiv = targetDayEl?.querySelector('.weekplan-selected');
          if (targetSelectedDiv && displayName) {
            targetSelectedDiv.insertAdjacentHTML('beforeend', weekplanTagHTML(entry, displayName, overDay));
            attachTagHandlers(targetSelectedDiv, weekplan, backlogCtl);
          }
          toast('📅 In anderen Wochentag verschoben');
        }
      } else if (overBacklog) {
        const idx = (weekplan[fromDay] || []).indexOf(entry);
        if (idx > -1) {
          weekplan[fromDay].splice(idx, 1);
          saveWeekplan(weekplan);
          weekplanUploadDebounced();
          tag.remove();
          // Wochenplan und Backlog speichern Einträge im selben Format (Rezept-ID
          // oder "TEXT:…") — also unverändert zurücklegen. Vorher wurde der
          // Anzeigetext als nacktes Wort übergeben: Rezepte wurden zu Freitext
          // und der Eintrag war bis zum nächsten Neuladen unsichtbar.
          backlogCtl.addItem(entry);
          toast('📝 Zurück ins Backlog verschoben');
        }
      }
    };
    dragHandle.onpointerup = endTagDrag;
    dragHandle.onpointercancel = endTagDrag;
  }
}

// ISO-8601-Wochendaten (Woche beginnt montags; der Donnerstag bestimmt Jahr + KW)
function weekInfo(d = new Date()) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  const week = 1 + Math.round(((date - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return { year: date.getFullYear(), week };
}

function isoKalenderwoche(d = new Date()) { return weekInfo(d).week; }

// Eindeutiger Wochenschlüssel, z. B. "2026-W28"
function weekKey(d = new Date()) {
  const { year, week } = weekInfo(d);
  return year + '-W' + String(week).padStart(2, '0');
}

// Montag der Woche zu einem Datum
function mondayOf(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date;
}

function renderWeekplan(skipSync = false) {
  const el = $('#detail');
  weekplanViewKey = weekKey(weekplanViewDate);
  const weekplan = getWeekplanFor(weekplanViewKey);
  const istAktuelleWoche = weekplanViewKey === weekKey();
  // Vergangene Wochen sind nur zum Ansehen (Wochenschlüssel sind chronologisch vergleichbar)
  const readonly = weekplanViewKey < weekKey();
  const mon = mondayOf(weekplanViewDate);
  const son = new Date(mon); son.setDate(son.getDate() + 6);
  const fmt = d => d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
  const rangeText = `${fmt(mon)} – ${fmt(son)}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [
    { key: 'mo', label: 'Montag' },
    { key: 'di', label: 'Dienstag' },
    { key: 'mi', label: 'Mittwoch' },
    { key: 'do', label: 'Donnerstag' },
    { key: 'fr', label: 'Freitag' },
    { key: 'sa', label: 'Samstag' },
    { key: 'so', label: 'Sonntag' },
  ];

  let daysHTML = '';
  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    const entries = weekplan[day.key] || [];
    const isOff = (weekplan.off || []).includes(day.key);
    // Einzelner Tag schon vorbei (unabhängig davon, ob die ganze Woche
    // vergangen ist) — Rezepte bleiben sichtbar, aber Hinzufügen und der
    // Ausblenden-Knopf ergeben für einen bereits gelaufenen Tag keinen Sinn
    const dayDate = new Date(mon); dayDate.setDate(mon.getDate() + di);
    const isPastDay = dayDate < today;
    const isToday = istAktuelleWoche && dayDate.getTime() === today.getTime();
    const noEdit = readonly || isPastDay;
    let tagsHTML = '';

    // Ausgeblendete Tage zeigen ihre Einträge weiterhin (nur schreibgeschützt,
    // ohne X zum Entfernen) — nur das Eingabefeld entfällt. So bleibt sichtbar,
    // was für den Tag geplant war, ohne dass man es aus Versehen bearbeitet.
    for (const entry of entries) {
      let displayName = '';
      if (entry.startsWith('TEXT:')) {
        displayName = entry.substring(5);
      } else {
        const recipe = data.recipes.find(r => r.id === entry);
        displayName = recipe ? titleWithEmoji(recipe) : '';
      }

      if (displayName) {
        tagsHTML += weekplanTagHTML(entry, displayName, day.key, noEdit || isOff);
      }
    }

    // Reihenfolge: erst die Einträge, darunter das Eingabefeld (entfällt in
    // vergangenen Wochen, bei bereits gelaufenen Einzeltagen UND bei
    // ausgeblendeten Tagen — nur ansehen). Der Umschalt-Knopf selbst bleibt
    // oben rechts an der Karte immer voll sichtbar (eigener Layer, nicht gedimmt).
    daysHTML += `
      <div class="weekplan-day${isOff ? ' day-off' : ''}${isPastDay ? ' past-day' : ''}${isToday ? ' is-today' : ''}" data-day="${day.key}">
        ${noEdit ? '' : `<button class="weekplan-day-toggle" data-day="${day.key}" aria-label="${isOff ? 'Tag wieder einblenden' : 'Tag ausblenden'}">${isOff ? '+' : '−'}</button>`}
        <div class="weekplan-day-inner">
          <label class="weekplan-label">${day.label}${isToday ? '<span class="weekplan-today-mark">Heute</span>' : ''}</label>
          <div class="weekplan-autocomplete" data-day="${day.key}">
            <div class="weekplan-selected">${tagsHTML}</div>
            ${(noEdit || isOff) ? '' : `
            <div class="weekplan-input-row">
              <input type="text" class="weekplan-search" placeholder="Rezept hinzufügen …" autocomplete="off">
              <button class="weekplan-add-btn" title="Freitext hinzufügen">+</button>
            </div>
            <div class="weekplan-suggestions" hidden></div>`}
          </div>
        </div>
      </div>`;
  }

  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="detail-body group-body weekplan-body${readonly ? ' readonly' : ''}">
      <div class="weekplan-header">
        <button class="weekplan-nav" data-dir="-1" aria-label="Woche zurück">‹</button>
        <div class="weekplan-weektitle">
          <div class="weekplan-kw">KW ${isoKalenderwoche(weekplanViewDate)}${istAktuelleWoche ? ' <span class="weekplan-now">jetzt</span>' : ''}</div>
          <div class="weekplan-range">${rangeText}</div>
          ${istAktuelleWoche ? '' : '<button class="weekplan-today-btn">Zur aktuellen Woche</button>'}
        </div>
        <button class="weekplan-nav" data-dir="1" aria-label="Woche vor">›</button>
      </div>
      <div class="weekplan-draghint">⠿ gedrückt halten zum Verschieben</div>
      <div class="weekplan-container">
        ${daysHTML}
      </div>

      <div class="backlog-divider"></div>
      <div class="backlog-section">
        <h3 class="backlog-heading">Rezept-Backlog</h3>
        <div class="backlog-hint">Zum Merken für später — unabhängig von der Woche</div>
        <div class="backlog-autocomplete">
          <div class="backlog-input-row">
            <input type="text" class="backlog-search" placeholder="Rezept oder Notiz hinzufügen" autocomplete="off">
            <button class="backlog-add-btn" title="Freitext-Notiz hinzufügen">+</button>
          </div>
          <div class="backlog-suggestions" hidden></div>
        </div>
        <div class="backlog-list" id="backlog-list">${backlogListHTML(getBacklogItems())}</div>
      </div>
    </div>`;

  el.querySelector('.detail-close').onclick = () => {
    // Wochenplan & Backlog werden automatisch 5s nach der letzten Änderung
    // hochgeladen — beim Verlassen der Ansicht wird ein noch ausstehender
    // Upload sofort erzwungen, statt auf den Timer zu warten.
    flushWeekplanUpload();
    flushBacklogUpload();
    closeOverlay();
  };

  const backlogCtl = wireBacklogList(el, weekplan);

  // Wochen-Navigation: eine Woche zurück/vor, gleiche Ansicht neu zeichnen
  for (const navBtn of el.querySelectorAll('.weekplan-nav')) {
    navBtn.onclick = () => {
      weekplanViewDate = new Date(weekplanViewDate);
      weekplanViewDate.setDate(weekplanViewDate.getDate() + 7 * Number(navBtn.dataset.dir));
      renderWeekplan(true);
    };
  }

  // Zurück zur aktuellen Woche springen (Button erscheint nur, wenn man weg ist)
  const todayBtn = el.querySelector('.weekplan-today-btn');
  if (todayBtn) {
    todayBtn.onclick = () => {
      weekplanViewDate = new Date();
      renderWeekplan(true);
    };
  }

  // Tag ausblenden/einblenden: nur den Toggle-Zustand speichern, Rest bleibt erhalten
  for (const toggleBtn of el.querySelectorAll('.weekplan-day-toggle')) {
    toggleBtn.onclick = () => {
      const dayKey = toggleBtn.dataset.day;
      const off = new Set(weekplan.off || []);
      if (off.has(dayKey)) off.delete(dayKey); else off.add(dayKey);
      weekplan.off = [...off];
      saveWeekplan(weekplan);
      weekplanUploadDebounced();
      renderWeekplan(true);
    };
  }

  // Autocomplete Setup
  for (const dayEl of el.querySelectorAll('.weekplan-autocomplete')) {
    const dayKey = dayEl.dataset.day;
    const selectedDiv = dayEl.querySelector('.weekplan-selected');
    // Tag-Klicks (Rezept öffnen) und X-Entfernen — auch in vergangenen Wochen
    // öffnen Rezept-Klicks das Rezept (nur X/Eingabe entfallen)
    attachTagHandlers(selectedDiv, weekplan, backlogCtl);

    const searchInput = dayEl.querySelector('.weekplan-search');
    if (!searchInput) continue; // Vergangene Woche: kein Eingabefeld
    const addBtn = dayEl.querySelector('.weekplan-add-btn');
    const suggestionsDiv = dayEl.querySelector('.weekplan-suggestions');

    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      if (!query) {
        suggestionsDiv.hidden = true;
        return;
      }

      // Suche Rezepte
      const matches = data.recipes.filter(r => {
        const title = titleWithEmoji(r).toLowerCase();
        const category = Array.isArray(r.category) ? r.category.join(' ').toLowerCase() : (r.category || '').toLowerCase();
        return title.includes(query) || category.includes(query);
      }).slice(0, 8);

      if (matches.length === 0) {
        suggestionsDiv.hidden = true;
        return;
      }

      // Zeige Vorschläge (kein Whitespace/Zeilenumbrüche → keine leere Zeile,
      // emojiFor liefert schon das Emoji, daher nur der reine Titel dahinter)
      suggestionsDiv.innerHTML = matches.map(r =>
        `<div class="weekplan-suggestion" data-id="${esc(r.id)}">${emojiFor(r)} ${esc(r.title)}</div>`
      ).join('');
      suggestionsDiv.hidden = false;

      // Click Handler für Vorschläge
      for (const suggEl of suggestionsDiv.querySelectorAll('.weekplan-suggestion')) {
        suggEl.onclick = () => {
          const recipeId = suggEl.dataset.id;
          const recipe = data.recipes.find(r => r.id === recipeId);

          // Füge zu Array hinzu statt zu ersetzen und speichere sofort
          if (!weekplan[dayKey]) weekplan[dayKey] = [];
          weekplan[dayKey].push(recipeId);
          saveWeekplan(weekplan);
          weekplanUploadDebounced();

          // Update UI: neues Tag hinzufügen
          selectedDiv.insertAdjacentHTML('beforeend', weekplanTagHTML(recipeId, titleWithEmoji(recipe), dayKey));

          searchInput.value = '';
          suggestionsDiv.hidden = true;
          attachTagHandlers(selectedDiv, weekplan, backlogCtl);
        };
      }
    });

    // Add-Button für Freitext
    addBtn.onclick = () => {
      const text = searchInput.value.trim();
      if (!text) return;

      // Füge zu Array hinzu statt zu ersetzen und speichere sofort
      if (!weekplan[dayKey]) weekplan[dayKey] = [];
      const entry = 'TEXT:' + text;
      weekplan[dayKey].push(entry);
      saveWeekplan(weekplan);
      weekplanUploadDebounced();

      // Update UI: neues Tag hinzufügen
      selectedDiv.insertAdjacentHTML('beforeend', weekplanTagHTML(entry, text, dayKey));

      searchInput.value = '';
      suggestionsDiv.hidden = true;
      attachTagHandlers(selectedDiv, weekplan, backlogCtl);
    };

    // Enter-Key für Autocomplete-Auswahl oder Freitext
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!suggestionsDiv.hidden && suggestionsDiv.children.length > 0) {
          suggestionsDiv.children[0].click();
        } else {
          addBtn.click();
        }
      }
    });

    // Rauszoomen nach dem Tippen übernimmt der globale focusout-Handler
  }

  el.hidden = false;
  document.body.style.overflow = 'hidden';

  // Im Hintergrund: neuesten Stand vom anderen Gerät holen und anzeigen.
  // Läuft nur beim Öffnen (nicht bei jedem Wochen-Wechsel-Klick).
  if (!skipSync) {
    syncWeekplanFromRemote().then(changed => {
      // Nur neu rendern wenn der Wochenplan noch offen ist
      if (changed && !el.hidden && el.querySelector('.weekplan-container')) {
        toast('🔄 Wochenplan vom anderen Gerät übernommen');
        renderWeekplan(true);
      }
    });
    // Backlog unabhängig davon abgleichen (nicht an eine Woche gebunden) —
    // nur die Liste aktualisieren, nicht die ganze Ansicht neu zeichnen,
    // und nicht während der Nutzer gerade darin tippt.
    syncBacklogFromRemote().then(changed => {
      const list = el.querySelector('#backlog-list');
      if (changed && list && backlogCtl && !list.contains(document.activeElement)) {
        backlogCtl.refresh();
      }
    });
  }
}

function renderTinder() {
  // Kategorien, die der Nutzer in den Einstellungen für Tinder ausgeschlossen hat
  // (z.B. Saucen/Beilagen, die nicht als eigenständiges Hauptgericht getindert werden sollen)
  const excluded = tinderExcludedCategories();
  const pool = filtered().filter(r => !recipeCategories(r).some(c => excluded.includes(c)));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  tinder = { deck: pool, likes: [] };
  renderTinderCard();
}

function tinderCardHTML(r, cls) {
  return `<div class="t-card ${cls}">
    ${imagesOf(r).length
      ? `<img src="${esc(randomImage(r))}" alt="" draggable="false">`
      : `<div class="t-emoji">${emojiFor(r)}</div>`}
    <div class="t-info">
      <div class="t-title">${titleWithEmoji(r)}</div>
      <div class="t-meta">${esc([categoryLabel(r), displayDuration(r.time)].filter(Boolean).join(' · '))}</div>
    </div>
    <div class="t-card-badge-text like-text"><span>Will ich</span></div>
    <div class="t-card-badge-text nope-text"><span>Nö</span></div>
  </div>`;
}

  function tinderPlaceholderHTML() {
    return `<div class="t-card behind placeholder">
      <div class="t-emoji"></div>
      <div class="t-info">
        <div class="t-title">Noch eine Karte...</div>
        <div class="t-meta">Tippe oder wische, um weiterzumachen</div>
      </div>
    </div>`;
  }

  // Zeigt NICHT das echte nächste Rezept (kein Spoiler beim Wegwischen der
  // oberen Karte) — stattdessen ein großflächiges "Food Match"-Logo als
  // Deckblatt, bis die Karte wirklich an der Reihe ist und mit dem echten
  // Rezept neu gerendert wird.
  function tinderNextPreviewHTML() {
    return `<div class="t-card behind foodmatch">
      <div class="foodmatch-text">
        <div class="foodmatch-title">Food Match</div>
        <div class="foodmatch-sub">Dein nächstes Gericht wartet …</div>
      </div>
    </div>`;
  }

function renderTinderCard() {
  if (tinder.likes.length >= 3 || !tinder.deck.length) {
    return showTinderResult(tinder.likes.map(r => r.id));
  }
  const [top, next] = tinder.deck;
  const el = $('#detail');
  el.innerHTML = `
    <button class="detail-close tinder-close" aria-label="Zurück">←</button>
    <div class="tinder">
      <div class="tinder-status">${tinder.likes.length} von 3 gewählt · noch ${tinder.deck.length} Karten</div>
      <div class="tinder-stack">
        ${next ? tinderNextPreviewHTML() : tinderPlaceholderHTML()}
        ${tinderCardHTML(top, 'top')}
      </div>
      <div class="tinder-buttons">
        <button class="t-nope" aria-label="Nö">${ICON.cross}</button>
        <button class="t-superlike" aria-label="Superlike">${ICON.star}</button>
        <button class="t-like" aria-label="Will ich">${ICON.heart}</button>
      </div>
      <div class="tinder-hint">Wischen oder tippen: links = nö, Mitte = Superlike, rechts = will ich</div>
    </div>`;

  el.querySelector('.detail-close').onclick = () => closeOverlay();
  const card = el.querySelector('.t-card.top');
  // Die Eintritts-Animation (tinderFadeIn) hält transform/opacity per
  // fill-mode "both" fest — das blockiert später per JS gesetzte Inline-
  // Transforms (Ziehen, Wegfliegen) komplett, obwohl die Logik normal
  // durchläuft. Nach Ende der Animation die Klasse setzen, die sie abschaltet.
  card.addEventListener('animationend', () => card.classList.add('entered'), { once: true });
  setTimeout(() => card.classList.add('entered'), 260); // Fallback, z. B. reduced motion
  attachSwipe(card, dir => swipeTinder(dir));
  el.querySelector('.t-nope').onclick = () => flyOut(card, -1);
  el.querySelector('.t-like').onclick = () => flyOut(card, 1);
  el.querySelector('.t-superlike').onclick = () => superlike(top);
  el.hidden = false;
  document.body.style.overflow = 'hidden';
}

function swipeTinder(dir) {
  const r = tinder.deck.shift();
  if (dir > 0) tinder.likes.push(r);
  renderTinderCard();
}

function superlike(recipe) {
  const el = $('#detail');
  const card = el.querySelector('.t-card.top');
  if (!card || card.dataset.flying) return;
  card.dataset.flying = '1';
  const overlay = document.createElement('div');
  overlay.className = 'superlike-overlay';
  overlay.innerHTML = '<div class="superlike-text">Superlike</div>';
  el.appendChild(overlay);

  setTimeout(() => {
    overlay.remove();
    if (!card.isConnected) return; // Food Match inzwischen verlassen
    tinder.deck.shift();
    renderDetail(recipe.id);
    replaceView({ view: 'recipe', id: recipe.id });
  }, 1300);
}

function flyOut(card, dir) {
  // Doppeltes Tippen während des Wegfliegens darf keine Karte überspringen
  if (card.dataset.flying) return;
  card.dataset.flying = '1';
  // Passenden Stempel groß mittig einblenden, dann Karte rausfliegen lassen.
  // Nur das innere <span> dreht/skaliert, die äußere Box bleibt zentriert
  // und fliegt automatisch als Kind der Karte mit deren transform mit.
  const badge = card.querySelector(dir > 0 ? '.like-text' : '.nope-text');
  const badgeInner = badge?.querySelector('span');
  if (badge && badgeInner) {
    badge.style.opacity = 1;
    badgeInner.style.transform = `rotate(${dir > 0 ? -14 : 14}deg) scale(1.15)`;
  }

  // Verzögerte Animation für Karte
  setTimeout(() => {
    card.style.transition = 'transform 0.35s ease-in, opacity 0.35s ease-in';
    card.style.transform = `translate(${dir * 120}vw, -40px) rotate(${dir * 30}deg)`;
    card.style.opacity = '0';
  }, 150); // Stempel kurz zeigen

  setTimeout(() => {
    // Nur weitermachen, wenn die Karte noch da ist (nicht inzwischen verlassen)
    if (card.isConnected) swipeTinder(dir);
  }, 500);
}

function attachSwipe(card, onSwipe) {
  if (!card) return; // Sicherheit: Card existiert nicht
  let startX = 0, startY = 0, dx = 0, dragging = false, done = false;
  // Nur noch die mittige Box — die kleine Ecken-Box wurde entfernt, ihr
  // drag-abhängiges Ein-/Ausblenden läuft jetzt direkt auf der mittigen Box.
  // Rotation/Skalierung passiert NUR auf dem inneren <span>, die äußere Box
  // (badgeLike/badgeNope) behält ihr Zentrierungs-transform aus dem
  // Stylesheet permanent und wird von hier nur noch ein-/ausgeblendet —
  // dadurch kann die Box strukturell nie von der Kartenmitte abdriften.
  const badgeLike = card.querySelector('.t-card-badge-text.like-text');
  const badgeNope = card.querySelector('.t-card-badge-text.nope-text');
  const badgeLikeInner = badgeLike?.querySelector('span');
  const badgeNopeInner = badgeNope?.querySelector('span');
  const img = card.querySelector('img');

  // Fehlerschutz: wenn kritische Elemente nicht existieren, nicht weitermachen
  if (!badgeLike || !badgeNope || !badgeLikeInner || !badgeNopeInner) {
    console.warn('attachSwipe: fehlende kritische Elemente, Swipe deaktiviert');
    return;
  }

  card.style.touchAction = 'none';

  // NUR Pointer Events (deckt Touch/Maus/Stift einheitlich ab). Zusätzlich
  // Touch-Events zu registrieren führte auf echten Touchscreens dazu, dass
  // pointerdown/-move UND touchstart/-move für dieselbe Geste doppelt
  // feuerten — das brach das Wischen (Bug aus einer anderen Bearbeitung).
  const onDown = e => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    card.style.transition = 'none';
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* synthetische Events */ }
  };

  const onMove = e => {
    if (!dragging || done) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy * 0.3}px) rotate(${dx / 12}deg)`;

    const p = Math.min(1, Math.abs(dx) / 100);
    const scale = 0.6 + 0.55 * p;
    // Nur das innere <span> dreht/skaliert — die äußere Box bleibt immer
    // exakt zentriert (ihr transform wird hier nie angefasst)
    if (dx > 0) {
      badgeLike.style.opacity = p;
      badgeLikeInner.style.transform = `rotate(-14deg) scale(${scale})`;
      badgeNope.style.opacity = 0;
    } else {
      badgeNope.style.opacity = p;
      badgeNopeInner.style.transform = `rotate(14deg) scale(${scale})`;
      badgeLike.style.opacity = 0;
    }
    if (img) {
      const fadeStrength = Math.min(0.5, Math.abs(dx) / 200);
      img.style.filter = `brightness(${1 - fadeStrength * 0.7})`;
    }
  };

  const end = () => {
    if (!dragging || done) return;
    dragging = false;
    if (Math.abs(dx) > 90) {
      done = true;
      flyOut(card, dx > 0 ? 1 : -1);
    } else {
      card.style.transition = 'transform 0.25s ease';
      card.style.transform = '';
      badgeLike.style.opacity = 0;
      badgeLikeInner.style.transform = '';
      badgeNope.style.opacity = 0;
      badgeNopeInner.style.transform = '';
      if (img) {
        img.style.filter = 'brightness(1)';
      }
    }
    dx = 0;
  };

  card.addEventListener('pointerdown', onDown);
  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  card.addEventListener('lostpointercapture', end);
}

function showTinderResult(ids) {
  replaceView({ view: 'tinder-result', ids });
  renderTinderResult(ids);
}

function renderTinderResult(ids) {
  const winners = ids.map(id => data.recipes.find(r => r.id === id)).filter(Boolean);
  const el = $('#detail');
  if (!winners.length) {
    el.innerHTML = `
      <button class="detail-close" aria-label="Zurück">←</button>
      <div class="detail-body group-body">
        <h2>Alles weggewischt</h2>
        <div class="detail-meta">Vielleicht ist beim nächsten Mischen was dabei.</div>
        <button class="tinder-again">Nochmal mischen</button>
      </div>`;
    el.querySelector('.detail-close').onclick = () => closeOverlay();
    el.querySelector('.tinder-again').onclick = () => {
      replaceView({ view: 'tinder' });
      renderTinder();
    };
  } else {
    // Erst Fotos zeigen, dann Slot-Machine
    el.innerHTML = `
      <div class="tinder-match-screen" id="match-screen">
        <div class="match-overlay">
          <div class="match-text">It's a Match!</div>
        </div>
        <div class="tinder-photo-preview fullscreen" id="photo-preview">
          ${winners.map((w, i) => `
            <div class="preview-card">
              ${imagesOf(w).length ? `<img src="${esc(randomImage(w))}" alt="">` : `<div class="preview-emoji">${emojiFor(w)}</div>`}
              <div class="preview-title">${titleWithEmoji(w)}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <button class="detail-close" aria-label="Zurück">←</button>
      <button class="detail-home" aria-label="Startseite" style="display:none;">🏠</button>
      <div class="detail-body group-body" style="display:none;">
        <h2>Jetzt gilt's!</h2>
        <div class="detail-meta">Was kochen wir heute?</div>

        <div class="slot-machine" id="slot-container" style="display:none;">
          <div class="slot-window">
            <div class="slot-reel" id="slot-reel"></div>
          </div>
        </div>

        <div class="slot-buttons">
          <button class="slot-spin" id="slot-btn" style="display:none;">Loschen!</button>
          <button class="slot-share" id="slot-share-btn" style="display:none;">Als Nachricht teilen</button>
          <button class="tinder-again" style="display:none;">Nochmal mischen</button>
        </div>
      </div>`;

    el.querySelector('.detail-close').onclick = () => closeOverlay();
    el.querySelector('.detail-home').onclick = () => goHome();

    // Nach 2.5 Sekunden: Match-Screen ausblenden, Slot-Machine einblenden
    setTimeout(() => {
      const matchScreen = el.querySelector('#match-screen');
      const body = el.querySelector('.detail-body');
      const machine = el.querySelector('#slot-container');
      const btn = el.querySelector('#slot-btn');
      const again = el.querySelector('.tinder-again');
      const closeBtn = el.querySelector('.detail-close');
      const homeBtn = el.querySelector('.detail-home');

      matchScreen.style.display = 'none';
      body.style.display = 'block';
      machine.style.display = 'block';
      btn.style.display = 'block';
      again.style.display = 'block';
      closeBtn.style.display = 'none';
      homeBtn.style.display = 'block';

      // Auto-spin starten
      spinSlot(winners);

      btn.onclick = () => spinSlot(winners);
      again.onclick = () => spinSlot(winners); // Nur Slot-Machine neu, kein Retindern
    }, 2500);
  }
  el.hidden = false;
  document.body.style.overflow = 'hidden';
}

// Höhe einer Slot-Zelle — muss mit CSS (.slot-window/.slot-cell height) übereinstimmen
const SLOT_CELL_H = 110;

function finishSpin(winners, pick, btn) {
  const w = winners[pick];
  btn.textContent = w.title + (w.emoji ? ' ' + w.emoji : '');
  btn.disabled = false;
  btn.onclick = () => {
    rememberScroll();
    renderDetail(w.id);
    $('#detail').scrollTop = 0;
    pushView({ view: 'tinder-result-recipe', ids: winners.map(x => x.id), winnerIndex: pick });
  };

  const shareBtn = $('#slot-share-btn');
  if (shareBtn) {
    shareBtn.style.display = 'block';
    shareBtn.onclick = () => shareRecipeAsText(w);
  }
}

// Teilt das Ergebnis als kurze Textnachricht (z.B. WhatsApp) statt als Bild
async function shareRecipeAsText(r) {
  const text = `Et jibt… ${r.title}${r.emoji ? ' ' + r.emoji : ''} 🍽️`;
  if (navigator.share) {
    try { await navigator.share({ text }); return; }
    catch (e) { return; /* Nutzer hat den Teilen-Dialog abgebrochen */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('📋 In Zwischenablage kopiert');
  } catch (e) {
    toast('❌ Teilen nicht möglich');
  }
}

// Vertikale Slot-Walze: läuft mehrere Runden durch und stoppt weich exakt
// auf dem gewählten Gewinner (immer sichtbar im Fenster, nie leer).
function spinSlot(winners) {
  const btn = $('#slot-btn');
  const reel = $('#slot-reel');
  if (!btn || !reel) return;
  btn.disabled = true;
  btn.textContent = '⏳ …';

  const pick = Math.floor(Math.random() * winners.length);
  const cell = w => `<div class="slot-cell">${titleWithEmoji(w)}</div>`;

  // Einzelner Gewinner: direkt anzeigen, keine Walzen-Fahrt
  if (winners.length === 1) {
    reel.style.transition = 'none';
    reel.style.transform = 'translateY(0)';
    reel.innerHTML = `<div class="slot-cell winner">${titleWithEmoji(winners[0])}</div>`;
    finishSpin(winners, 0, btn);
    return;
  }

  // Walze bauen: mehrere volle Durchläufe, dann bis zum Gewinner
  const loops = 6;
  const cells = [];
  for (let l = 0; l < loops; l++) for (const w of winners) cells.push(w);
  for (let i = 0; i <= pick; i++) cells.push(winners[i]);
  const targetIndex = loops * winners.length + pick;

  reel.innerHTML = cells.map(cell).join('');
  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0)';
  void reel.offsetHeight; // erzwungener Reflow: Reset wird registriert (ohne rAF)
  reel.style.transition = 'transform 2.8s cubic-bezier(0.12, 0.72, 0.15, 1)';
  reel.style.transform = `translateY(-${targetIndex * SLOT_CELL_H}px)`;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    reel.removeEventListener('transitionend', finish);
    const target = reel.children[targetIndex];
    if (target) target.classList.add('winner');
    finishSpin(winners, pick, btn);
  };
  reel.addEventListener('transitionend', finish);
  setTimeout(finish, 3100); // Fallback, falls transitionend nicht feuert
}

/* ---------- Toast ---------- */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  // Führende Emojis weglassen — die Bedienung kommt ohne Emoji-Schmuck aus
  t.textContent = String(msg).replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function showToastWithoutTimeout(msg) {
  const t = $('#toast');
  // Führende Emojis weglassen — die Bedienung kommt ohne Emoji-Schmuck aus
  t.textContent = String(msg).replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '');
  t.hidden = false;
  clearTimeout(toastTimer);
}

/* ---------- Start ---------- */

/* ---------- Einstellungen ---------- */

const LAST_UPDATE_KEY = 'rezeptbuch-last-update';
const THEME_KEY = 'rezeptbuch-theme';
const COLOR_KEY = 'rezeptbuch-colorscheme';
const EDIT_ENABLED_KEY = 'rezeptbuch-edit-enabled';
const TINDER_EXCLUDED_KEY = 'rezeptbuch-tinder-excluded-cats';

function tinderExcludedCategories() {
  try { return JSON.parse(localStorage.getItem(TINDER_EXCLUDED_KEY) || '[]'); }
  catch { return []; }
}

function isEditModeEnabled() {
  // Offline-Modus überlagert den Bearbeitungsmodus, ohne die gemerkte
  // Einstellung zu ändern — beim Ausschalten ist alles wie vorher
  if (localStorage.getItem(OFFLINE_MODE_KEY) === 'true') return false;
  return ghToken && ghToken() && localStorage.getItem(EDIT_ENABLED_KEY) !== 'false';
}

function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove('theme-light', 'theme-dark', 'theme-auto');
  if (theme === 'light') html.classList.add('theme-light');
  else if (theme === 'dark') html.classList.add('theme-dark');
  else html.classList.add('theme-auto');
  localStorage.setItem(THEME_KEY, theme);
  syncThemeColor();
}

// Statusleisten-/Browserfarbe folgt dem Seitenhintergrund (--bg) des gerade
// wirksamen Themes — auch wenn das Gerät hell ist, die App aber auf "Dunkel" steht.
function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (!bg) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    m.removeAttribute('media');
    m.setAttribute('content', bg);
  });
}
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeColor);

// Farbschema (unabhängig von Hell/Dunkel): 'orange' (Standard) | 'blue' | 'rainbow'
function applyColorScheme(scheme) {
  const html = document.documentElement;
  html.classList.remove('color-orange', 'color-blue', 'color-rainbow');
  html.classList.add('color-' + scheme);
  localStorage.setItem(COLOR_KEY, scheme);
  syncThemeColor();
}

// Theme + Farbschema beim Start laden
(() => {
  applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
  applyColorScheme(localStorage.getItem(COLOR_KEY) || 'orange');
})();

function openSettings() {
  enterOverlay('settings');
  const hasToken = ghToken && ghToken();
  const lastUpdate = localStorage.getItem(LAST_UPDATE_KEY) || '—';
  const offline = localStorage.getItem(OFFLINE_MODE_KEY) === 'true';
  // Gemerkte Einstellung bleibt unangetastet — offline wird sie nur überlagert
  const editEnabled = localStorage.getItem(EDIT_ENABLED_KEY) !== 'false' && hasToken;
  const currentTheme = localStorage.getItem(THEME_KEY) || 'auto';
  const currentColor = localStorage.getItem(COLOR_KEY) || 'orange';

  // Bausteine: Auswahl-Leiste, Schalter-Zeile und antippbare Zeile
  const segment = (name, current, options) => `<div class="set-segment">${options.map(([value, label]) => `
    <label><input type="radio" name="${name}" value="${value}" ${current === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>`;
  const toggle = (id, title, hint, checked, disabled = false) => `<label class="set-row">
    <span class="set-text"><span class="set-title">${title}</span><span class="set-hint">${hint}</span></span>
    <span class="toggle-slider"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}${disabled ? ' disabled' : ''}><span class="slider"></span></span>
  </label>`;
  const link = (id, title, hint = '', cls = 'nav') => `<button type="button" class="set-row ${cls}" id="${id}">
    <span class="set-text"><span class="set-title">${title}</span>${hint ? `<span class="set-hint">${hint}</span>` : ''}</span>
  </button>`;
  const group = (title, rows, attrs = '') => `<section class="set-group"${attrs}><h3>${title}</h3><div class="set-card">${rows}</div></section>`;

  const el = $('#editor'); // Reuse editor div für Modal
  el.innerHTML = `
  <button class="detail-close" aria-label="Zurück">←</button>
  <div class="ed-body settings-body">
    <h2>Einstellungen</h2>

    ${group('Anzeige', `
      <div class="set-block">
        <span class="set-title">Erscheinungsbild</span>
        ${segment('theme', currentTheme, [
          ['light', 'Annika<small>Hell</small>'],
          ['dark', 'Lars<small>Dunkel</small>'],
          ['auto', 'System<small>Automatisch</small>']])}
      </div>
      <div class="set-block">
        <span class="set-title">Farbschema</span>
        ${segment('colorscheme', currentColor, [
          ['orange', '<i class="swatch swatch-orange"></i>Orange'],
          ['blue', '<i class="swatch swatch-blue"></i>Blau'],
          ['rainbow', '<i class="swatch swatch-rainbow"></i>Rainbow']])}
      </div>`)}

    ${group('App', `
      <label class="set-block">
        <span class="set-title">Beim Öffnen anzeigen</span>
        <span class="set-select-wrap"><select id="start-select" class="set-select">${Object.entries(START_OPTIONS).map(([value, label]) =>
          `<option value="${value}" ${startPage() === value ? 'selected' : ''}>${label}</option>`).join('')}</select></span>
      </label>
      ${toggle('vibration-toggle', 'Vibration beim Ziehen', 'Kurzes Feedback, wenn sich eine Kachel löst. Am iPhone ab iOS 17.4.', vibrationEnabled())}
      ${toggle('offline-toggle', 'Offline-Modus', 'Keine Abgleiche mit dem Server, nur Lesen möglich', offline)}
      ${link('refresh-btn', 'Nach Updates suchen', 'Rezepte und App-Funktionen', 'action')}
      <div class="update-status"></div>`)}

    ${group('Bibliothek', `
      ${hasToken && !offline
        ? link('lib-recipes-btn', 'Rezepte verwalten', 'Mehrere auf einmal löschen')
          + link('lib-cats-btn', 'Kategorien verwalten', 'Umbenennen, zusammenführen, entfernen')
        : `<div class="set-block"><span class="set-hint">Rezepte und Kategorien verwalten: ${offline ? 'im Offline-Modus nicht möglich' : 'braucht einen Token (siehe Zugang)'}</span></div>`}
      ${link('tinder-cats-btn', 'Food Match', 'Kategorien vom Tindern ausschließen')}`)}

    ${group('Zugang', hasToken
        ? toggle('edit-toggle', 'Bearbeitungsmodus', offline
              ? 'Im Offline-Modus deaktiviert, wird danach wiederhergestellt'
              : 'Rezepte hinzufügen und ändern', editEnabled && !offline, offline)
          + link('share-token', 'Token teilen')
          + link('clear-token', 'Token entfernen', '', 'danger')
        : link('setup-token', 'Token einrichten', 'Nötig zum Bearbeiten und Synchronisieren'),
      offline ? ' style="opacity: 0.4; pointer-events: none;"' : '')}

    <div class="set-footer">${data.recipes.length} Rezepte<br>Zuletzt aktualisiert: ${lastUpdate}</div>
  </div>`;

  el.querySelector('.detail-close').onclick = () => closeOverlay();

  el.querySelector('#lib-recipes-btn')?.addEventListener('click', () => openLibraryRecipes());
  el.querySelector('#lib-cats-btn')?.addEventListener('click', () => openLibraryCategories());

  el.querySelector('#tinder-cats-btn').onclick = () => openTinderCategoryFilter();

  const editToggle = el.querySelector('#edit-toggle');
  if (editToggle) {
    editToggle.onchange = () => {
      localStorage.setItem(EDIT_ENABLED_KEY, editToggle.checked ? 'true' : 'false');
      render();
    };
  }

  el.querySelector('#start-select').onchange = (ev) => localStorage.setItem(START_KEY, ev.target.value);

  const vibrationToggle = el.querySelector('#vibration-toggle');
  if (vibrationToggle) {
    vibrationToggle.onchange = () => {
      localStorage.setItem(VIBRATION_KEY, vibrationToggle.checked ? 'true' : 'false');
      if (vibrationToggle.checked) hapticPulse(); // kurzes Feedback als Bestätigung
    };
  }

  const offlineToggle = el.querySelector('#offline-toggle');
  if (offlineToggle) {
    offlineToggle.onchange = () => {
      localStorage.setItem(OFFLINE_MODE_KEY, offlineToggle.checked ? 'true' : 'false');
      const message = offlineToggle.checked
        ? '🔒 Offline-Modus aktiviert (keine Online-Abgleiche)'
        : '🌐 Online-Modus aktiviert (Auto-Abgleiche aktiv)';
      toast(message);
      // Bearbeiten-Bereich ausgrauen bzw. wiederherstellen und Grid auffrischen
      openSettings();
      render();
    };
  }

  el.querySelector('#clear-token')?.addEventListener('click', () => {
    if (window.clearToken && confirm('⚠️ Token wirklich entfernen? Dann kann die App keine Daten mehr synchronisieren.')) {
      window.clearToken();
      openSettings();
    }
  });

  el.querySelector('#share-token')?.addEventListener('click', () => {
    const token = ghToken();
    if (!token) {
      toast('❌ Kein Token vorhanden');
      return;
    }

    // Modal mit Token
    const modal = document.createElement('div');
    modal.className = 'token-share-modal';
    modal.innerHTML = `
      <div class="token-share-content">
        <button class="token-share-close">✕</button>
        <h3>Token für deine Freundin</h3>
        <p>Teile diesen Token mit deiner Freundin:</p>
        <input type="text" readonly value="${esc(token)}" class="token-share-input">
        <button class="token-share-copy">In Zwischenablage kopieren</button>
        <p class="token-share-hint">Deine Freundin kann den Token dann in den Einstellungen unter "Token einrichten" einfügen</p>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.token-share-close').onclick = () => modal.remove();
    modal.querySelector('.token-share-copy').onclick = () => {
      const input = modal.querySelector('.token-share-input');
      input.select();
      document.execCommand('copy');
      toast('✅ Token kopiert!');
    };

    // Modal schließen bei Klick außen
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  });

  el.querySelector('#setup-token')?.addEventListener('click', () => openTokenSetup());

  el.querySelector('#refresh-btn').onclick = async () => {
    showToastWithoutTimeout('🔄 Überprüfe Updates...');
    try {
      // 1. DATEN-CHECK: Rezept-ISO-Timestamp vergleichen und ggf. direkt übernehmen
      // (meldet selbst, wie viele Rezepte aktualisiert wurden)
      const hasUpdates = await checkAndUpdateIfNeeded();

      // 2. FUNKTIONALITÄTEN-CHECK: App-Build-ISO-Timestamp der Server-Version vergleichen
      const hasAppUpdate = await checkAppUpdateAvailable();

      if (hasAppUpdate) {
        showAppUpdateDialog();
      } else if (!hasUpdates || $('#toast').textContent.startsWith('Überprüfe')) {
        toast('✅ Alles aktuell – Rezepte und App-Funktionen');
      }
    } catch (err) {
      console.error('Update-Fehler:', err);
      toast('❌ Fehler: ' + err.message);
    }
  };

  // Theme-Switcher
  for (const radio of el.querySelectorAll('input[name="theme"]')) {
    radio.onchange = () => applyTheme(radio.value);
  }

  // Farbschema-Switcher
  for (const radio of el.querySelectorAll('input[name="colorscheme"]')) {
    radio.onchange = () => { applyColorScheme(radio.value); render(); };
  }

  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';

  // Auto-Check für Updates beim Öffnen der Settings
  (async () => {
    try {
      const fresh = await fetchRemoteRecipes();
      if (fresh) {
        // Prüfe ob Rezept-Daten unterscheiden sich (ISO-Parse für robuste Vergleiche)
        const oldDate = new Date(data.updated).getTime();
        const freshDate = new Date(fresh.updated).getTime();
        if (freshDate !== oldDate) {
          const statusEl = el.querySelector('.update-status');
          if (statusEl) {
            statusEl.innerHTML = `<div style="color: var(--accent); font-weight: 600; margin-top: 8px;">Update verfügbar</div>`;
          }
        }
      }
    } catch (e) {
      console.log('Update-Check fehlgeschlagen');
    }
  })();
}

// Auswahl, welche Kategorien beim Rezept-Tinder ausgeschlossen werden sollen
// (z.B. Saucen/Beilagen, die kein eigenständiges Hauptgericht sind)
function openTinderCategoryFilter() {
  const allCats = [...new Set(data.recipes.flatMap(recipeCategories))].sort((a, b) => a.localeCompare(b, 'de'));
  const excluded = new Set(tinderExcludedCategories());

  const modal = document.createElement('div');
  modal.className = 'ed-modal-overlay';
  modal.innerHTML = `<div class="ed-modal">
    <h3>Kategorien für Tinder</h3>
    <div class="setting-hint" style="margin-bottom: 10px;">Häkchen = wird beim Tindern gezeigt. Ausschalten für Saucen, Beilagen o.ä., die kein eigenes Hauptgericht sind.</div>
    <div class="ed-cat-list">
      ${allCats.map(cat => `<label class="ed-cat-option">
        <input type="checkbox" data-cat="${esc(cat)}" ${excluded.has(cat) ? '' : 'checked'}>
        ${esc(cat)}
      </label>`).join('')}
    </div>
    <div class="ed-modal-buttons">
      <button type="button" class="ed-modal-cancel">Abbrechen</button>
      <button type="button" class="ed-modal-ok">Speichern</button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  modal.querySelector('.ed-modal-cancel').onclick = () => modal.remove();
  modal.querySelector('.ed-modal-ok').onclick = () => {
    const newExcluded = [];
    for (const input of modal.querySelectorAll('input[type="checkbox"]')) {
      if (!input.checked) newExcluded.push(input.dataset.cat);
    }
    localStorage.setItem(TINDER_EXCLUDED_KEY, JSON.stringify(newExcluded));
    modal.remove();
    toast('✓ Gespeichert');
  };
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

$('#btn-settings').onclick = openSettings;

$('#btn-weekplan').onclick = () => {
  openWeekplan();
};

$('#btn-tinder').onclick = () => {
  if (filtered().length < 2) return toast('Zu wenige Rezepte zum Tindern 🤷');
  openTinder();
};

$('#search').addEventListener('input', e => {
  query = e.target.value;
  $('#search-clear').hidden = !query;
  render();
});

$('#search-clear').onclick = () => {
  $('#search').value = '';
  query = '';
  $('#search-clear').hidden = true;
  render();
  // Bewusst KEIN .focus() hier — sonst springt die Tastatur ungewollt wieder auf
};

/* ---------- Bereichs-Umschalter (Frühstück / Kochen / Backen) ---------- */

function renderModeUI() {
  $('#mode-btn').textContent = MODES[mode].label;
  $('.topbar').classList.toggle('long-mode', mode === 'fruehstueck');
  const menu = $('#mode-menu');
  menu.innerHTML = '';
  for (const [key, m] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.className = key === mode ? 'active' : '';
    b.textContent = m.label;
    b.onclick = () => {
      mode = key;
      localStorage.setItem(MODE_KEY, mode);
      activeCategory = 'Alle';
      menu.hidden = true;
      renderModeUI();
      render();
    };
    menu.appendChild(b);
  }
}

$('#mode-btn').onclick = e => {
  e.stopPropagation();
  const menu = $('#mode-menu');
  menu.hidden = !menu.hidden;
};

// Tipp irgendwo anders hin schließt das Menü
document.addEventListener('click', e => {
  if (!e.target.closest('#mode-menu') && !e.target.closest('#mode-btn')) {
    $('#mode-menu').hidden = true;
  }
});

// Sortier-Button: Menü mit Alphabet / Zubereitungszeit / Zuletzt hinzugefügt
const SORT_OPTIONS = [
  ['alpha', 'Alphabetisch'],
  ['time', 'Zubereitungszeit'],
  ['recent', 'Zuletzt hinzugefügt'],
];

$('#sort-btn').onclick = e => {
  e.stopPropagation();
  const menu = $('#sort-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = SORT_OPTIONS.map(([v, l]) =>
    `<button class="sort-opt${v === sortMode ? ' active' : ''}" data-sort="${v}">${l}</button>`).join('');
  menu.hidden = false;
  for (const b of menu.querySelectorAll('.sort-opt')) {
    b.onclick = () => {
      sortMode = b.dataset.sort;
      localStorage.setItem(SORT_KEY, sortMode);
      menu.hidden = true;
      render();
    };
  }
};

document.addEventListener('click', e => {
  if (!e.target.closest('#sort-menu') && !e.target.closest('#sort-btn')) {
    $('#sort-menu').hidden = true;
  }
});

/* ---------- App-Update (Funktionalitäten) ---------- */

// Führt das App-Update durch: Caches leeren, Service Worker neu, frisch laden.
// Wird NUR auf Nutzer-Wunsch ausgelöst (Dialog oder Update-Knopf) — nie automatisch.
async function performAppUpdate() {
  showToastWithoutTimeout('🔄 Update wird geladen …');
  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (e) { console.log('Update-Aufräumen fehlgeschlagen:', e); }
  window.location.href = window.location.pathname + '?force=' + Date.now();
}

// Dialog: neue App-Funktionen verfügbar → jetzt updaten oder später (ignorieren)
function showAppUpdateDialog() {
  // Ein stehender Hinweis ("Überprüfe Updates …") darf den Dialog nicht verdecken
  $('#toast').hidden = true;
  if (document.querySelector('.app-update-dialog')) return; // nicht doppelt zeigen
  const dialog = document.createElement('div');
  dialog.className = 'app-update-dialog';
  dialog.innerHTML = `
    <h3>App-Update verfügbar</h3>
    <p>Neue Funktionen sind bereit.</p>
    <div class="app-update-buttons">
      <button class="app-update-now">Jetzt updaten</button>
      <button class="app-update-later">Später</button>
    </div>`;
  document.body.appendChild(dialog);
  dialog.querySelector('.app-update-now').onclick = () => { dialog.remove(); performAppUpdate(); };
  dialog.querySelector('.app-update-later').onclick = () => dialog.remove();
}

// Prüft per ISO-Vergleich, ob auf dem Server neuere App-Funktionen liegen
async function checkAppUpdateAvailable() {
  const remoteBuild = await fetchRemoteBuildTime();
  return !!remoteBuild && new Date(remoteBuild).getTime() > new Date(APP_BUILD_TIME).getTime();
}

// Beim Runterscrollen: Wochenplan/Food Match flach, Suche + Kategorien weg.
// Beim Hochscrollen kommt alles zurück
(() => {
  const header = document.querySelector('header');
  const inner = document.querySelector('.header-extra-clip > .header-extra-inner');
  if (!inner) return; // alte index.html aus dem Zwischenspeicher
  new ResizeObserver(() => header.style.setProperty('--extra-h', inner.offsetHeight + 'px'))
    .observe(inner);

  const STEP = 14; // so weit muss man in eine Richtung scrollen
  let anchor = window.scrollY;
  const show = visible => {
    if (header.classList.contains('extra-hidden') !== visible) return;
    header.classList.toggle('extra-hidden', !visible);
    if (!visible) $('#sort-menu').hidden = true;
  };
  window.addEventListener('scroll', () => {
    // iPhone federt über die Seitenränder hinaus: solche Werte begrenzen
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const y = Math.max(0, Math.min(window.scrollY, max));
    const hidden = header.classList.contains('extra-hidden');
    // Ganz oben und während des Tippens bleibt alles sichtbar
    if (y < 60 || document.activeElement === $('#search')) { anchor = y; return show(true); }
    // Anker folgt der aktuellen Richtung; erst eine Gegenbewegung zählt
    if (hidden ? y > anchor : y < anchor) { anchor = y; return; }
    if (Math.abs(y - anchor) >= STEP) { anchor = y; show(hidden); }
  }, { passive: true });
  $('#search').addEventListener('focus', () => show(true));
})();

/* ---------- App-Start ---------- */

// Lokale Daten sofort anzeigen — kein automatischer Reload mehr
renderModeUI();
loadLocal();
render();

// Rezepte: leichter ISO-Abgleich im Hintergrund (übernimmt Änderungen still)
checkAndUpdateIfNeeded();

// App-Funktionen: gibt es Neues auf dem Server → Dialog (updaten oder später)
checkAppUpdateAvailable().then(available => {
  if (available) showAppUpdateDialog();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js?t=' + Date.now()).catch(e => console.log('SW register error:', e));
}

// App kommt in den Vordergrund (Handy entsperrt, Tab gewechselt):
// sofort per ISO-Timestamp prüfen, ob das andere Gerät etwas geändert hat.
// Echte Push-Benachrichtigungen (auch mit geschlossener App) sind auf dem
// iPhone für diese Art App nicht möglich: iOS unterstützt für Web-Apps kein
// Hintergrund-Abrufen in festen Abständen (Periodic Background Sync gibt es
// in Safari nicht), und echte Web-Push bräuchte zusätzlich einen eigenen
// Server, der bei jeder Änderung aktiv eine Nachricht verschickt — das reine
// Hosting auf GitHub Pages reicht dafür nicht. Stattdessen: sobald die App im
// Vordergrund ist, wird sofort geprüft und bei Änderung ein Hinweis-Punkt am
// 📅-Knopf gezeigt, falls der Wochenplan gerade nicht offen ist.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkAndUpdateIfNeeded();
  syncWeekplanFromRemote().then(changed => {
    if (!changed) return;
    const detail = $('#detail');
    if (!detail.hidden && detail.querySelector('.weekplan-container')) {
      toast('🔄 Wochenplan vom anderen Gerät übernommen');
      renderWeekplan(true);
    } else {
      showWeekplanUpdateDot();
    }
  });
});

// Kleiner roter Punkt am Wochenplan-Knopf: zeigt "es gibt was Neues", ohne
// dass man den Plan schon geöffnet hat. Verschwindet beim Öffnen.
function showWeekplanUpdateDot() {
  $('#btn-weekplan').classList.add('has-update-dot');
}
function clearWeekplanUpdateDot() {
  $('#btn-weekplan').classList.remove('has-update-dot');
}

// Zoomen beim Tippen in Textfelder ist jetzt dauerhaft über den Viewport-Meta-Tag
// gesperrt (maximum-scale=1, user-scalable=no in index.html) — kein
// nachträgliches Zurücksetzen mehr nötig.

// Wisch-Gesten vom linken Rand nach rechts:
//  - in einer Ansicht (#detail/#editor): zurück, die Seite folgt dem Finger
//    über die ganze Breite, darunter erscheint die vorherige Seite
//  - auf der Rezeptübersicht: Einstellungen öffnen ("nach vorne")
//
// Wischen oder Scrollen? Erst nach SWIPE_SLOP px wird entschieden: nur eine
// klar waagerechte Bewegung nach rechts (|dx| > 1,5·|dy|, ca. 34°) ist ein
// Wisch, alles andere bleibt Scrollen. Touch-Ereignisse statt Pointer-Events,
// weil iOS Pointer-Events abbricht, sobald es selbst scrollen möchte; ein
// preventDefault() auf touchmove hält die Geste bei uns.
const SWIPE_SLOP = 10;        // px bis zur Entscheidung
const SWIPE_RATIO = 1.5;      // so viel waagerechter als senkrecht
const SWIPE_FLING = 0.4;      // px/ms: schneller Wisch reicht auch bei kurzem Weg
const SWIPE_DISTANCE = 0.4;   // Anteil der Breite, ab dem langsames Wischen zählt
const swipeEdge = () => Math.max(48, window.innerWidth * 0.16);

let swipe = null;    // laufende Berührung
let swipeAnim = null; // laufende Abschluss-/Zurückfeder-Animation

// Das oberste Fenster zählt: Editor/Einstellungen liegen ÜBER der Rezeptansicht
const swipeTarget = () => $('#editor').hidden ? $('#detail') : $('#editor');

// Alle Spuren der Geste entfernen (nach Abschluss, Abbruch oder Seitenwechsel)
function resetSwipe() {
  if (swipeAnim) { clearTimeout(swipeAnim); swipeAnim = null; }
  for (const el of [$('#detail'), $('#editor')]) {
    el.classList.remove('swiping');
    el.style.transform = '';
    el.style.transition = '';
    el.style.removeProperty('--swipe-scroll');
  }
  document.querySelectorAll('.nav-underlay').forEach(n => n.remove());
  swipe = null;
}

// Liegt unter dem Start ein Element, das selbst noch nach links zurückscrollen
// kann (z. B. Fotogalerie ab Bild 2, Kategorien-Leiste), gehört die Geste ihm
function scrollableToLeft(el) {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollLeft > 2 && el.scrollWidth > el.clientWidth
        && !['detail', 'editor'].includes(el.id)) return true;
  }
  return false;
}

function swipeStart(x, y, time, el) {
  if (swipeAnim) return;
  if (swipe) resetSwipe();
  if (x > swipeEdge()) return;
  // Eigene Zieh-/Wisch-Elemente haben Vorrang
  if (el.closest?.('input, textarea, select, .backlog-drag, .weekplan-tag-drag, .tinder, .lib-bar, .ed-modal-overlay, .lightbox')) return;
  if (scrollableToLeft(el)) return;
  const mode = ($('#detail').hidden && $('#editor').hidden) ? 'settings' : 'back';
  swipe = { x, y, mode, target: null, under: null, samples: [{ x, t: time }] };
}

// Gibt true zurück, wenn die Geste uns gehört (dann nicht scrollen lassen)
function swipeMove(x, y, time) {
  if (!swipe) return false;
  const dx = x - swipe.x;
  const dy = y - swipe.y;
  swipe.samples.push({ x, t: time });
  if (swipe.samples.length > 12) swipe.samples.shift();

  if (!swipe.target) {
    const horizontal = dx > Math.abs(dy) * SWIPE_RATIO;
    if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) {
      return horizontal && dx > 4; // klare Tendenz: Browser noch nicht scrollen lassen
    }
    if (!horizontal) { swipe = null; return false; } // Scrollen oder nach links
    if (swipe.mode === 'settings') {
      if (dx > 70) { swipe = null; openSettings(); }
      return true;
    }
    if (!beginBackSwipe()) { swipe = null; return false; }
  }
  drawSwipe(Math.max(0, Math.min(dx, window.innerWidth)));
  return true;
}

function beginBackSwipe() {
  const target = swipeTarget();
  const closeBtn = target.querySelector('.detail-close');
  // Nur wenn ein sichtbarer Zurück-Knopf da ist (nicht beim Food Match)
  if (!closeBtn || getComputedStyle(closeBtn).display === 'none' || closeBtn.classList.contains('tinder-close')) return false;
  swipe.target = target;
  target.style.setProperty('--swipe-scroll', target.scrollTop + 'px');
  target.classList.add('swiping');
  // Vorherige Seite darunterlegen. Übersicht bzw. Rezept unter dem Editor sind
  // ohnehin noch da; sonst das gemerkte Abbild der vorherigen Seite
  const prev = underlays[navDepth() - 1];
  const isEditor = target.id === 'editor';
  if (prev && prev.isEditor === isEditor && navDepth() >= 2) {
    const under = prev.node.cloneNode(true);
    under.classList.add(isEditor ? 'under-editor' : 'under-detail');
    under.style.setProperty('--swipe-scroll', prev.scroll + 'px');
    document.body.appendChild(under);
    under.scrollTop = prev.scroll;
    swipe.under = under;
  }
  return true;
}

function drawSwipe(dx) {
  swipe.dx = dx;
  swipe.target.style.transform = `translateX(${dx}px)`;
  if (swipe.under) {
    const rest = 1 - dx / window.innerWidth;
    swipe.under.style.transform = `translateX(${-28 * rest}%)`;
  }
}

function swipeEnd(x, time) {
  if (!swipe) return;
  if (!swipe.target) { swipe = null; return; }
  const width = window.innerWidth;
  const dx = Math.max(0, Math.min(x - swipe.x, width));
  swipe.samples.push({ x, t: time });
  // Geschwindigkeit aus den letzten 100 ms (wer vor dem Loslassen verharrt, hat ~0)
  const recent = swipe.samples.filter(p => time - p.t <= 100);
  const first = recent[0];
  const v = recent.length > 1 && time > first.t ? (x - first.x) / (time - first.t) : 0;
  const commit = (v > SWIPE_FLING && dx > 24) || (dx > width * SWIPE_DISTANCE && v > -0.15);
  finishSwipe(commit, dx, v);
}

// Restweg flüssig zu Ende animieren: vorwärts zur vorherigen Seite oder zurück
function finishSwipe(commit, dx, v) {
  const { target, under } = swipe;
  const width = window.innerWidth;
  const rest = commit ? width - dx : dx;
  const duration = Math.round(Math.max(140, Math.min(300, rest / Math.max(Math.abs(v), 1.1))));
  const ease = `transform ${duration}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
  target.classList.remove('swiping');
  target.classList.add('swipe-settling');
  target.style.transition = ease;
  target.style.transform = commit ? `translateX(${width}px)` : 'translateX(0px)';
  if (under) {
    under.style.transition = ease;
    under.style.transform = commit ? 'translateX(0%)' : 'translateX(-28%)';
  }
  swipe = null;
  swipeAnim = setTimeout(() => {
    swipeAnim = null;
    target.classList.remove('swipe-settling');
    if (!commit) return resetSwipe();
    lastBackAt = Date.now();
    if (history.state) {
      history.back(); // popstate zeichnet die vorherige Seite und ruft resetSwipe()
      swipeAnim = setTimeout(resetSwipe, 700); // Sicherheitsnetz
    } else {
      closeEditor(); hideDetail(); resetSwipe();
    }
  }, duration + 20);
}

function swipeCancel() {
  if (!swipe) return;
  if (swipe.target) finishSwipe(false, swipe.dx || 0, 0);
  else swipe = null;
}

// Finger
document.addEventListener('touchstart', (e) => {
  if (e.touches.length > 1) return swipeCancel();
  const t = e.touches[0];
  swipeStart(t.clientX, t.clientY, e.timeStamp, e.target);
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (swipeMove(t.clientX, t.clientY, e.timeStamp) && e.cancelable) e.preventDefault();
}, { passive: false });
document.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  swipeEnd(t.clientX, e.timeStamp);
});
document.addEventListener('touchcancel', swipeCancel);

// Maus (Desktop)
document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 0) swipeStart(e.clientX, e.clientY, e.timeStamp, e.target); });
document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') swipeMove(e.clientX, e.clientY, e.timeStamp); });
document.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') swipeEnd(e.clientX, e.timeStamp); });

// Der schmale Randstreifen gehört ganz uns (verhindert die iPhone-Browsergeste)
document.getElementById('edge-swipe-guard')?.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

// Gewählte Startansicht öffnen (steht bewusst ganz am Ende: alles ist definiert).
// "Zurück" führt von dort auf die Startseite
if (startPage() === 'weekplan') openWeekplan();
else if (startPage() === 'tinder' && filtered().length >= 2) openTinder();
