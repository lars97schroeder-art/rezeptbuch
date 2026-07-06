'use strict';

const DATA_KEY = 'rezeptbuch-data';
const IMG_CACHE = 'rezept-bilder-v1';

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
    if (raw) data = JSON.parse(raw);
  } catch (e) { /* kaputte Daten ignorieren, Update holt frische */ }
}

function saveLocal() {
  localStorage.setItem(DATA_KEY, JSON.stringify(data));
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
    saveLocal();
    render();

    // Vergleiche alte und neue Daten und erstelle Update-Nachricht
    const messages = [];

    // Check für neue Version
    if (fresh.version !== oldData.version) {
      messages.push(`✅ Update: v${fresh.version}`);
    }

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
  const cats = [...new Set(inMode.map(r => r.category).filter(Boolean))];
  cats.sort((a, b) => a.localeCompare(b, 'de'));
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
    ? `Stand: ${data.updated || '–'} · ${data.recipes.length} Rezepte`
    : '';
}

/* ---------- Detailansicht ---------- */

function openRecipe(id, opts = {}) {
  renderDetail(id, opts);
  history.pushState({ view: 'recipe', id, random: !!opts.random }, '');
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

function renderWeekplan() {
  const el = $('#detail');
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="detail-body group-body">
      <h2>📅 Wochenplan</h2>
      <div class="detail-meta">Kommt bald... 🚀</div>
    </div>`;
  el.querySelector('.detail-close').onclick = () => closeOverlay();
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
    history.pushState({ view: 'tinder-result-recipe', from: 'superlike' }, '');
  }, 2500);
}

function flyOut(card, dir) {
  // Passenden Stempel groß einblenden, dann Karte rausfliegen lassen
  const badge = card.querySelector(dir > 0 ? '.t-badge.like' : '.t-badge.nope');
  badge.style.opacity = 1;
  badge.style.transform = `rotate(${dir > 0 ? -14 : 14}deg) scale(1.15)`;
  card.style.transition = 'transform 0.6s ease, opacity 0.6s ease';
  card.style.transform = `translate(${dir * 120}vw, -40px) rotate(${dir * 30}deg)`;
  card.style.opacity = '0';
  setTimeout(() => swipeTinder(dir), 550);
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
      <h3>Bearbeiten</h3>
      ${hasToken
        ? `<div class="settings-row">
            <label class="setting-label">
              <input type="checkbox" id="edit-toggle" ${editEnabled ? 'checked' : ''}>
              <span>Bearbeitungsmodus aktiviert</span>
            </label>
            <div class="setting-hint">Token ist gespeichert – schalte Bearbeiten an/aus</div>
          </div>
          <button class="setting-btn" id="clear-token">Token entfernen</button>`
        : `<button class="setting-btn" id="setup-token">Token einrichten</button>`}
    </div>

    <button class="setting-btn primary" id="refresh-btn">⟳ Update</button>

    <div class="setting-info">
      <div><strong>Stand:</strong> v${data.version} (${data.updated})</div>
      <div><strong>Rezepte:</strong> ${data.recipes.length}</div>
      <div><strong>Letztes Update:</strong> ${lastUpdate}</div>
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

  el.querySelector('#clear-token')?.addEventListener('click', () => {
    if (window.clearToken) {
      window.clearToken();
      openSettings();
    }
  });

  el.querySelector('#setup-token')?.addEventListener('click', () => {
    el.hidden = true;
    document.body.style.overflow = '';
    if (window.openTokenSetup) window.openTokenSetup();
  });

  el.querySelector('#refresh-btn').onclick = async () => {
    showToastWithoutTimeout('Aktualisiere App...');
    try {
      // Lösche alle Caches
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.filter(name => name.startsWith('rezeptbuch-') || name.startsWith('rezept-')).map(name => caches.delete(name)));

      // Update Service Worker
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }

      // Update Datenbank
      await update();

      // Neu laden
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      toast('Fehler beim Update: ' + err.message);
    }
  };

  // Theme-Switcher
  for (const radio of el.querySelectorAll('input[name="theme"]')) {
    radio.onchange = () => applyTheme(radio.value);
  }

  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
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

renderModeUI();
loadLocal();
render();
if (!data.recipes.length) update(false); // Erststart: still versuchen zu laden

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
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
