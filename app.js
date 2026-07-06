'use strict';

// APP-FUNKTIONALITÄTS-VERSION: erhöhen bei JEDER Änderung (unabhängig von Rezepten!)
// Format: YYYYMMDD-HHMM (z.B. 20260707-1930)
const APP_BUILD_VERSION = '20260707-1935';

const DATA_KEY = 'rezeptbuch-data';
const IMG_CACHE = 'rezept-bilder-v1';
const OFFLINE_MODE_KEY = 'rezeptbuch-offline-mode';
const LAST_UPDATED_KEY = 'rezeptbuch-last-updated';
const LAST_APP_VERSION_KEY = 'rezeptbuch-last-app-version';

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

function emojiFor(recipe) {
  return recipe.emoji || CATEGORY_EMOJI[recipe.category] || '🍽️';
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

// Auto-Check: Prüfe ob neue Rezepte vom Server verfügbar sind
// Gibt true zurück wenn Updates gefunden wurden, false wenn aktuell
async function checkAndUpdateIfNeeded() {
  // Skip wenn Offline-Modus aktiv
  if (localStorage.getItem(OFFLINE_MODE_KEY) === 'true') {
    console.log('ℹ️ Offline-Modus aktiv - kein Abgleich mit Server');
    return false;
  }

  try {
    const res = await fetch('data/recipes.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return false;
    const fresh = await res.json();

    // Vergleiche global updated Datum (ISO-Parse für robuste Vergleiche)
    const oldDate = new Date(data.updated).getTime();
    const freshDate = new Date(fresh.updated).getTime();
    if (freshDate === oldDate) {
      console.log('✅ Rezepte sind aktuell');
      return false; // Nichts geändert
    }

    console.log('🔄 Neue Rezepte verfügbar (lokal:', data.updated, 'remote:', fresh.updated + ')');

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
      // Update: ganze recipes ersetzen
      data.recipes = fresh.recipes;
      data.updated = fresh.updated;
      saveLocal();
      console.log('🔄 ' + updated.length + ' Rezept(e) aktualisiert: ' + updated.join(', '));
      toast('🔄 ' + updated.length + ' Rezept(e) aktualisiert');
      return true;
    }
    return true; // Auch wenn keine Rezepte geändert, aber Struktur aktualisiert
  } catch (e) {
    console.log('ℹ️ Konnte nicht nach Updates prüfen (offline?)');
    return false;
  }
}

/* ---------- Aktualisieren ---------- */

async function update(showErrors = true) {
  try {
    const oldData = JSON.parse(JSON.stringify(data)); // Deep copy
    const res = await fetch('data/recipes.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const fresh = await res.json();

    // Neue Bilder herunterladen, damit alles offline verfügbar ist.
    // Bilddateien haben versionierte Namen: was schon im Cache liegt, bleibt.
    const cache = await caches.open(IMG_CACHE);
    const wanted = new Set();
    for (const r of fresh.recipes) {
      for (const img of imagesOf(r)) {
        wanted.add(new URL(img, location.href).href);
        if (await cache.match(img)) continue;
        try {
          const imgRes = await fetch(img, { cache: 'no-store' });
          if (imgRes.ok) await cache.put(img, imgRes);
        } catch (e) { /* einzelnes Bild fehlgeschlagen – beim nächsten Update erneut */ }
      }
    }
    // Nicht mehr benötigte Bilder aufräumen
    for (const req of await cache.keys()) {
      if (!wanted.has(req.url)) await cache.delete(req);
    }

    data = fresh;
    console.log('✅ data = fresh gesetzt, Updated:', data.updated, 'Rezepte:', data.recipes.length);
    saveLocal();
    console.log('✅ saveLocal() aufgerufen');
    render();
    console.log('✅ render() aufgerufen');

    // Vergleiche alte und neue Daten und erstelle Update-Nachricht
    const messages = [];

    // Check für neue/aktualisierte Rezepte
    const oldIds = new Set(oldData.recipes.map(r => r.id));
    const newRecipes = fresh.recipes.filter(r => !oldIds.has(r.id));
    if (newRecipes.length > 0) {
      messages.push(`✅ ${newRecipes.length} neue ${newRecipes.length === 1 ? 'Rezept' : 'Rezepte'}`);
    }

    // Check für aktualisierte Rezepte
    const oldMap = new Map(oldData.recipes.map(r => [r.id, r]));
    const updatedRecipes = fresh.recipes.filter(r => {
      const old = oldMap.get(r.id);
      return old && JSON.stringify(old) !== JSON.stringify(r);
    });
    if (updatedRecipes.length > 0) {
      messages.push(`✅ ${updatedRecipes.length} ${updatedRecipes.length === 1 ? 'Rezept aktualisiert' : 'Rezepte aktualisiert'}`);
    }

    // Zeige Nachricht an
    if (messages.length > 0) {
      toast(messages.join('\n'));
    } else {
      toast('✅ Alles schon aktuell');
    }
  } catch (e) {
    console.error('🔴 FEHLER in update():', e.message, e.stack);
    if (showErrors) toast('Keine Verbindung – gespeicherte Rezepte bleiben da 📴');
  } finally {
    // Letztes Update-Datum speichern
    const now = new Date().toLocaleString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    localStorage.setItem(LAST_UPDATE_KEY, now);
  }
}

/* ---------- Anzeige ---------- */

function categories() {
  const inMode = data.recipes.filter(r => recipeMode(r) === mode);
  const cats = [...new Set(inMode.map(r => {
    // Handle both array and string categories
    if (Array.isArray(r.category)) return r.category[0];
    return r.category;
  }).filter(Boolean))];
  cats.sort((a, b) => String(a).localeCompare(String(b), 'de'));
  return ['Alle', ...cats];
}

function filtered() {
  const q = query.trim().toLowerCase();
  return data.recipes.filter(r => {
    if (recipeMode(r) !== mode) return false;
    if (activeCategory !== 'Alle' && r.category !== activeCategory) return false;
    if (!q) return true;
    const hay = [r.title, r.category, ...(r.ingredients || [])].join(' ').toLowerCase();
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
  const items = groupedList();

  if (!data.recipes.length) {
    grid.innerHTML = `<div class="empty">Noch keine Rezepte geladen.<br>
      Tippe oben auf <strong>⟳</strong>, wenn du Internet hast.</div>`;
  } else if (!items.length) {
    grid.innerHTML = `<div class="empty">Nichts gefunden 🤷</div>`;
  }

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
      const meta = [r.category, r.time].filter(Boolean).join(' · ');
      info.innerHTML = `<div class="title">${titleWithEmoji(r)}</div>` +
        (meta ? `<div class="meta">${esc(meta)}</div>` : '');
      card.appendChild(info);
      card.onclick = () => openRecipe(r.id);
    }
    grid.appendChild(card);
  }

  // „＋ Neues Rezept“-Kachel, wenn Bearbeiten auf diesem Gerät aktiviert ist
  if (window.editorGridCard) {
    const addCard = window.editorGridCard();
    if (addCard) grid.appendChild(addCard);
  }

  $('#status').textContent = data.recipes.length
    ? `Stand: ${data.updated ? new Date(data.updated).toLocaleString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'} · ${data.recipes.length} Rezepte`
    : '';
}

/* ---------- Detailansicht ---------- */

function openRecipe(id, opts = {}) {
  renderDetail(id, opts);
  history.pushState({ view: 'recipe', id, random: !!opts.random }, '');
  // Auto-Check im Hintergrund
  checkAndUpdateIfNeeded();
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
  return `<div class="detail-photos">
      ${imgs.map(i => `<img class="detail-photo" src="${esc(i)}" alt="">`).join('')}
    </div>
    <div class="photo-dots">${imgs.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('')}</div>`;
}

function wirePhotoDots(el) {
  const strip = el.querySelector('.detail-photos');
  if (!strip) return;
  const dots = el.querySelectorAll('.photo-dots span');
  strip.addEventListener('scroll', () => {
    const i = Math.round(strip.scrollLeft / strip.clientWidth);
    dots.forEach((d, n) => d.classList.toggle('on', n === i));
  }, { passive: true });
}

function renderDetail(id, opts = {}) {
  const r = data.recipes.find(x => x.id === id);
  if (!r) return;
  const el = $('#detail');
  const meta = [r.category, r.time, r.servings].filter(Boolean).join(' · ');
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

function closeOverlay() {
  $('#detail').hidden = true;
  document.body.style.overflow = '';
}

// Zurück-Navigation: null = Übersicht, sonst Gruppe oder Rezept wiederherstellen
window.addEventListener('popstate', e => {
  const s = e.state;
  if (!s) return closeOverlay();
  if (s.view === 'group') renderGroup(s.group);
  else if (s.view === 'recipe') renderDetail(s.id, { random: s.random });
  else if (s.view === 'tinder') renderTinder();
  else if (s.view === 'tinder-result') renderTinderResult(s.ids || []);
  else if (s.view === 'tinder-result-recipe') renderTinderResult(s.ids || []);
});

/* ---------- Rezept-Tinder 🔥 ---------- */

let tinder = null; // { deck: [Rezepte], likes: [Rezepte] }

function openTinder() {
  renderTinder();
  history.pushState({ view: 'tinder' }, '');
}

function openWeekplan() {
  renderWeekplan();
  history.pushState({ view: 'weekplan' }, '');
}

const WEEKPLAN_KEY = 'rezeptbuch-weekplan';

function getWeekplan() {
  try {
    const stored = localStorage.getItem(WEEKPLAN_KEY);
    if (!stored) {
      return { mo: [], di: [], mi: [], do: [], fr: [], sa: [], so: [] };
    }
    const plan = JSON.parse(stored);
    // Konvertiere alte String-Format zu Array-Format
    const converted = {};
    for (const key in plan) {
      if (Array.isArray(plan[key])) {
        converted[key] = plan[key];
      } else if (plan[key]) {
        converted[key] = [plan[key]];
      } else {
        converted[key] = [];
      }
    }
    return converted;
  } catch (e) {
    return { mo: [], di: [], mi: [], do: [], fr: [], sa: [], so: [] };
  }
}

function saveWeekplan(plan) {
  localStorage.setItem(WEEKPLAN_KEY, JSON.stringify(plan));
}

let draggedTag = null;
let draggedElement = null;
let dragGhost = null;
let dragStartY = 0;

function updateGhostPosition(touch) {
  if (!dragGhost) return;
  const offsetY = touch.clientY - dragStartY;
  dragGhost.style.left = (touch.clientX - 60) + 'px';
  dragGhost.style.top = (touch.clientY - 15) + 'px';
}

function showMoveToMenu(draggedTag, currentDay) {
  const days = [
    { key: 'mo', label: 'Montag' },
    { key: 'di', label: 'Dienstag' },
    { key: 'mi', label: 'Mittwoch' },
    { key: 'do', label: 'Donnerstag' },
    { key: 'fr', label: 'Freitag' },
    { key: 'sa', label: 'Samstag' },
    { key: 'so', label: 'Sonntag' },
  ];

  const menu = document.createElement('div');
  menu.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: var(--card);
    border: 2px solid var(--accent);
    border-radius: 12px;
    padding: 16px;
    z-index: 1000;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    max-height: 80vh;
    overflow-y: auto;
  `;

  menu.innerHTML = '<h3 style="margin: 0 0 12px 0; text-align: center;">📍 Zu welchem Tag verschieben?</h3>';

  for (const day of days) {
    if (day.key === currentDay) continue;

    const btn = document.createElement('button');
    btn.style.cssText = `
      display: block;
      width: 100%;
      padding: 12px;
      margin: 6px 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      font-size: 16px;
      font-family: inherit;
    `;
    btn.textContent = day.label;
    btn.onclick = () => {
      performDragDrop(draggedTag.entry, draggedTag.sourceDay, day.key);
      menu.remove();
    };
    menu.appendChild(btn);
  }

  // Close on click outside
  menu.addEventListener('click', (e) => {
    if (e.target === menu) menu.remove();
  });

  document.body.appendChild(menu);
  setTimeout(() => menu.focus(), 100);
}

function attachTagHandlers(selectedDiv, dayKey) {
  // Remove-Button Handler - direkt auf jedem Button registrieren
  for (const removeBtn of selectedDiv.querySelectorAll('.weekplan-tag-remove')) {
    removeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = removeBtn.dataset.entry;
      const currentDayKey = removeBtn.dataset.day;
      const idx = weekplan[currentDayKey].indexOf(entry);
      if (idx > -1) {
        weekplan[currentDayKey].splice(idx, 1);
        saveWeekplan(weekplan);
        removeBtn.closest('.weekplan-tag').remove();
      }
    };
  }

  // Drag-Start & Touch-Start Handler
  for (const tag of selectedDiv.querySelectorAll('.weekplan-tag')) {
    // Mouse Drag
    tag.ondragstart = (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('entry', tag.dataset.entry);
      e.dataTransfer.setData('sourceDay', dayKey);
      tag.style.opacity = '0.5';
    };

    tag.ondragend = (e) => {
      tag.style.opacity = '1';
    };

    // Touch Support für Handy - Visuelles Drag & Drop
    tag.ontouchstart = (e) => {
      draggedTag = { tag, entry: tag.dataset.entry, sourceDay: dayKey };
      draggedElement = e.target.closest('.weekplan-tag');
      dragStartY = e.touches[0].clientY;

      // Erstelle Ghost-Element
      dragGhost = draggedElement.cloneNode(true);
      dragGhost.style.cssText = `
        position: fixed;
        z-index: 10000;
        opacity: 0.8;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        transform: scale(1.05);
      `;
      document.body.appendChild(dragGhost);
      draggedElement.style.opacity = '0.3';

      // Update Ghost Position
      updateGhostPosition(e.touches[0]);
    };

    tag.ontouchmove = (e) => {
      if (!dragGhost) return;
      e.preventDefault();
      updateGhostPosition(e.touches[0]);
    };

    tag.ontouchend = (e) => {
      if (!dragGhost) return;

      const endY = e.changedTouches[0].clientY;
      const endX = e.changedTouches[0].clientX;

      // Suche SOFORT das Ziel-Element BEVOR wir den Ghost entfernen
      // (damit elementFromPoint noch die echten Elemente unter den Koordinaten findet)
      let targetDay = null;

      // Temporär Ghost unsichtbar machen statt zu entfernen
      dragGhost.style.pointerEvents = 'none';
      dragGhost.style.display = 'none';

      // Jetzt können wir elementFromPoint nutzen
      let element = document.elementFromPoint(endX, endY);
      console.log('elementFromPoint result:', element?.tagName, element?.className, 'at', endX, endY);

      targetDay = element?.closest('.weekplan-day')?.dataset.day;
      console.log('targetDay found:', targetDay);

      // Ghost aufräumen
      dragGhost.remove();
      dragGhost = null;

      draggedElement.style.opacity = '1';

      // Verschiebe wenn anderer Tag gefunden
      if (targetDay && targetDay !== dayKey) {
        console.log('Verschiebe von', dayKey, 'zu', targetDay);
        performDragDrop(draggedTag.entry, draggedTag.sourceDay, targetDay);
      } else {
        console.log('Keine Verschiebung nötig oder kein Tag gefunden');
      }

      draggedTag = null;
      draggedElement = null;
    };
  }
}

function renderWeekplan() {
  const el = $('#detail');
  const weekplan = getWeekplan();
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
  for (const day of days) {
    const entries = weekplan[day.key] || [];
    let tagsHTML = '';

    for (const entry of entries) {
      let displayName = '';
      if (entry.startsWith('TEXT:')) {
        displayName = entry.substring(5);
      } else {
        const recipe = data.recipes.find(r => r.id === entry);
        displayName = recipe ? titleWithEmoji(recipe) : '';
      }

      if (displayName) {
        tagsHTML += `<span class="weekplan-tag" draggable="true" data-entry="${esc(entry)}" data-day="${day.key}">${esc(displayName)}</span>`;
      }
    }

    daysHTML += `
      <div class="weekplan-day" data-day="${day.key}" draggable="true">
        <label class="weekplan-label">${day.label}</label>
        <div class="weekplan-autocomplete" data-day="${day.key}">
          <div class="weekplan-input-row">
            <input type="text" class="weekplan-search" placeholder="Rezept suchen..." autocomplete="off">
            <button class="weekplan-add-btn" title="Freitext hinzufügen">+</button>
          </div>
          <div class="weekplan-suggestions" hidden></div>
          <div class="weekplan-selected">${tagsHTML}</div>
        </div>
      </div>`;
  }

  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="detail-body group-body">
      <h2>📅 Wochenplan</h2>
      <div class="weekplan-container">
        ${daysHTML}
      </div>
      <button class="weekplan-save-btn">💾 Speichern</button>
    </div>`;

  el.querySelector('.detail-close').onclick = () => closeOverlay();

  // Autocomplete Setup
  for (const dayEl of el.querySelectorAll('.weekplan-autocomplete')) {
    const dayKey = dayEl.dataset.day;
    const searchInput = dayEl.querySelector('.weekplan-search');
    const addBtn = dayEl.querySelector('.weekplan-add-btn');
    const suggestionsDiv = dayEl.querySelector('.weekplan-suggestions');
    const selectedDiv = dayEl.querySelector('.weekplan-selected');

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

      // Zeige Vorschläge
      suggestionsDiv.innerHTML = matches.map(r => `
        <div class="weekplan-suggestion" data-id="${esc(r.id)}">
          ${emojiFor(r)} ${esc(titleWithEmoji(r))}
        </div>
      `).join('');
      suggestionsDiv.hidden = false;

      // Click Handler für Vorschläge
      for (const suggEl of suggestionsDiv.querySelectorAll('.weekplan-suggestion')) {
        suggEl.onclick = () => {
          const recipeId = suggEl.dataset.id;
          const recipe = data.recipes.find(r => r.id === recipeId);

          // Füge zu Array hinzu statt zu ersetzen
          if (!weekplan[dayKey]) weekplan[dayKey] = [];
          weekplan[dayKey].push(recipeId);

          // Update UI: neues Tag hinzufügen
          const tagHTML = `<span class="weekplan-tag" draggable="true" data-entry="${esc(recipeId)}">${esc(titleWithEmoji(recipe))} <button class="weekplan-tag-remove" data-entry="${esc(recipeId)}">✕</button></span>`;
          selectedDiv.insertAdjacentHTML('beforeend', tagHTML);

          searchInput.value = '';
          suggestionsDiv.hidden = true;
          attachTagHandlers(selectedDiv, dayKey);
        };
      }
    });

    // Add-Button für Freitext
    addBtn.onclick = () => {
      const text = searchInput.value.trim();
      if (!text) return;

      // Füge zu Array hinzu statt zu ersetzen
      if (!weekplan[dayKey]) weekplan[dayKey] = [];
      const entry = 'TEXT:' + text;
      weekplan[dayKey].push(entry);

      // Update UI: neues Tag hinzufügen
      const tagHTML = `<span class="weekplan-tag" draggable="true" data-entry="${esc(entry)}">${esc(text)} <button class="weekplan-tag-remove" data-entry="${esc(entry)}">✕</button></span>`;
      selectedDiv.insertAdjacentHTML('beforeend', tagHTML);

      searchInput.value = '';
      suggestionsDiv.hidden = true;
      attachTagHandlers(selectedDiv, dayKey);
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

    // Reset zoom nach Blur (iOS Safari)
    searchInput.addEventListener('blur', () => {
      // Warte bis Tastatur weg ist
      setTimeout(() => {
        // Zoom zurücksetzen
        document.body.style.zoom = '100%';
        document.documentElement.style.zoom = '100%';
        window.scrollTo(0, 0);

        // Viewport Meta Tag update
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
          viewport.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
        }
      }, 200);
    });

    // Attach handlers für bestehende Tags
    attachTagHandlers(selectedDiv, dayKey);
  }

  // Drag & Drop Handler für Tage
  for (const dayEl of el.querySelectorAll('.weekplan-day')) {
    const dayKey = dayEl.dataset.day;
    const selectedDiv = dayEl.querySelector('.weekplan-selected');

    // Drag Over (Mouse) - auf der ganzen dayEl
    dayEl.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      selectedDiv.style.background = 'rgba(232, 89, 12, 0.1)';
    };

    dayEl.ondragleave = (e) => {
      selectedDiv.style.background = '';
    };

    // Drop (Mouse) - auf der selectedDiv
    selectedDiv.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedDiv.style.background = '';

      const entry = e.dataTransfer.getData('entry');
      const sourceDay = e.dataTransfer.getData('sourceDay');

      if (!entry || !sourceDay) return;
      performDragDrop(entry, sourceDay, dayKey);
    };

    // Drop auch auf dayEl fallback
    dayEl.ondrop = (e) => {
      if (!e.dataTransfer.getData('entry')) return;
      e.preventDefault();
      e.stopPropagation();
      selectedDiv.style.background = '';

      const entry = e.dataTransfer.getData('entry');
      const sourceDay = e.dataTransfer.getData('sourceDay');

      if (!entry || !sourceDay) return;
      performDragDrop(entry, sourceDay, dayKey);
    };

    // Touch Support für Handy
    dayEl.ontouchend = (e) => {
      if (!draggedTag) return;
      e.preventDefault();
      selectedDiv.style.background = '';
      performDragDrop(draggedTag.entry, draggedTag.sourceDay, dayKey);
    };

    dayEl.ontouchover = (e) => {
      if (draggedTag) {
        selectedDiv.style.background = 'rgba(232, 89, 12, 0.1)';
      }
    };
  }

  function performDragDrop(entry, sourceDay, targetDay) {
    if (!entry || !sourceDay) return;

    // Entferne von Source
    if (weekplan[sourceDay]) {
      const idx = weekplan[sourceDay].indexOf(entry);
      if (idx > -1) {
        weekplan[sourceDay].splice(idx, 1);
      }
    }

    // Füge zu Target hinzu (ohne Duplikat)
    if (!weekplan[targetDay]) weekplan[targetDay] = [];
    if (!weekplan[targetDay].includes(entry)) {
      weekplan[targetDay].push(entry);
    }

    // Re-render Wochenplan um Changes zu zeigen
    renderWeekplan();
  }

  // Save Button
  el.querySelector('.weekplan-save-btn').onclick = () => {
    saveWeekplan(weekplan);
    toast('✅ Wochenplan gespeichert');
  };

  el.hidden = false;
  document.body.style.overflow = 'hidden';
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
      <div class="t-meta">${esc([r.category, r.time].filter(Boolean).join(' · '))}</div>
    </div>
    <div class="t-badge like">WILL ICH 😍</div>
    <div class="t-badge nope">NÖ 🙅</div>
    <div class="t-card-badge-text like-text">WILL ICH 😍</div>
    <div class="t-card-badge-text nope-text">NÖ 🙅</div>
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
        ${next ? tinderCardHTML(next, 'behind') : ''}
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
  let startX = 0, startY = 0, dx = 0, dragging = false, done = false;
  const badgeLike = card.querySelector('.t-badge.like');
  const badgeNope = card.querySelector('.t-badge.nope');
  const img = card.querySelector('img');

  card.addEventListener('pointerdown', e => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    card.style.transition = 'none';
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* synthetische Events */ }
  });

  card.addEventListener('pointermove', e => {
    if (!dragging || done) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy * 0.3}px) rotate(${dx / 12}deg)`;
    // Stempel wächst und wird kräftiger, je weiter man zieht (wie bei Tinder)
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
    // Foto wird je weiter raus gezogen dunkler (ausgrauen)
    if (img) {
      const fadeStrength = Math.min(0.5, Math.abs(dx) / 200);
      img.style.filter = `brightness(${1 - fadeStrength * 0.7})`;
    }
  });

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
      // Foto zurück auf normal
      if (img) {
        img.style.filter = 'brightness(1)';
      }
    }
    dx = 0;
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
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
        <h2>Eure Top ${winners.length} ❤️</h2>
        <div class="detail-meta">Wer gewinnt?</div>

        <div class="slot-machine" id="slot-container" style="display:none;">
          <div class="slots">${winners.map((w, i) => {
            const degPerItem = 360 / winners.length;
            const deg = i * degPerItem;
            return `<div class="slot-item" style="transform: rotateX(${deg}deg) translateZ(300px);">${titleWithEmoji(w)}</div>`;
          }).join('')}</div>
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

function spinSlot(winners) {
  const btn = $('#slot-btn');
  const container = $('#slot-container');
  const slots = container.querySelector('.slots');
  btn.disabled = true;
  btn.textContent = '⏳ …';

  const pick = Math.floor(Math.random() * winners.length);
  let count = 0;
  const maxSpins = 25 + Math.random() * 15;
  const itemHeight = 140; // muss mit CSS .slot-item height übereinstimmen

  const animate = () => {
    if (count < maxSpins) {
      // Rad-Rotation: jedes Item ist 360/winners.length Grad
      const degPerItem = 360 / winners.length;
      const rotation = (count % winners.length) * degPerItem;
      slots.style.transform = `rotateX(${rotation}deg)`;
      slots.style.transition = 'none';
      count++;
      const delay = Math.min(35, 15 + count * 1.5);
      setTimeout(animate, delay);
    } else {
      // Final spin zur gewählten Position
      const degPerItem = 360 / winners.length;
      const finalRotation = (pick * degPerItem) + (3 * 360); // 3 volle Umdrehungen + Ziel
      slots.style.transition = `transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1)`;
      slots.style.transform = `rotateX(${finalRotation}deg)`;
      setTimeout(() => {
        btn.textContent = '✨ ' + titleWithEmoji(winners[pick]);
        btn.disabled = false;
        btn.onclick = () => {
          renderDetail(winners[pick].id);
          history.pushState({ view: 'tinder-result-recipe', ids: winners.map(w => w.id), winnerIndex: pick }, '');
        };
      }, 750);
    }
  };
  animate();
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
const EDIT_ENABLED_KEY = 'rezeptbuch-edit-enabled';

function isEditModeEnabled() {
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

// Theme beim Start laden
(() => {
  const saved = localStorage.getItem(THEME_KEY) || 'auto';
  applyTheme(saved);
})();

function openSettings() {
  const hasToken = ghToken && ghToken();
  const lastUpdate = localStorage.getItem(LAST_UPDATE_KEY) || '—';
  const editEnabled = localStorage.getItem(EDIT_ENABLED_KEY) !== 'false' && hasToken;
  const currentTheme = localStorage.getItem(THEME_KEY) || 'auto';

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

    <div class="settings-section">
      <h3>Bearbeiten</h3>
      ${hasToken
        ? `<div class="settings-row">
            <label class="setting-label">
              <input type="checkbox" id="edit-toggle" ${editEnabled ? 'checked' : ''}>
              <span>Bearbeitungsmodus aktiviert</span>
            </label>
            <div class="setting-hint">Token ist gespeichert – schalte Bearbeiten an/aus</div>
          </div>
          <button class="setting-btn" id="clear-token">Token entfernen</button>
          <button class="setting-btn" id="share-token">🔗 Token teilen</button>`
        : `<button class="setting-btn" id="setup-token">Token einrichten</button>`}
    </div>

    <button class="setting-btn primary" id="refresh-btn">⟳ Update</button>
    <div class="update-status"></div>

    <div class="setting-info">
      <div><strong>Zuletzt aktualisiert:</strong> ${(() => {
        if (data.updated) {
          const date = new Date(data.updated).toLocaleString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          return date;
        }
        return 'Noch nie';
      })()}</div>
      <div><strong>Rezepte:</strong> ${data.recipes.length}</div>
      <div><strong>App aktualisiert:</strong> ${lastUpdate}</div>
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
      // Lade frische Version vom Server zum Vergleichen
      const res = await fetch('data/recipes.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const fresh = await res.json();

      // Prüfe ob es ein Update gibt (NUR auf updated Timestamp achten, nicht auf Version!)
      const hasUpdates = await checkAndUpdateIfNeeded();

      // IMMER Cache löschen beim Update-Button
      showToastWithoutTimeout('🗑️ Cache wird geleert...');

      // Lösche ALLE Caches aggressiv
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
        console.log('✓ Alle Caches gelöscht');
      }

      // Unregister alle Service Workers
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
        console.log('✓ Service Worker unregistriert');
      }

      // Warte kurz dann neu registrieren
      await new Promise(r => setTimeout(r, 500));

      // Service Worker neu registrieren mit Timestamp
      if ('serviceWorker' in navigator) {
        try {
          await navigator.serviceWorker.register('/sw.js?t=' + Date.now());
          console.log('✓ Service Worker neu registriert');
        } catch (e) {
          console.log('Service Worker registrieren fehlgeschlagen:', e);
        }
      }

      // Speichere Timestamp statt Version
      localStorage.setItem(LAST_UPDATED_KEY, fresh.updated);

      // Feedback
      if (hasUpdates) {
        // Zeige Reload-Dialog
        const reloadDialog = document.createElement('div');
        reloadDialog.style.cssText = `
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: var(--card);
          border: 3px solid var(--accent);
          border-radius: 12px;
          padding: 24px;
          z-index: 2000;
          text-align: center;
          max-width: 300px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        `;
        reloadDialog.innerHTML = `
          <h3 style="margin: 0 0 12px 0; color: var(--accent);">✨ Update verfügbar!</h3>
          <p style="margin: 0 0 12px 0; color: var(--text);">🔄 Neue Rezepte bereit zum Laden.</p>
          <button id="reload-now" style="
            padding: 12px 24px;
            margin: 8px;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            font-family: inherit;
          ">🔄 Jetzt neu laden</button>
        `;
        document.body.appendChild(reloadDialog);

        document.getElementById('reload-now').onclick = async () => {
          // Totales Reload mit URL Parameter um HTTP Cache zu umgehen
          const randomParam = '?t=' + Date.now() + '&r=' + Math.random();
          window.location.href = window.location.pathname + randomParam;
        };
      } else {
        toast('✅ Alles auf aktuellem Stand');
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

  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';

  // Auto-Check für Updates beim Öffnen der Settings
  (async () => {
    try {
      const res = await fetch('data/recipes.json?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const fresh = await res.json();
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
  $('#search').focus();
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

// FORCE-RELOAD beim Start: überprüfe ob Updates da sind BEVOR wir was anzeigen
(async () => {
  let shouldReload = false;
  let reloadReason = '';

  // 1. Überprüfe APP-VERSION (Funktionalitäten, nicht Rezepte!)
  const lastAppVersion = localStorage.getItem(LAST_APP_VERSION_KEY);
  if (lastAppVersion !== APP_BUILD_VERSION) {
    shouldReload = true;
    reloadReason = `App-Version geändert: ${lastAppVersion} → ${APP_BUILD_VERSION}`;
    console.log('🔄 FORCE-REFRESH: ' + reloadReason);
  }

  // 2. Überprüfe REZEPTE-TIMESTAMP (falls App-Version gleich)
  if (!shouldReload) {
    try {
      const res = await fetch('data/recipes.json?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const fresh = await res.json();
        const stored = localStorage.getItem(DATA_KEY);

        if (stored) {
          const oldData = JSON.parse(stored);
          // Parse ISO Timestamps für zuverlässigen Vergleich (ignoriere Format-Unterschiede)
          const oldDate = new Date(oldData.updated).getTime();
          const freshDate = new Date(fresh.updated).getTime();

          if (freshDate !== oldDate) {
            shouldReload = true;
            reloadReason = `Rezepte geändert: ${oldData.updated} → ${fresh.updated}`;
            console.log('🔄 FORCE-REFRESH: ' + reloadReason);
          }
        }
      }
    } catch (e) {
      console.log('ℹ️ Rezepte-Check fehlgeschlagen (offline?)');
    }
  }

  // 3. Führe FORCE-RELOAD durch wenn nötig
  if (shouldReload) {
    console.log('  Grund:', reloadReason);
    localStorage.removeItem(DATA_KEY);
    localStorage.setItem(LAST_APP_VERSION_KEY, APP_BUILD_VERSION);

    // Service Worker unregistrieren
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      } catch (e) { console.log('SW unregister error:', e); }
    }

    // Caches löschen
    if ('caches' in window) {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      } catch (e) { console.log('Cache delete error:', e); }
    }

    // FORCE RELOAD mit Cache-Buster
    console.log('💥 Force-Reload mit Cache-Buster!');
    window.location.href = window.location.pathname + '?force=' + Date.now() + '&r=' + Math.random();
    return;
  }

  // Speichere aktuelle App-Version
  localStorage.setItem(LAST_APP_VERSION_KEY, APP_BUILD_VERSION);

  // Wenn KEIN Update: normal laden
  renderModeUI();
  loadLocal();
  render();
})();

// Beim Start immer nach Updates checken (nicht nur beim Erststart)
// Das sorgt dafür, dass auch gekachte alte Versionen aktualisiert werden
update(false);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js?t=' + Date.now()).catch(e => console.log('SW register error:', e));
}

// Swipe-to-back Geste: von links nach rechts wischen
let swipeStart = null;
const swipeTarget = () => $('#detail').hidden ? $('#editor') : $('#detail');

document.addEventListener('pointerdown', (e) => {
  if (e.clientX < 50) swipeStart = e.clientX;
}, false);

document.addEventListener('pointermove', (e) => {
  if (!swipeStart) return;
  const swipeDistance = e.clientX - swipeStart;
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

  // Wenn genug geswipet wurde: schließen
  if (swipeDistance > 100 && e.clientX < 200) {
    swipeStart = null;
    target.style.transform = '';
    target.style.opacity = '';
    target.hidden = true;
    document.body.style.overflow = '';
  }
}, false);

document.addEventListener('pointerup', () => {
  if (swipeStart) {
    swipeStart = null;
    const target = swipeTarget();
    target.style.transform = '';
    target.style.opacity = '';
  }
}, false);
