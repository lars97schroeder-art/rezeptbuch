'use strict';

const DATA_KEY = 'rezeptbuch-data';
const IMG_CACHE = 'rezept-bilder-v1';

const CATEGORY_EMOJI = {
  'Pasta': '🍝', 'Nudeln': '🍝', 'Suppe': '🍲', 'Salat': '🥗',
  'Fleisch': '🥩', 'Fisch': '🐟', 'Vegetarisch': '🥦', 'Vegan': '🌱',
  'Dessert': '🍰', 'Süßes': '🍮', 'Backen': '🥐', 'Frühstück': '🍳',
  'Auflauf': '🥘', 'Asiatisch': '🍜', 'Pizza': '🍕', 'Snack': '🥪',
};

let data = { version: 0, updated: '', recipes: [] };
let activeCategory = 'Alle';
let query = '';

const $ = s => document.querySelector(s);

function emojiFor(recipe) {
  return CATEGORY_EMOJI[recipe.category] || '🍽️';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (raw) data = JSON.parse(raw);
  } catch (e) { /* kaputte Daten ignorieren, Update holt frische */ }
}

function saveLocal() {
  localStorage.setItem(DATA_KEY, JSON.stringify(data));
}

/* ---------- Aktualisieren ---------- */

async function update(showErrors = true) {
  const btn = $('#btn-update');
  btn.classList.add('spinning');
  try {
    const res = await fetch('data/recipes.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const fresh = await res.json();

    // Neue Bilder herunterladen, damit alles offline verfügbar ist.
    // Bilddateien haben versionierte Namen: was schon im Cache liegt, bleibt.
    const cache = await caches.open(IMG_CACHE);
    const wanted = new Set();
    for (const r of fresh.recipes) {
      if (!r.image) continue;
      wanted.add(new URL(r.image, location.href).href);
      if (await cache.match(r.image)) continue;
      try {
        const imgRes = await fetch(r.image, { cache: 'no-store' });
        if (imgRes.ok) await cache.put(r.image, imgRes);
      } catch (e) { /* einzelnes Bild fehlgeschlagen – beim nächsten Update erneut */ }
    }
    // Nicht mehr benötigte Bilder aufräumen
    for (const req of await cache.keys()) {
      if (!wanted.has(req.url)) await cache.delete(req);
    }

    const changed = fresh.version !== data.version;
    data = fresh;
    saveLocal();
    render();
    toast(changed ? `Aktualisiert – ${data.recipes.length} Rezepte ✓` : 'Alles schon aktuell ✓');
  } catch (e) {
    if (showErrors) toast('Keine Verbindung – gespeicherte Rezepte bleiben da 📴');
  } finally {
    btn.classList.remove('spinning');
  }
}

/* ---------- Anzeige ---------- */

function categories() {
  const cats = [...new Set(data.recipes.map(r => r.category).filter(Boolean))];
  cats.sort((a, b) => a.localeCompare(b, 'de'));
  return ['Alle', ...cats];
}

function filtered() {
  const q = query.trim().toLowerCase();
  return data.recipes.filter(r => {
    if (activeCategory !== 'Alle' && r.category !== activeCategory) return false;
    if (!q) return true;
    const hay = [r.title, r.category, ...(r.ingredients || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
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
  const list = filtered();

  if (!data.recipes.length) {
    grid.innerHTML = `<div class="empty">Noch keine Rezepte geladen.<br>
      Tippe oben auf <strong>⟳</strong>, wenn du Internet hast.</div>`;
  } else if (!list.length) {
    grid.innerHTML = `<div class="empty">Nichts gefunden 🤷</div>`;
  }

  for (const r of list) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = r.image
      ? `<img class="photo" src="${esc(r.image)}" alt="" loading="lazy">`
      : `<div class="photo placeholder">${emojiFor(r)}</div>`;
    const info = document.createElement('div');
    info.className = 'info';
    const meta = [r.category, r.time].filter(Boolean).join(' · ');
    info.innerHTML = `<div class="title">${esc(r.title)}</div>` +
      (meta ? `<div class="meta">${esc(meta)}</div>` : '');
    card.appendChild(info);
    card.onclick = () => openRecipe(r.id);
    grid.appendChild(card);
  }

  $('#status').textContent = data.recipes.length
    ? `Stand: ${data.updated || '–'} · ${data.recipes.length} Rezepte`
    : '';
}

/* ---------- Detailansicht ---------- */

function openRecipe(id) {
  const r = data.recipes.find(x => x.id === id);
  if (!r) return;
  const el = $('#detail');
  const meta = [r.category, r.time, r.servings].filter(Boolean).join(' · ');
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    ${r.image
      ? `<img class="detail-photo" src="${esc(r.image)}" alt="">`
      : `<div class="detail-photo placeholder">${emojiFor(r)}</div>`}
    <div class="detail-body">
      <h2>${esc(r.title)}</h2>
      ${meta ? `<div class="detail-meta">${esc(meta)}</div>` : ''}
      ${(r.ingredients || []).length ? `<h3>Zutaten</h3>
        <ul>${r.ingredients.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${(r.steps || []).length ? `<h3>Zubereitung</h3>
        <ol>${r.steps.map(s => `<li><span>${esc(s)}</span></li>`).join('')}</ol>` : ''}
      ${r.notes ? `<div class="detail-notes">💡 ${esc(r.notes)}</div>` : ''}
    </div>`;
  el.querySelector('.detail-close').onclick = () => history.back();
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  history.pushState({ recipe: id }, '');
}

function closeDetail() {
  $('#detail').hidden = true;
  document.body.style.overflow = '';
}

window.addEventListener('popstate', closeDetail);

/* ---------- Toast ---------- */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- Start ---------- */

$('#btn-update').onclick = () => update();

$('#btn-random').onclick = () => {
  const list = filtered();
  if (!list.length) return toast('Keine Rezepte da 🤷');
  openRecipe(list[Math.floor(Math.random() * list.length)].id);
};

$('#search').addEventListener('input', e => {
  query = e.target.value;
  render();
});

loadLocal();
render();
if (!data.recipes.length) update(false); // Erststart: still versuchen zu laden

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
