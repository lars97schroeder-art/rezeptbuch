'use strict';

/* Bearbeiten-Modus fürs Handy: schreibt Änderungen direkt ins GitHub-Repo.
   Braucht einmalig einen GitHub-Token (Einrichtung über den ✏️-Knopf oben).
   Der Token bleibt nur auf diesem Gerät gespeichert (localStorage). */

const GH_REPO = 'lars97schroeder-art/rezeptbuch';
const TOKEN_KEY = 'rezeptbuch-token';

const ghToken = () => localStorage.getItem(TOKEN_KEY) || '';

window.clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  render();
  toast('Token entfernt');
};

/* ---------- GitHub-API ---------- */

function ghHeaders() {
  return {
    'Authorization': 'token ' + ghToken(),
    'Accept': 'application/vnd.github+json',
  };
}

async function ghGet(path) {
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(path)}?ref=main&t=${Date.now()}`,
    { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error('GitHub-Fehler ' + res.status);
  return res.json();
}

async function ghPut(path, base64Content, message, sha) {
  const body = { message, content: base64Content, branch: 'main' };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(path)}`,
    { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error('GitHub-Fehler ' + res.status + ' bei ' + path);
  return res.json();
}

async function ghDeleteFile(path, message) {
  try {
    const info = await ghGet(path);
    await fetch(
      `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(path)}`,
      { method: 'DELETE', headers: ghHeaders(),
        body: JSON.stringify({ message, sha: info.sha, branch: 'main' }) });
  } catch (e) { /* Aufräumen ist optional – nicht referenzierte Dateien stören nicht */ }
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function utf8b64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function dataUrlToBlob(dataUrl) {
  const bin = atob(dataUrl.split(',')[1]);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/jpeg' });
}

/* ---------- Helfer ---------- */

function slugify(title) {
  let t = title.toLowerCase();
  for (const [a, b] of [['ä', 'ae'], ['ö', 'oe'], ['ü', 'ue'], ['ß', 'ss'], ['à', 'a'], ['é', 'e']]) {
    t = t.split(a).join(b);
  }
  t = t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return t || 'rezept';
}

// Foto im Browser verkleinern (max. 1200px, JPEG)
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto konnte nicht gelesen werden')); };
    img.src = url;
  });
}

/* ---------- Editor-Oberfläche ---------- */

const edEl = () => $('#editor');
let edKeep = [];   // vorhandene Fotos (Pfade)
let edNeu = [];    // neue Fotos (data:-URLs)
let edBusy = false;

function closeEditor() {
  edEl().hidden = true;
  if ($('#detail').hidden) document.body.style.overflow = '';
}

window.addEventListener('popstate', closeEditor);

function edPhotoListHTML() {
  const thumb = (src, typ, i) => `
    <span class="ed-thumb">
      <img src="${esc(src)}" alt="">
      <button type="button" class="ed-x" data-typ="${typ}" data-i="${i}">✕</button>
    </span>`;
  return edKeep.map((p, i) => thumb(p, 'keep', i)).join('')
    + edNeu.map((d, i) => thumb(d, 'neu', i)).join('');
}

function renderEdPhotos() {
  $('#ed-photos').innerHTML = edPhotoListHTML();
  for (const b of $('#ed-photos').querySelectorAll('.ed-x')) {
    b.onclick = () => {
      (b.dataset.typ === 'keep' ? edKeep : edNeu).splice(Number(b.dataset.i), 1);
      renderEdPhotos();
    };
  }
}

function openEditor(id) {
  // Blockiere Bearbeitung im Offline-Modus
  if (localStorage.getItem('rezeptbuch-offline-mode') === 'true') {
    toast('🔒 Im Offline-Modus: Bearbeiten nicht möglich');
    return;
  }

  // Auto-Check: Falls bestehendes Rezept, checke auf Updates
  if (id) {
    window.checkAndUpdateIfNeeded?.();
  }

  const r = id ? data.recipes.find(x => x.id === id) : null;
  edKeep = r ? [...imagesOf(r)] : [];
  edNeu = [];
  const cats = [...new Set(data.recipes.flatMap(x => Array.isArray(x.category) ? x.category : (x.category ? [x.category] : [])).filter(Boolean))];
  const groups = [...new Set(data.recipes.map(x => x.group).filter(Boolean))];
  const bereich = r ? (r.bereich || 'kochen') : mode;

  const el = edEl();
  el.innerHTML = `
  <button class="detail-close ed-close" aria-label="Zurück">←</button>
  <div class="ed-body">
    <h2>${r ? 'Rezept bearbeiten' : 'Neues Rezept'}</h2>
    <div class="ed-field"><label>Titel *</label>
      <input id="ed-title" value="${r ? esc(r.title) : ''}"></div>
    <div class="ed-row">
      <div class="ed-field"><label>Bereich</label>
        <select id="ed-bereich">
          <option value="kochen"${bereich === 'kochen' ? ' selected' : ''}>🍳 Kochen</option>
          <option value="backen"${bereich === 'backen' ? ' selected' : ''}>🧁 Backen</option>
          <option value="fruehstueck"${bereich === 'fruehstueck' ? ' selected' : ''}>🥐 Frühstück</option>
        </select></div>
      <div class="ed-field"><label>Kategorien</label>
        <div id="ed-categories-container" class="ed-categories-container"></div></div>
    </div>
    <div class="ed-row">
      <div class="ed-field"><label>Emoji</label>
        <input id="ed-emoji" placeholder="🍕" value="${r ? esc(r.emoji || '') : ''}"></div>
      <div class="ed-field"><label>Gruppe</label>
        <div id="ed-groups-container" class="ed-groups-container"></div></div>
    </div>
    <div class="ed-row">
      <div class="ed-field"><label>Zeit</label>
        <input id="ed-time" placeholder="z. B. 30 Min." value="${r ? esc(r.time) : ''}"></div>
      <div class="ed-field"><label>Portionen</label>
        <input id="ed-servings" placeholder="z. B. 2 Portionen" value="${r ? esc(r.servings) : ''}"></div>
    </div>
    <div class="ed-field"><label>Zutaten (eine pro Zeile)</label>
      <textarea id="ed-ingredients" rows="6">${r ? esc((r.ingredients || []).join('\n')) : ''}</textarea></div>
    <div class="ed-field"><label>Zubereitung (ein Schritt pro Zeile)</label>
      <textarea id="ed-steps" rows="7">${r ? esc((r.steps || []).join('\n')) : ''}</textarea></div>
    <div class="ed-field"><label>Notizen</label>
      <input id="ed-notes" value="${r ? esc(r.notes || '') : ''}"></div>
    <div class="ed-field"><label>Fotos</label>
      <div class="ed-photos" id="ed-photos"></div>
      <input type="file" id="ed-photo-input" accept="image/*" multiple></div>
    <div class="ed-buttons">
      <button type="button" class="ed-cancel">Abbrechen</button>
      <button type="button" class="ed-save">💾 Speichern</button>
    </div>
    ${r ? '<button type="button" class="ed-delete">🗑 Rezept löschen</button>' : ''}
  </div>`;

  // Kategorien-Auswahl initialisieren
  const selectedCats = r ? (Array.isArray(r.category) ? r.category : (r.category ? [r.category] : [])) : [];
  window.edSelectedCategories = selectedCats;
  renderCategoriesContainer();

  // Gruppen-Auswahl initialisieren
  window.edSelectedGroup = r?.group || '';
  renderGroupsContainer();

  renderEdPhotos();
  el.querySelector('.ed-close').onclick = closeEditor;

  $('#ed-photo-input').onchange = async e => {
    for (const file of e.target.files) {
      try { edNeu.push(await resizePhoto(file)); }
      catch (err) { toast('Foto-Fehler: ' + err.message); }
    }
    e.target.value = '';
    renderEdPhotos();
  };
  el.querySelector('.ed-cancel').onclick = closeEditor;
  el.querySelector('.ed-save').onclick = () => saveFromEditor(r ? r.id : null);
  const del = el.querySelector('.ed-delete');
  if (del) del.onclick = () => deleteFromEditor(r.id);
  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

/* ---------- Speichern / Löschen ---------- */

async function freshRemoteData() {
  const file = await ghGet('data/recipes.json');
  return { sha: file.sha, json: JSON.parse(utf8b64(file.content)) };
}

async function commitRemoteData(remote, sha, message) {
  // Version bleibt gleich (wird nur bei App-Updates erhöht)
  // Voller ISO-Timestamp: nur Datum würde bei mehreren Saves am selben Tag
  // gleich bleiben und andere Geräte würden das Update nie erkennen
  remote.updated = new Date().toISOString();
  await ghPut('data/recipes.json', b64utf8(JSON.stringify(remote, null, 2)), message, sha);
}

async function saveFromEditor(existingId) {
  if (edBusy) return;
  const title = $('#ed-title').value.trim();
  if (!title) return toast('Titel fehlt');
  const lines = v => v.split('\n').map(s => s.trim()).filter(Boolean);
  edBusy = true;
  try {
    toast('Lade aktuellen Stand …');
    const { sha, json: remote } = await freshRemoteData();

    let id = existingId;
    if (!id) {
      const base = slugify(title);
      const ids = new Set(remote.recipes.map(r => r.id));
      id = base; let n = 2;
      while (ids.has(id)) id = `${base}-${n++}`;
    }
    const old = remote.recipes.find(r => r.id === id);

    // Neue Fotos hochladen und sofort in den Offline-Cache legen
    const ts = Math.floor(Date.now() / 1000);
    const images = [...edKeep];
    const cache = await caches.open(IMG_CACHE);
    for (let i = 0; i < edNeu.length; i++) {
      toast(`Lade Foto ${i + 1}/${edNeu.length} hoch …`);
      const path = `data/images/${id}-${ts}-${i}.jpg`;
      await ghPut(path, edNeu[i].split(',')[1], `Foto: ${title} (vom Handy)`);
      await cache.put(new Request(path), new Response(dataUrlToBlob(edNeu[i]),
        { headers: { 'Content-Type': 'image/jpeg' } }));
      images.push(path);
    }

    const recipe = {
      id, title,
      category: window.edSelectedCategories && window.edSelectedCategories.length > 0 ? window.edSelectedCategories : [],
      time: $('#ed-time').value.trim(),
      servings: $('#ed-servings').value.trim(),
      emoji: $('#ed-emoji').value.trim(),
      image: images[0] || '',
      images,
      ingredients: lines($('#ed-ingredients').value),
      steps: lines($('#ed-steps').value),
      notes: $('#ed-notes').value.trim(),
      bereich: $('#ed-bereich').value,
    };
    if (window.edSelectedGroup) recipe.group = window.edSelectedGroup;

    if (old) {
      remote.recipes[remote.recipes.indexOf(old)] = recipe;
    } else {
      // ans Ende der eigenen Kategorie einsortieren (erste Kategorie zählt, String oder Array)
      const firstCat = x => Array.isArray(x.category) ? x.category[0] : x.category;
      let idx = -1;
      remote.recipes.forEach((r, i) => { if (firstCat(r) && firstCat(r) === firstCat(recipe)) idx = i; });
      if (idx >= 0) remote.recipes.splice(idx + 1, 0, recipe);
      else remote.recipes.push(recipe);
    }

    toast('Speichere …');
    await commitRemoteData(remote, sha, `${title} bearbeitet (vom Handy)`);

    // Entfernte Fotos im Repo aufräumen (optional, im Hintergrund)
    const oldImgs = old ? imagesOf(old) : [];
    for (const p of oldImgs) {
      if (!images.includes(p)) ghDeleteFile(p, `Foto entfernt: ${title}`);
    }

    data = remote;
    saveLocal();
    closeEditor();
    closeOverlay();
    render();
    toast('Gespeichert ✓');
  } catch (e) {
    toast('Fehler: ' + e.message);
  } finally {
    edBusy = false;
  }
}

async function deleteFromEditor(id) {
  const r = data.recipes.find(x => x.id === id);
  if (!r || !confirm(`„${r.title}" wirklich löschen?`)) return;
  if (edBusy) return;
  edBusy = true;
  try {
    toast('Lösche …');
    const { sha, json: remote } = await freshRemoteData();
    const target = remote.recipes.find(x => x.id === id);
    if (target) {
      remote.recipes.splice(remote.recipes.indexOf(target), 1);
      await commitRemoteData(remote, sha, `${r.title} gelöscht (vom Handy)`);
      for (const p of imagesOf(target)) ghDeleteFile(p, `Foto entfernt: ${r.title}`);
    }
    data = remote;
    saveLocal();
    closeEditor();
    closeOverlay();
    render();
    toast('Gelöscht ✓');
  } catch (e) {
    toast('Fehler: ' + e.message);
  } finally {
    edBusy = false;
  }
}

/* ---------- Token-Einrichtung ---------- */

function openTokenSetup() {
  const has = !!ghToken();
  const el = edEl();
  el.innerHTML = `
  <div class="ed-body">
    <h2>✏️ Bearbeiten am Handy</h2>
    <p class="ed-text">${has
      ? 'Bearbeiten ist auf diesem Gerät <strong>aktiv</strong>. In jeder Rezept-Ansicht gibt es den ✏️-Knopf, in der Übersicht die „＋ Neues Rezept“-Kachel.'
      : 'Damit dieses Gerät Rezepte bearbeiten darf, braucht es einmalig einen GitHub-Schlüssel (Token). Er wird nur hier auf dem Gerät gespeichert.'}</p>
    ${has ? '' : `<p class="ed-text">Token erstellen: <strong>github.com → Settings → Developer settings → Tokens (classic) → Generate new token</strong>, Haken bei „repo", ohne Ablaufdatum. Oder frag Lars nach dem bestehenden Token. 😉</p>`}
    <div class="ed-field"><label>GitHub-Token</label>
      <input id="ed-token" type="password" placeholder="ghp_…" value=""></div>
    <div class="ed-buttons">
      <button type="button" class="ed-cancel">Schließen</button>
      <button type="button" class="ed-save">Speichern & testen</button>
    </div>
    ${has ? '<button type="button" class="ed-delete">Token von diesem Gerät entfernen</button>' : ''}
  </div>`;
  el.querySelector('.ed-cancel').onclick = closeEditor;
  el.querySelector('.ed-save').onclick = async () => {
    const t = $('#ed-token').value.trim();
    if (!t) return toast('Bitte Token einfügen');
    toast('Prüfe Token …');
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}`,
      { headers: { 'Authorization': 'token ' + t, 'Accept': 'application/vnd.github+json' } });
    if (!res.ok) return toast('Token funktioniert nicht (Fehler ' + res.status + ')');
    localStorage.setItem(TOKEN_KEY, t);
    closeEditor();
    render();
    toast('Bearbeiten aktiviert ✓');
  };
  const del = el.querySelector('.ed-delete');
  if (del) del.onclick = () => {
    localStorage.removeItem(TOKEN_KEY);
    closeEditor();
    render();
    toast('Token entfernt');
  };
  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

/* ---------- Anbindung an die App ---------- */

// Wird von render() aufgerufen: „＋ Neues Rezept”-Kachel, wenn Edit-Mode aktiviert ist
// Kategorien-Auswahl UI
function renderCategoriesContainer() {
  const container = $('#ed-categories-container');
  if (!container) return;

  const cats = [...new Set(data.recipes.map(x => {
    if (Array.isArray(x.category)) return x.category;
    return x.category ? [x.category] : [];
  }).flat().filter(Boolean))].sort();

  let html = '<div class="ed-categories-chips">';
  for (const cat of window.edSelectedCategories || []) {
    html += `<span class="ed-category-chip">${esc(cat)} <button type="button" class="ed-category-remove" data-cat="${esc(cat)}">×</button></span>`;
  }
  html += `<button type="button" class="ed-category-add" id="ed-category-add-btn">+ Kategorie</button></div>`;

  container.innerHTML = html;

  // Remove-Button Handler
  for (const btn of container.querySelectorAll('.ed-category-remove')) {
    btn.onclick = (e) => {
      e.preventDefault();
      const cat = btn.dataset.cat;
      window.edSelectedCategories = window.edSelectedCategories.filter(c => c !== cat);
      renderCategoriesContainer();
    };
  }

  // Add-Button Handler
  container.querySelector('#ed-category-add-btn').onclick = (e) => {
    e.preventDefault();
    openCategorySelector(cats);
  };
}

function openCategorySelector(allCats) {
  const modal = document.createElement('div');
  modal.className = 'ed-modal-overlay';

  let html = '<div class="ed-modal"><h3>Kategorien auswählen</h3><div class="ed-cat-list">';

  for (const cat of allCats) {
    const checked = (window.edSelectedCategories || []).includes(cat);
    html += `<label class="ed-cat-option"><input type="checkbox" data-cat="${esc(cat)}" ${checked ? 'checked' : ''}> ${esc(cat)}</label>`;
  }

  html += `</div><div class="ed-cat-new"><input id="ed-new-category" placeholder="Neue Kategorie..."></div><div class="ed-modal-buttons"><button type="button" class="ed-modal-cancel">Abbrechen</button><button type="button" class="ed-modal-ok">OK</button></div></div>`;

  modal.innerHTML = html;
  document.body.appendChild(modal);

  modal.querySelector('.ed-modal-cancel').onclick = () => modal.remove();
  modal.querySelector('.ed-modal-ok').onclick = () => {
    const selected = [];
    for (const input of modal.querySelectorAll('input[type="checkbox"]:checked')) {
      selected.push(input.dataset.cat);
    }
    const newCat = modal.querySelector('#ed-new-category').value.trim();
    if (newCat && !selected.includes(newCat)) {
      selected.push(newCat);
    }
    window.edSelectedCategories = selected;
    renderCategoriesContainer();
    modal.remove();
  };

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

// Gruppen-Auswahl UI
function renderGroupsContainer() {
  const container = $('#ed-groups-container');
  if (!container) return;

  const allGroups = [...new Set(data.recipes.map(x => x.group).filter(Boolean))].sort();

  let html = '<div class="ed-groups-chips">';
  if (window.edSelectedGroup) {
    html += `<span class="ed-group-chip">${esc(window.edSelectedGroup)} <button type="button" class="ed-group-remove" data-group="${esc(window.edSelectedGroup)}">×</button></span>`;
  }
  html += `<button type="button" class="ed-group-add" id="ed-group-add-btn">+ Gruppe</button></div>`;

  container.innerHTML = html;

  const removeBtn = container.querySelector('.ed-group-remove');
  if (removeBtn) {
    removeBtn.onclick = (e) => {
      e.preventDefault();
      window.edSelectedGroup = '';
      renderGroupsContainer();
    };
  }

  container.querySelector('#ed-group-add-btn').onclick = (e) => {
    e.preventDefault();
    openGroupSelector(allGroups);
  };
}

function openGroupSelector(allGroups) {
  const modal = document.createElement('div');
  modal.className = 'ed-modal-overlay';

  let html = '<div class="ed-modal"><h3>Gruppe auswählen</h3><div class="ed-group-list">';

  for (const group of allGroups) {
    html += `<label class="ed-group-option"><input type="radio" name="group" value="${esc(group)}" ${window.edSelectedGroup === group ? 'checked' : ''}> ${esc(group)}</label>`;
  }

  html += `</div><div class="ed-group-new"><input id="ed-new-group" placeholder="Neue Gruppe..."></div><div class="ed-modal-buttons"><button type="button" class="ed-modal-cancel">Abbrechen</button><button type="button" class="ed-modal-ok">OK</button></div></div>`;

  modal.innerHTML = html;
  document.body.appendChild(modal);

  modal.querySelector('.ed-modal-cancel').onclick = () => modal.remove();
  modal.querySelector('.ed-modal-ok').onclick = () => {
    const checkedRadio = modal.querySelector('input[name="group"]:checked');
    let selected = checkedRadio ? checkedRadio.value : '';
    const newGroup = modal.querySelector('#ed-new-group').value.trim();
    if (newGroup) {
      selected = newGroup;
    }
    window.edSelectedGroup = selected;
    renderGroupsContainer();
    modal.remove();
  };

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

window.editorGridCard = () => {
  const token = ghToken();
  const editEnabled = localStorage.getItem('rezeptbuch-edit-enabled') !== 'false';
  if (!token || !editEnabled) return null;
  const card = document.createElement('article');
  card.className = 'card add-card';

  const photoDiv = document.createElement('div');
  photoDiv.className = 'photo placeholder';
  photoDiv.textContent = '＋';

  const infoDiv = document.createElement('div');
  infoDiv.className = 'info';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'title';
  titleDiv.textContent = 'Neues Rezept';

  infoDiv.appendChild(titleDiv);
  card.appendChild(photoDiv);
  card.appendChild(infoDiv);
  card.onclick = () => openEditor(null);
  return card;
};

// Wird von renderDetail() aufgerufen: ✏️-Knopf in der Rezept-Ansicht
window.editorEnhanceDetail = (el, id) => {
  const token = ghToken();
  const editEnabled = localStorage.getItem('rezeptbuch-edit-enabled') !== 'false';
  if (!token || !editEnabled) return;
  const b = document.createElement('button');
  b.className = 'detail-edit';
  b.textContent = '✏️';
  b.setAttribute('aria-label', 'Bearbeiten');
  b.onclick = () => openEditor(id);
  el.appendChild(b);
};

$('#btn-edit').onclick = openTokenSetup;
