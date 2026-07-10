'use strict';

// FUNKTIONALITÄTEN-TIMESTAMP: bei JEDER Code-Änderung aktualisieren (App allgemein, Wochenplan, Tindern)
// ISO-Format mit Berlin-Zeitzone, Vergleich läuft über Datums-Parsing (nie String-Vergleich!)
const APP_BUILD_TIME = '2026-07-10T16:18:00+02:00';

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
let mode = localStorage.getItem(MODE_KEY) || 'kochen';
if (!MODES[mode]) mode = 'kochen';

function recipeMode(r) {
  return r.bereich || 'kochen';
}

const $ = s => document.querySelector(s);

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

// Frische Rezepte holen: mit Token direkt über die GitHub-API (sofort aktuell),
// sonst über GitHub Pages (kann nach einem Save ein paar Minuten hinterherhängen)
async function fetchRemoteRecipes() {
  if (typeof ghGet === 'function' && typeof ghToken === 'function' && ghToken()) {
    try {
      const info = await ghGet('data/recipes.json');
      return JSON.parse(utf8b64(info.content));
    } catch (e) { /* API nicht erreichbar → Pages-Fallback */ }
  }
  const res = await fetch('data/recipes.json?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
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
    grid.innerHTML = `<div class="empty">Nichts gefunden 🤷</div>`;
  }

  // Buchstaben-Divider nur in der alphabetischen "Alle"-Ansicht ohne Suche
  const showDividers = sortMode === 'alpha' && activeCategory === 'Alle' && !query.trim();
  let lastLetter = null;

  for (const item of items) {
    if (showDividers) {
      const letter = dividerLetter(item);
      if (letter !== lastLetter) {
        lastLetter = letter;
        const divider = document.createElement('div');
        divider.className = 'grid-divider';
        divider.innerHTML = `<span>${letter}</span>`;
        grid.appendChild(divider);
      }
    }
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
        <div class="meta">${item.members.length} Varianten ›</div>`;
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
}

/* ---------- Detailansicht ---------- */

function openRecipe(id, opts = {}) {
  renderDetail(id, opts);
  history.pushState({ view: 'recipe', id, random: !!opts.random }, '');
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
  renderGroup(name);
  history.pushState({ view: 'group', group: name }, '');
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
      <div class="detail-meta">${members.length} Varianten – such dir eine aus</div>
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
  el.querySelector('.detail-home').onclick = () => {
    el.hidden = true;
    document.body.style.overflow = '';
  };
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

function renderDetail(id, opts = {}) {
  const r = data.recipes.find(x => x.id === id);
  if (!r) return;
  const el = $('#detail');
  const meta = [categoryLabel(r), displayDuration(r.time), r.servings].filter(Boolean).join(' · ');
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <button class="detail-home" aria-label="Startseite">🏠</button>
    ${opts.random ? '<button class="detail-random" aria-label="Nochmal würfeln">🎲</button>' : ''}
    ${detailPhotosHTML(r)}
    <div class="detail-body">
      <h2>${titleWithEmoji(r)}</h2>
      ${meta ? `<div class="detail-meta">${esc(meta)}</div>` : ''}
      ${(r.ingredients || []).length ? `<h3>Zutaten</h3>
        <ul>${r.ingredients.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${(r.steps || []).length ? `<h3>Zubereitung</h3>
        <ol>${r.steps.map(s => `<li><span>${esc(s)}</span></li>`).join('')}</ol>` : ''}
      ${r.notes ? `<div class="detail-notes">💡 ${esc(r.notes)}</div>` : ''}
    </div>`;
  el.querySelector('.detail-close').onclick = () => closeOverlay();
  el.querySelector('.detail-home').onclick = () => {
    el.hidden = true;
    document.body.style.overflow = '';
  };
  const rnd = el.querySelector('.detail-random');
  if (rnd) {
    rnd.onclick = () => {
      const list = filtered().filter(x => x.id !== id);
      if (!list.length) return toast('Mehr gibt es nicht 🤷');
      const next = list[Math.floor(Math.random() * list.length)];
      renderDetail(next.id, { random: true });
      // ersetzt den Verlaufseintrag: einmal zurück führt immer zur Übersicht
      history.replaceState({ view: 'recipe', id: next.id, random: true }, '');
    };
  }
  wirePhotoDots(el);
  if (window.editorEnhanceDetail) window.editorEnhanceDetail(el, id);
  el.hidden = false;
  document.body.style.overflow = 'hidden';
}

// Reine Anzeige-Schließung (kein History-Eingriff) — nur von popstate genutzt
function hideDetail() {
  $('#detail').hidden = true;
  document.body.style.overflow = '';
}

// Schließen läuft IMMER über die History (history.back), damit der Verlauf
// synchron bleibt. Sonst bleiben alte Zustände auf dem Stack liegen und man
// landet beim nächsten Zurück auf einem „zufälligen" alten Rezept.
function closeOverlay() {
  if (history.state) history.back();
  else hideDetail();
}

// Zurück-Navigation: null = Übersicht, sonst die jeweilige Ansicht wiederherstellen
window.addEventListener('popstate', e => {
  const s = e.state;
  if (!s) return hideDetail();
  if (s.view === 'group') renderGroup(s.group);
  else if (s.view === 'recipe') renderDetail(s.id, { random: s.random });
  else if (s.view === 'weekplan') renderWeekplan();
  else if (s.view === 'tinder') renderTinder();
  else if (s.view === 'tinder-result' || s.view === 'tinder-result-recipe') renderTinderResult(s.ids || []);
  else hideDetail();
});

/* ---------- Rezept-Tinder 🔥 ---------- */

let tinder = null; // { deck: [Rezepte], likes: [Rezepte] }

function openTinder() {
  renderTinder();
  history.pushState({ view: 'tinder' }, '');
}

// Welche Woche gerade im Wochenplan angezeigt wird (Standard: aktuelle Woche)
let weekplanViewDate = new Date();
let weekplanViewKey = null;

function openWeekplan() {
  weekplanViewDate = new Date(); // beim Öffnen immer zurück auf die laufende Woche
  clearWeekplanUpdateDot();
  renderWeekplan();
  history.pushState({ view: 'weekplan' }, '');
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
   Neuester ISO-Timestamp gewinnt (ganze Datei). */

async function fetchRemoteWeekplan() {
  if (typeof ghGet === 'function' && typeof ghToken === 'function' && ghToken()) {
    try {
      const info = await ghGet('data/weekplan.json');
      return JSON.parse(utf8b64(info.content));
    } catch (e) { /* Datei existiert evtl. noch nicht */ }
  }
  try {
    const res = await fetch('data/weekplan.json?t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch (e) { /* offline */ }
  return null;
}

// Remote-Struktur → Wochen-Map (migriert altes { days }-Format in die aktuelle Woche)
function remoteToWeeks(remote) {
  if (!remote) return null;
  if (remote.weeks) return remote.weeks;
  if (remote.days) return { [weekKey()]: normalizeDays(remote.days) };
  return null;
}

// Holt den Remote-Stand und übernimmt ihn, wenn er neuer ist als der lokale
async function syncWeekplanFromRemote() {
  const remote = await fetchRemoteWeekplan();
  const weeks = remoteToWeeks(remote);
  if (!weeks) return false;
  const localUpdated = new Date(localStorage.getItem(WEEKPLAN_UPDATED_KEY)).getTime() || 0;
  const remoteUpdated = new Date(remote.updated).getTime() || 0;
  if (remoteUpdated > localUpdated) {
    localStorage.setItem(WEEKPLAN_KEY, JSON.stringify({ weeks }));
    localStorage.setItem(WEEKPLAN_UPDATED_KEY, remote.updated);
    return true;
  }
  return false;
}

// Lädt ALLE lokalen Wochen zu GitHub hoch, damit andere Geräte sie sehen
async function uploadWeekplan() {
  if (typeof ghToken !== 'function' || !ghToken()) {
    toast('💾 Nur lokal gespeichert (kein Token auf diesem Gerät)');
    return;
  }
  const payload = { updated: new Date().toISOString(), weeks: getAllWeekplans() };
  let sha;
  try { sha = (await ghGet('data/weekplan.json')).sha; } catch (e) { /* erste Übertragung */ }
  await ghPut('data/weekplan.json', b64utf8(JSON.stringify(payload, null, 2)),
    'Wochenplan aktualisiert (aus der App)', sha);
  localStorage.setItem(WEEKPLAN_UPDATED_KEY, payload.updated);
  toast('✅ Wochenplan gespeichert & geteilt');
}

// HTML für einen Wochenplan-Eintrag — Rezepte sind anklickbar (öffnen das Rezept).
// In vergangenen Wochen (readonly) entfällt der X-Button zum Entfernen.
function weekplanTagHTML(entry, displayName, dayKey, readonly = false) {
  const isRecipe = !entry.startsWith('TEXT:');
  return `<span class="weekplan-tag" data-entry="${esc(entry)}" data-day="${dayKey}">` +
    `<span class="weekplan-tag-text${isRecipe ? ' clickable' : ''}">${esc(displayName)}</span>` +
    (readonly ? '' : `<button class="weekplan-tag-remove" data-entry="${esc(entry)}" data-day="${dayKey}" aria-label="Entfernen">✕</button>`) +
    `</span>`;
}

// Handler pro Tag: X entfernt den Eintrag, Klick auf einen Rezept-Namen öffnet das Rezept
function attachTagHandlers(selectedDiv, weekplan) {
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
        removeBtn.closest('.weekplan-tag').remove();
      }
    };
  }
  for (const textEl of selectedDiv.querySelectorAll('.weekplan-tag-text.clickable')) {
    const entry = textEl.closest('.weekplan-tag')?.dataset.entry;
    textEl.onclick = () => {
      if (entry && data.recipes.some(r => r.id === entry)) openRecipe(entry);
    };
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
    const noEdit = readonly || isPastDay;
    let tagsHTML = '';

    // Ausgeblendete Tage zeigen weder Einträge noch das Eingabefeld — die
    // Einträge bleiben aber in weekplan[day.key] unangetastet gespeichert und
    // erscheinen beim Wiedereinblenden unverändert erneut.
    if (!isOff) {
      for (const entry of entries) {
        let displayName = '';
        if (entry.startsWith('TEXT:')) {
          displayName = entry.substring(5);
        } else {
          const recipe = data.recipes.find(r => r.id === entry);
          displayName = recipe ? titleWithEmoji(recipe) : '';
        }

        if (displayName) {
          tagsHTML += weekplanTagHTML(entry, displayName, day.key, noEdit);
        }
      }
    }

    // Reihenfolge: erst die Einträge, darunter das Eingabefeld (entfällt in
    // vergangenen Wochen UND bei bereits gelaufenen Einzeltagen — nur
    // ansehen). Der Umschalt-Knopf selbst bleibt oben rechts an der Karte
    // immer voll sichtbar (eigener Layer, nicht gedimmt).
    daysHTML += `
      <div class="weekplan-day${isOff ? ' day-off' : ''}${isPastDay ? ' past-day' : ''}" data-day="${day.key}">
        ${noEdit ? '' : `<button class="weekplan-day-toggle" data-day="${day.key}" aria-label="${isOff ? 'Tag wieder einblenden' : 'Tag ausblenden'}">${isOff ? '+' : '−'}</button>`}
        <div class="weekplan-day-inner">
          <label class="weekplan-label">${day.label}</label>
          ${isOff
            ? `<div class="weekplan-off-hint">🔕 Ausgeblendet</div>`
            : `<div class="weekplan-autocomplete" data-day="${day.key}">
                <div class="weekplan-selected">${tagsHTML}</div>
                ${noEdit ? '' : `
                <div class="weekplan-input-row">
                  <input type="text" class="weekplan-search" placeholder="Rezept hinzufügen …" autocomplete="off">
                  <button class="weekplan-add-btn" title="Freitext hinzufügen">+</button>
                </div>
                <div class="weekplan-suggestions" hidden></div>`}
              </div>`}
        </div>
      </div>`;
  }

  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="detail-body group-body weekplan-body${readonly ? ' readonly' : ''}">
      <div class="weekplan-header">
        <button class="weekplan-nav" data-dir="-1" aria-label="Woche zurück">‹</button>
        <div class="weekplan-weektitle">
          <div class="weekplan-kw">📅 KW ${isoKalenderwoche(weekplanViewDate)}${istAktuelleWoche ? ' <span class="weekplan-now">jetzt</span>' : ''}</div>
          <div class="weekplan-range">${rangeText}</div>
        </div>
        <button class="weekplan-nav" data-dir="1" aria-label="Woche vor">›</button>
      </div>
      <div class="weekplan-container">
        ${daysHTML}
      </div>
      ${readonly ? '' : '<button class="weekplan-save-btn">💾 Speichern & teilen</button>'}
    </div>`;

  el.querySelector('.detail-close').onclick = () => closeOverlay();

  // Wochen-Navigation: eine Woche zurück/vor, gleiche Ansicht neu zeichnen
  for (const navBtn of el.querySelectorAll('.weekplan-nav')) {
    navBtn.onclick = () => {
      weekplanViewDate = new Date(weekplanViewDate);
      weekplanViewDate.setDate(weekplanViewDate.getDate() + 7 * Number(navBtn.dataset.dir));
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
      renderWeekplan(true);
    };
  }

  // Autocomplete Setup
  for (const dayEl of el.querySelectorAll('.weekplan-autocomplete')) {
    const dayKey = dayEl.dataset.day;
    const selectedDiv = dayEl.querySelector('.weekplan-selected');
    // Tag-Klicks (Rezept öffnen) und X-Entfernen — auch in vergangenen Wochen
    // öffnen Rezept-Klicks das Rezept (nur X/Eingabe entfallen)
    attachTagHandlers(selectedDiv, weekplan);

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

          // Update UI: neues Tag hinzufügen
          selectedDiv.insertAdjacentHTML('beforeend', weekplanTagHTML(recipeId, titleWithEmoji(recipe), dayKey));

          searchInput.value = '';
          suggestionsDiv.hidden = true;
          attachTagHandlers(selectedDiv, weekplan);
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

      // Update UI: neues Tag hinzufügen
      selectedDiv.insertAdjacentHTML('beforeend', weekplanTagHTML(entry, text, dayKey));

      searchInput.value = '';
      suggestionsDiv.hidden = true;
      attachTagHandlers(selectedDiv, weekplan);
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

  // Save Button: lokal speichern UND alle Wochen zu GitHub hochladen (fehlt in vergangenen Wochen)
  const saveBtn = el.querySelector('.weekplan-save-btn');
  if (saveBtn) saveBtn.onclick = async () => {
    saveWeekplan(weekplan);
    try {
      await uploadWeekplan();
    } catch (e) {
      console.log('Wochenplan-Upload fehlgeschlagen:', e);
      toast('⚠️ Lokal gespeichert, Teilen fehlgeschlagen (offline?)');
    }
  };

  el.hidden = false;
  document.body.style.overflow = 'hidden';

  // Im Hintergrund: neuesten Stand vom anderen Gerät holen und anzeigen
  if (!skipSync) {
    syncWeekplanFromRemote().then(changed => {
      // Nur neu rendern wenn der Wochenplan noch offen ist
      if (changed && !el.hidden && el.querySelector('.weekplan-container')) {
        toast('🔄 Wochenplan vom anderen Gerät übernommen');
        renderWeekplan(true);
      }
    });
  }
}

function renderTinder() {
  const pool = filtered().slice();
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
    <div class="t-badge like">WILL ICH 😍</div>
    <div class="t-badge nope">NÖ 🙅</div>
    <div class="t-card-badge-text like-text">WILL ICH 😍</div>
    <div class="t-card-badge-text nope-text">NÖ 🙅</div>
    <div class="t-badge like">WILL ICH</div>
    <div class="t-badge nope">NÖ</div>
  </div>`;
}

  function tinderPlaceholderHTML() {
    return `<div class="t-card behind placeholder">
      <div class="t-emoji">✨</div>
      <div class="t-info">
        <div class="t-title">Noch eine Karte...</div>
        <div class="t-meta">Tippe oder wische, um weiterzumachen</div>
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
      <div class="tinder-status">❤️ ${tinder.likes.length} / 3 · noch ${tinder.deck.length} Karten</div>
      <div class="tinder-stack">
        ${next ? tinderCardHTML(next, 'behind') : tinderPlaceholderHTML()}
        ${tinderCardHTML(top, 'top')}
      </div>
      <div class="tinder-buttons">
        <button class="t-nope" aria-label="Nö">👎</button>
        <button class="t-superlike" aria-label="Superlike">⭐</button>
        <button class="t-like" aria-label="Will ich">❤️</button>
      </div>
      <div class="tinder-hint">Wischen oder tippen: links = nö, Mitte = superlike, rechts = will ich!</div>
    </div>`;

  el.querySelector('.detail-close').onclick = () => closeOverlay();
  const card = el.querySelector('.t-card.top');
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
  const overlay = document.createElement('div');
  overlay.className = 'superlike-overlay';
  overlay.innerHTML = '<div class="superlike-text">SUPERLIKE ⭐</div>';
  el.appendChild(overlay);

  setTimeout(() => {
    overlay.remove();
    tinder.deck.shift();
    renderDetail(recipe.id);
    history.replaceState({ view: 'recipe', id: recipe.id }, '');
  }, 2500);
}

function flyOut(card, dir) {
  // Text einblenden
  const textBadge = card.querySelector(dir > 0 ? '.like-text' : '.nope-text');
  if (textBadge) {
    textBadge.style.opacity = '1';
  }

  // Passenden Stempel groß einblenden, dann Karte rausfliegen lassen
  const badge = card.querySelector(dir > 0 ? '.t-badge.like' : '.t-badge.nope');
  badge.style.opacity = 1;
  badge.style.transform = `rotate(${dir > 0 ? -14 : 14}deg) scale(1.15)`;

  // Verzögerte Animation für Karte
  setTimeout(() => {
    card.style.transition = 'transform 1.0s ease, opacity 1.0s ease';
    card.style.transform = `translate(${dir * 120}vw, -40px) rotate(${dir * 30}deg)`;
    card.style.opacity = '0';
  }, 400);

  setTimeout(() => swipeTinder(dir), 1400);
}

function attachSwipe(card, onSwipe) {
  if (!card) return; // Sicherheit: Card existiert nicht
  let startX = 0, startY = 0, dx = 0, dragging = false, done = false;
  const badgeLike = card.querySelector('.t-badge.like');
  const badgeNope = card.querySelector('.t-badge.nope');
  const likeText = card.querySelector('.t-card-badge-text.like-text');
  const nopeText = card.querySelector('.t-card-badge-text.nope-text');
  const img = card.querySelector('img');

  // Fehlerschutz: wenn kritische Elemente nicht existieren, nicht weitermachen
  if (!badgeLike || !badgeNope || !likeText || !nopeText) {
    console.warn('[SW] attachSwipe: fehlende kritische Elemente, Swipe deaktiviert');
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
    if (dx > 0) {
      badgeLike.style.opacity = p;
      badgeLike.style.transform = `rotate(-14deg) scale(${scale})`;
      badgeNope.style.opacity = 0;
    } else {
      badgeNope.style.opacity = p;
      badgeNope.style.transform = `rotate(14deg) scale(${scale})`;
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
      badgeNope.style.opacity = 0;
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
  history.replaceState({ view: 'tinder-result', ids }, '');
  renderTinderResult(ids);
}

function renderTinderResult(ids) {
  const winners = ids.map(id => data.recipes.find(r => r.id === id)).filter(Boolean);
  const el = $('#detail');
  if (!winners.length) {
    el.innerHTML = `
      <button class="detail-close" aria-label="Zurück">←</button>
      <div class="detail-body group-body">
        <h2>Alles weggewischt 😅</h2>
        <div class="detail-meta">Vielleicht ist beim nächsten Mischen was dabei.</div>
        <button class="tinder-again">🔀 Nochmal mischen</button>
      </div>`;
    el.querySelector('.detail-close').onclick = () => closeOverlay();
    el.querySelector('.tinder-again').onclick = () => {
      history.replaceState({ view: 'tinder' }, '');
      renderTinder();
    };
  } else {
    // Erst Fotos zeigen, dann Slot-Machine
    el.innerHTML = `
      <div class="tinder-match-screen" id="match-screen">
        <div class="match-overlay">
          <div class="match-text">IT'S A MATCH! 🎉</div>
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
        <h2>Jetzt gilt's! 🎲</h2>
        <div class="detail-meta">Was kochen wir heute? 😉</div>

        <div class="slot-machine" id="slot-container" style="display:none;">
          <div class="slot-window">
            <div class="slot-reel" id="slot-reel"></div>
          </div>
        </div>

        <div class="slot-buttons">
          <button class="slot-spin" id="slot-btn" style="display:none;">🎰 LOSCHEN!</button>
          <button class="tinder-again" style="display:none;">🔀 Nochmal mischen</button>
        </div>
      </div>`;

    el.querySelector('.detail-close').onclick = () => closeOverlay();
    el.querySelector('.detail-home').onclick = () => {
      el.hidden = true;
      document.body.style.overflow = '';
    };

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
  btn.textContent = '✨ ' + w.title + (w.emoji ? ' ' + w.emoji : '');
  btn.disabled = false;
  btn.onclick = () => {
    renderDetail(w.id);
    history.pushState({ view: 'tinder-result-recipe', ids: winners.map(x => x.id), winnerIndex: pick }, '');
  };
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
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function showToastWithoutTimeout(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
}

/* ---------- Start ---------- */

/* ---------- Einstellungen ---------- */

const LAST_UPDATE_KEY = 'rezeptbuch-last-update';
const THEME_KEY = 'rezeptbuch-theme';
const COLOR_KEY = 'rezeptbuch-colorscheme';
const EDIT_ENABLED_KEY = 'rezeptbuch-edit-enabled';

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
}

// Farbschema (unabhängig von Hell/Dunkel): 'orange' (Standard) | 'blue' | 'rainbow'
const COLOR_THEME_META = { orange: '#e8590c', blue: '#1466c4', rainbow: '#d6249f' };

function applyColorScheme(scheme) {
  const html = document.documentElement;
  html.classList.remove('color-orange', 'color-blue', 'color-rainbow');
  html.classList.add('color-' + scheme);
  localStorage.setItem(COLOR_KEY, scheme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && COLOR_THEME_META[scheme]) meta.setAttribute('content', COLOR_THEME_META[scheme]);
}

// Theme + Farbschema beim Start laden
(() => {
  applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
  applyColorScheme(localStorage.getItem(COLOR_KEY) || 'orange');
})();

function openSettings() {
  const hasToken = ghToken && ghToken();
  const lastUpdate = localStorage.getItem(LAST_UPDATE_KEY) || '—';
  const offline = localStorage.getItem(OFFLINE_MODE_KEY) === 'true';
  // Gemerkte Einstellung bleibt unangetastet — offline wird sie nur überlagert
  const editEnabled = localStorage.getItem(EDIT_ENABLED_KEY) !== 'false' && hasToken;
  const currentTheme = localStorage.getItem(THEME_KEY) || 'auto';
  const currentColor = localStorage.getItem(COLOR_KEY) || 'orange';

  const el = $('#editor'); // Reuse editor div für Modal
  el.innerHTML = `
  <button class="detail-close" aria-label="Zurück">←</button>
  <div class="ed-body settings-body">
    <h2>⚙️ Einstellungen</h2>

    <div class="settings-section">
      <h3>Anzeige</h3>
      <div class="settings-row">
        <label class="setting-radio">
          <input type="radio" name="theme" value="light" ${currentTheme === 'light' ? 'checked' : ''}>
          <span>☀️ Annika (Hell)</span>
        </label>
        <label class="setting-radio">
          <input type="radio" name="theme" value="dark" ${currentTheme === 'dark' ? 'checked' : ''}>
          <span>🌙 Lars (Dunkel)</span>
        </label>
        <label class="setting-radio">
          <input type="radio" name="theme" value="auto" ${currentTheme === 'auto' ? 'checked' : ''}>
          <span>🔄 Systemvorgabe</span>
        </label>
      </div>
    </div>

    <div class="settings-section">
      <h3>Farbschema</h3>
      <div class="settings-row">
        <label class="setting-radio">
          <input type="radio" name="colorscheme" value="orange" ${currentColor === 'orange' ? 'checked' : ''}>
          <span>🟧 Orange</span>
        </label>
        <label class="setting-radio">
          <input type="radio" name="colorscheme" value="blue" ${currentColor === 'blue' ? 'checked' : ''}>
          <span>🟦 Blau</span>
        </label>
        <label class="setting-radio">
          <input type="radio" name="colorscheme" value="rainbow" ${currentColor === 'rainbow' ? 'checked' : ''}>
          <span>🌈 Rainbow</span>
        </label>
      </div>
    </div>

    <div class="settings-section">
      <h3>Verbindung</h3>
      <div class="settings-row">
        <label class="setting-label">
          <div class="toggle-slider">
            <input type="checkbox" id="offline-toggle" ${localStorage.getItem(OFFLINE_MODE_KEY) === 'true' ? 'checked' : ''}>
            <span class="slider"></span>
          </div>
          <span>🔒 Offline-Modus</span>
        </label>
        <div class="setting-hint">Keine Abgleiche mit Server, nur Lesen möglich</div>
      </div>
    </div>

    <div class="settings-section"${offline ? ' style="opacity: 0.4; pointer-events: none;"' : ''}>
      <h3>Bearbeiten</h3>
      ${hasToken
        ? `<div class="settings-row">
            <label class="setting-label">
              <div class="toggle-slider">
                <input type="checkbox" id="edit-toggle" ${editEnabled && !offline ? 'checked' : ''}${offline ? ' disabled' : ''}>
                <span class="slider"></span>
              </div>
              <span>✏️ Bearbeitungsmodus</span>
            </label>
            <div class="setting-hint">${offline
              ? 'Im Offline-Modus deaktiviert – wird beim Ausschalten wiederhergestellt'
              : 'Token ist gespeichert – schalte Bearbeiten an/aus'}</div>
          </div>
          <button class="setting-btn" id="clear-token">Token entfernen</button>
          <button class="setting-btn" id="share-token">🔗 Token teilen</button>`
        : `<button class="setting-btn" id="setup-token">Token einrichten</button>`}
    </div>

    <button class="setting-btn primary" id="refresh-btn">⟳ Update</button>
    <div class="update-status"></div>

    <div class="setting-info">
      <div><strong>Rezepte:</strong> ${data.recipes.length}</div>
      <div><strong>Zuletzt aktualisiert:</strong> ${lastUpdate}</div>
    </div>
  </div>`;

  el.querySelector('.detail-close').onclick = () => { el.hidden = true; document.body.style.overflow = ''; };

  const editToggle = el.querySelector('#edit-toggle');
  if (editToggle) {
    editToggle.onchange = () => {
      localStorage.setItem(EDIT_ENABLED_KEY, editToggle.checked ? 'true' : 'false');
      render();
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
    if (window.clearToken) {
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
        <h3>🔗 Token für deine Freundin</h3>
        <p>Teile diesen Token mit deiner Freundin:</p>
        <input type="text" readonly value="${esc(token)}" class="token-share-input">
        <button class="token-share-copy">📋 In Zwischenablage kopieren</button>
        <p class="token-share-hint">Deine Freundin kann den Token dann unter ⚙️ → "Token einrichten" einfügen</p>
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

  el.querySelector('#setup-token')?.addEventListener('click', () => {
    el.hidden = true;
    document.body.style.overflow = '';
    if (window.openTokenSetup) window.openTokenSetup();
  });

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
      } else if (!hasUpdates) {
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
            statusEl.innerHTML = `<div style="color: var(--accent); font-weight: 600; margin-top: 8px;">🔄 Update verfügbar</div>`;
          }
        }
      }
    } catch (e) {
      console.log('Update-Check fehlgeschlagen');
    }
  })();
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
  $('#mode-label').textContent = `${MODES[mode].emoji} ${MODES[mode].label} ▾`;
  const menu = $('#mode-menu');
  menu.innerHTML = '';
  for (const [key, m] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.className = key === mode ? 'active' : '';
    b.textContent = `${m.emoji} ${m.label}`;
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
  ['alpha', '🔤 Alphabetisch'],
  ['time', '⏱️ Zubereitungszeit'],
  ['recent', '🆕 Zuletzt hinzugefügt'],
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
  if (document.querySelector('.app-update-dialog')) return; // nicht doppelt zeigen
  const dialog = document.createElement('div');
  dialog.className = 'app-update-dialog';
  dialog.style.cssText = `
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: var(--card); border: 3px solid var(--accent); border-radius: 12px;
    padding: 24px; z-index: 2000; text-align: center; max-width: 300px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);`;
  const btnStyle = `padding: 12px 20px; margin: 6px; border: none; border-radius: 6px;
    cursor: pointer; font-size: 15px; font-weight: bold; font-family: inherit;`;
  dialog.innerHTML = `
    <h3 style="margin: 0 0 12px 0; color: var(--accent);">✨ App-Update verfügbar!</h3>
    <p style="margin: 0 0 12px 0; color: var(--text);">Neue Funktionen sind bereit.</p>
    <button class="app-update-now" style="${btnStyle} background: var(--accent); color: white;">🔄 Jetzt updaten</button>
    <button class="app-update-later" style="${btnStyle} background: none; color: var(--muted); border: 1px solid var(--muted);">Später</button>`;
  document.body.appendChild(dialog);
  dialog.querySelector('.app-update-now').onclick = () => { dialog.remove(); performAppUpdate(); };
  dialog.querySelector('.app-update-later').onclick = () => dialog.remove();
}

// Prüft per ISO-Vergleich, ob auf dem Server neuere App-Funktionen liegen
async function checkAppUpdateAvailable() {
  const remoteBuild = await fetchRemoteBuildTime();
  return !!remoteBuild && new Date(remoteBuild).getTime() > new Date(APP_BUILD_TIME).getTime();
}

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
//  - in einer Ansicht (#detail/#editor): zurück
//  - auf der Rezeptübersicht: Einstellungen öffnen ("nach vorne")
let swipeStart = null;
let swipeStartY = 0;
let swipeMode = null; // 'back' | 'settings'
const swipeTarget = () => $('#detail').hidden ? $('#editor') : $('#detail');

document.addEventListener('pointerdown', (e) => {
  if (e.clientX >= 50) return;
  swipeStart = e.clientX;
  swipeStartY = e.clientY;
  swipeMode = ($('#detail').hidden && $('#editor').hidden) ? 'settings' : 'back';
}, false);

document.addEventListener('pointermove', (e) => {
  if (swipeStart === null) return;
  const swipeDistance = e.clientX - swipeStart;
  const dy = Math.abs(e.clientY - swipeStartY);

  // Übersicht: Wisch nach rechts öffnet die Einstellungen
  if (swipeMode === 'settings') {
    if (swipeDistance > 80 && dy < 60) {
      swipeStart = null; swipeMode = null;
      openSettings();
    } else if (swipeDistance < -10 || dy > 80) {
      swipeStart = null; swipeMode = null; // vertikales Scrollen / falsche Richtung
    }
    return;
  }

  const target = swipeTarget();
  const closeBtn = target.querySelector('.detail-close');

  // Nur swipen, wenn der Zurück-Button sichtbar ist (aber nicht auf Tinder-Seite)
  if (!closeBtn || getComputedStyle(closeBtn).display === 'none' || closeBtn.classList.contains('tinder-close')) {
    swipeStart = null;
    return;
  }

  // Zeige Swipe-Animation während des Swipens
  if (!target.hidden) {
    target.style.transform = `translateX(${Math.min(swipeDistance, 100)}px)`;
    target.style.opacity = Math.max(0.5, 1 - swipeDistance / 300);
  }

  // Wenn genug geswipet wurde: schließen. #detail läuft über die History
  // (closeOverlay → history.back), damit man auf der richtigen Übersicht landet.
  // #editor (Einstellungen/Editor) hat keinen History-State → direkt verstecken.
  if (swipeDistance > 100 && e.clientX < 200) {
    swipeStart = null;
    target.style.transform = '';
    target.style.opacity = '';
    if (target.id === 'detail') closeOverlay();
    else { target.hidden = true; document.body.style.overflow = ''; }
  }
}, false);

document.addEventListener('pointerup', () => {
  if (swipeStart !== null && swipeMode === 'back') {
    const target = swipeTarget();
    target.style.transform = '';
    target.style.opacity = '';
  }
  swipeStart = null;
  swipeMode = null;
}, false);
