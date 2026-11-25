'use strict';

/* Bearbeiten-Modus fürs Handy: schreibt Änderungen direkt ins GitHub-Repo.
   Braucht einmalig einen GitHub-Token (Einrichtung über den ✏️-Knopf oben).
   Der Token bleibt nur auf diesem Gerät gespeichert (localStorage). */

const GH_REPO = activeLibrary().repo;
const TOKEN_KEY = 'rezeptbuch-token'; // Token der ersten Bibliothek

// Cloudflare-Worker, der Rezeptfotos per KI ausliest (siehe recipe-scan-worker/)
const SCAN_WORKER_URL = 'https://rezeptbuch-scan.schlemmer-lars.workers.dev';

// Weitere Bibliotheken bringen ihren Token selbst mit
const ghToken = () => activeLibrary().id === 'main'
  ? localStorage.getItem(TOKEN_KEY) || '' : activeLibrary().token || '';

// Wer war's: der Name steht in jeder Änderung auf GitHub
function signMessage(message) {
  if (!userName()) return message;
  return `${message.replace(/ \((vom Handy|aus der App)\)$/, '')} (von ${userName()})`;
}

window.clearToken = () => {
  const old = ghToken();
  localStorage.removeItem(TOKEN_KEY);
  render();
  toastUndo('Token entfernt', () => {
    localStorage.setItem(TOKEN_KEY, old);
    render();
    const page = history.state?.page || '';
    if (!edEl().hidden && page.startsWith('settings')) openSettings(page.slice('settings-'.length));
    toast('Token wiederhergestellt');
  }, { ms: 8000 });
};

/* ---------- GitHub-API ---------- */

function ghHeaders() {
  return {
    'Authorization': 'token ' + ghToken(),
    'Accept': 'application/vnd.github+json',
  };
}

// Verständliche Meldung statt nacktem "GitHub-Fehler 401": GitHub liefert bei
// abgelaufenem Token 401, bei fehlenden Schreibrechten (z.B. Token ohne
// "repo"-Recht oder falsches Repo) bewusst 404 statt 403.
function ghErrorMessage(status, path) {
  if (status === 401) return 'Token abgelaufen oder ungültig – bitte in den Einstellungen neu einrichten';
  if (status === 403) return 'GitHub verweigert den Zugriff (Token-Rechte oder Limit erreicht)';
  if (status === 404) return 'Token ohne Schreibrecht für das Repo (404) – bitte neuen Token mit "repo"-Recht einrichten';
  if (status === 409 || status === 422) return 'Konflikt beim Speichern – bitte kurz warten und nochmal versuchen';
  return 'GitHub-Fehler ' + status + (path ? ' bei ' + path : '');
}

async function ghGet(path) {
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(path)}?ref=main&t=${Date.now()}`,
    { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(ghErrorMessage(res.status, path));
  return res.json();
}

async function ghPut(path, base64Content, message, sha) {
  const body = { message: signMessage(message), content: base64Content, branch: 'main' };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(path)}`,
    { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(ghErrorMessage(res.status, path));
  return res.json();
}

async function ghDeleteFile(path, message) {
  try {
    const info = await ghGet(path);
    await fetch(
      `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(path)}`,
      { method: 'DELETE', headers: ghHeaders(),
        body: JSON.stringify({ message: signMessage(message), sha: info.sha, branch: 'main' }) });
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

// Ladebalken im KI-Bereich ein-/ausblenden und Buttons währenddessen sperren
function setAiScanBusy(busy, label) {
  const box = $('.ai-scan-box');
  if (!box) return;
  $('#ai-scan-progress').hidden = !busy;
  if (busy) $('#ai-scan-error').hidden = true;
  $('#ai-scan-label').textContent = busy ? label : 'Rezept per KI erfassen';
  for (const b of box.querySelectorAll('button')) b.disabled = busy;
  const goBtn = $('.ed-scan-link-go');
  if (goBtn) goBtn.disabled = busy;
}

// Anfrage an den KI-Dienst; Fehler kommen als verständlicher Satz zurück
async function askScanService(payload) {
  let res;
  try {
    res = await fetch(SCAN_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // mit dem Token prüft der Dienst den Zugang
      body: JSON.stringify({ token: ghToken(), ...payload }),
    });
  } catch (e) {
    throw new Error('Der KI-Dienst ist nicht erreichbar. Internet prüfen oder später nochmal versuchen');
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* unvollständige oder fremde Antwort */ }
  if (!res.ok) throw new Error(readableScanError(body?.error) || 'Fehler ' + res.status);
  if (!body) throw new Error('Die Antwort der KI war unvollständig. Bitte nochmal versuchen');
  return body;
}

// "Anthropic-Fehler: {…}" auf die eigentliche Aussage kürzen
function readableScanError(error) {
  if (!error) return '';
  const raw = error.match(/^Anthropic-Fehler: (\{[\s\S]*\})$/);
  if (!raw) return error;
  try { return 'Anthropic meldet: ' + JSON.parse(raw[1]).error.message; }
  catch (e) { return error; }
}

// Fehler bleibt im KI-Kasten stehen, bis man es erneut versucht
function showScanError(message) {
  const box = $('#ai-scan-error');
  if (!box) return toast('Auslesen fehlgeschlagen: ' + message);
  box.textContent = 'Auslesen fehlgeschlagen: ' + message;
  box.hidden = false;
}

// Vom Scan-Worker gelieferte Felder in den offenen Editor übernehmen
function applyScanResult(parsed) {
  if (parsed.title) $('#ed-title').value = parsed.title;
  if (parsed.servings) $('#ed-servings').value = parsed.servings;
  if (parsed.emoji) $('#ed-emoji').value = parsed.emoji;
  if (Array.isArray(parsed.ingredients)) $('#ed-ingredients').value = parsed.ingredients.join('\n');
  if (Array.isArray(parsed.steps)) $('#ed-steps').value = parsed.steps.join('\n');
  if (parsed.time) {
    const m = parseTimeMinutes(parsed.time);
    if (m != null) $('#ed-time').value = minutesToHHMM(m);
  }
}

// Ein oder mehrere Fotos (z.B. mehrseitiges Rezept) per KI auslesen und
// Editor-Felder befüllen — alle Fotos gehen als ein zusammenhängendes
// Rezept an Claude, nicht einzeln nacheinander
async function scanRecipePhotos(files) {
  let dataUrls;
  try { dataUrls = await Promise.all(files.map(resizePhoto)); }
  catch (err) { return toast('Foto-Fehler: ' + err.message); }

  setAiScanBusy(true, dataUrls.length > 1 ? `${dataUrls.length} Fotos werden ausgelesen …` : 'Rezept wird ausgelesen …');
  try {
    applyScanResult(await askScanService({
      images: dataUrls.map(d => ({ data: d.split(',')[1], mediaType: 'image/jpeg' })),
    }));
    toast('✓ Rezept ausgelesen — bitte kurz prüfen');
  } catch (err) {
    showScanError(err.message);
  } finally {
    setAiScanBusy(false);
  }
}

// Rezept-Link per KI (Cloudflare-Worker + Claude) auslesen und Editor-Felder befüllen
async function scanRecipeUrl(url) {
  setAiScanBusy(true, 'Rezept wird von der Seite ausgelesen …');
  try {
    applyScanResult(await askScanService({ url }));
    toast('✓ Rezept ausgelesen — bitte kurz prüfen');
  } catch (err) {
    showScanError(err.message);
  } finally {
    setAiScanBusy(false);
  }
}

/* ---------- Editor-Oberfläche ---------- */

const edEl = () => $('#editor');
let edKeep = [];   // vorhandene Fotos (Pfade)
let edNeu = [];    // neue Fotos (data:-URLs)
let edBusy = false;

function closeEditor() {
  if ($('#toast').dataset.scope === 'editor') $('#toast').hidden = true;
  edEl().hidden = true;
  if ($('#detail').hidden) document.body.style.overflow = '';
}

// Zurück-Knöpfe im Editor/in den Einstellungen: über den Verlauf, damit die
// Ansicht darunter bzw. die vorherige Einstellungsseite wieder erscheint
function leaveEditorPage() {
  if (history.state?.view === 'overlay') closeOverlay();
  else closeEditor();
}

function edPhotoListHTML() {
  const thumb = (src, typ, i) => `
    <span class="ed-thumb">
      <img src="${esc(assetURL(src))}" alt="">
      <button type="button" class="ed-x" data-typ="${typ}" data-i="${i}">✕</button>
    </span>`;
  return edKeep.map((p, i) => thumb(p, 'keep', i)).join('')
    + edNeu.map((d, i) => thumb(d, 'neu', i)).join('');
}

// "Rückgängig" für etwas, das im Formular entfernt wurde (nur solange es offen ist)
function edUndo(label, container, restore) {
  toastUndo(label, () => { if (container.isConnected) restore(); }, { scope: 'editor' });
}

function renderEdPhotos() {
  $('#ed-photos').innerHTML = edPhotoListHTML();
  for (const b of $('#ed-photos').querySelectorAll('.ed-x')) {
    b.onclick = () => {
      const keep = b.dataset.typ === 'keep';
      const list = keep ? edKeep : edNeu;
      const i = Number(b.dataset.i);
      const [removed] = list.splice(i, 1);
      renderEdPhotos();
      edUndo('Foto entfernt', $('#ed-photos'), () => {
        if (list !== (keep ? edKeep : edNeu)) return;
        list.splice(i, 0, removed);
        renderEdPhotos();
      });
    };
  }
}

function openEditor(id) {
  // Blockiere Bearbeitung im Offline-Modus
  if (localStorage.getItem(OFFLINE_MODE_KEY) === 'true') {
    toast('🔒 Im Offline-Modus: Bearbeiten nicht möglich');
    return;
  }

  enterOverlay('edit');

  // Auto-Check: Falls bestehendes Rezept, checke auf Updates
  if (id) {
    window.checkAndUpdateIfNeeded?.();
  }

  const r = id ? data.recipes.find(x => x.id === id) : null;
  edKeep = r ? [...imagesOf(r)] : [];
  edNeu = [];
  const bereich = r ? (r.bereich || 'kochen') : mode;

  const el = edEl();
  el.innerHTML = `
  <button class="detail-close ed-close" aria-label="Zurück">←</button>
  <div class="ed-body">
    <h2>${r ? 'Rezept bearbeiten' : 'Neues Rezept'}</h2>
    ${r ? '' : `
    <div class="ai-scan-box">
      <div class="ai-scan-label" id="ai-scan-label">Rezept per KI erfassen</div>
      <div class="ai-scan-buttons">
        <button type="button" class="ed-scan-btn">Foto</button>
        <button type="button" class="ed-scan-link-btn">Link</button>
      </div>
      <input type="file" id="ed-scan-input" accept="image/*" multiple hidden>
      <div class="ed-scan-link-row" hidden>
        <input type="url" id="ed-scan-link-input" placeholder="Link zum Rezept einfügen" autocomplete="off" autocapitalize="off">
        <button type="button" class="ed-scan-link-go">Los</button>
      </div>
      <div class="ai-scan-progress" id="ai-scan-progress" hidden><div class="ai-scan-progress-bar"></div></div>
      <div class="ai-scan-error" id="ai-scan-error" role="alert" hidden></div>
    </div>`}
    <div class="ed-field"><label>Titel *</label>
      <input id="ed-title" value="${r ? esc(r.title) : ''}"></div>
    <div class="ed-row">
      <div class="ed-field"><label>Bereich</label>
        <select id="ed-bereich">
          <option value="kochen"${bereich === 'kochen' ? ' selected' : ''}>Kochen</option>
          <option value="backen"${bereich === 'backen' ? ' selected' : ''}>Backen</option>
          <option value="fruehstueck"${bereich === 'fruehstueck' ? ' selected' : ''}>Frühstück</option>
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
        <input id="ed-time" type="time" value="${r ? esc(minutesToHHMM(parseTimeMinutes(r.time))) : ''}"></div>
      <div class="ed-field"><label>Portionen</label>
        <input id="ed-servings" placeholder="z. B. 2 Portionen" value="${r ? esc(r.servings) : ''}"></div>
    </div>
    <div class="ed-field"><label>Zutaten (eine pro Zeile)</label>
      <div class="ed-hint">Zeile mit * beginnen für eine Zwischenüberschrift, z. B. „*Teig" oder „*Füllung"</div>
      <textarea id="ed-ingredients" rows="6">${r ? esc((r.ingredients || []).join('\n')) : ''}</textarea></div>
    <div class="ed-field"><label>Zubereitung (ein Schritt pro Zeile)</label>
      <textarea id="ed-steps" rows="7">${r ? esc((r.steps || []).join('\n')) : ''}</textarea></div>
    <div class="ed-field"><label>Notizen</label>
      <input id="ed-notes" value="${r ? esc(r.notes || '') : ''}"></div>
    <div class="ed-field"><label>Dazu passt auch</label>
      <div id="ed-related-container" class="ed-related-container"></div></div>
    <div class="ed-field"><label>Fotos</label>
      <div class="ed-photos" id="ed-photos"></div>
      <input type="file" id="ed-photo-input" accept="image/*" multiple></div>
    <div class="ed-buttons">
      <button type="button" class="ed-cancel">Abbrechen</button>
      <button type="button" class="ed-save">Speichern</button>
    </div>
    ${r ? '<button type="button" class="ed-delete">Rezept löschen</button>' : ''}
  </div>`;

  // Kategorien-Auswahl initialisieren
  const selectedCats = r ? (Array.isArray(r.category) ? r.category : (r.category ? [r.category] : [])) : [];
  window.edSelectedCategories = selectedCats;
  renderCategoriesContainer();

  // Gruppen-Auswahl initialisieren
  window.edSelectedGroup = r?.group || '';
  renderGroupsContainer();

  // "Dazu passt auch"-Auswahl initialisieren
  window.edSelectedRelated = r?.related ? [...r.related] : [];
  window.edCurrentId = r?.id || null;
  renderRelatedContainer();

  // Bereich gewechselt → Kategorien- und Gruppen-Auswahl auf den neuen Bereich filtern
  $('#ed-bereich').onchange = () => {
    renderCategoriesContainer();
    renderGroupsContainer();
  };

  renderEdPhotos();
  el.querySelector('.ed-close').onclick = leaveEditorPage;

  const scanBtn = el.querySelector('.ed-scan-btn');
  if (scanBtn) {
    const scanInput = el.querySelector('#ed-scan-input');
    scanBtn.onclick = () => scanInput.click();
    scanInput.onchange = async e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) await scanRecipePhotos(files);
    };
  }

  const scanLinkBtn = el.querySelector('.ed-scan-link-btn');
  if (scanLinkBtn) {
    const linkRow = el.querySelector('.ed-scan-link-row');
    const linkInput = el.querySelector('#ed-scan-link-input');
    scanLinkBtn.onclick = () => {
      linkRow.hidden = false;
      linkInput.focus();
    };
    el.querySelector('.ed-scan-link-go').onclick = async () => {
      const url = linkInput.value.trim();
      if (!url) return toast('Bitte einen Link einfügen');
      await scanRecipeUrl(url);
    };
  }

  $('#ed-photo-input').onchange = async e => {
    for (const file of e.target.files) {
      try { edNeu.push(await resizePhoto(file)); }
      catch (err) { toast('Foto-Fehler: ' + err.message); }
    }
    e.target.value = '';
    renderEdPhotos();
  };
  el.querySelector('.ed-cancel').onclick = leaveEditorPage;
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
      if (assetURL(path) !== path) await cache.put(assetURL(path), new Response(dataUrlToBlob(edNeu[i]),
        { headers: { 'Content-Type': 'image/jpeg' } }));
      images.push(path);
    }

    const recipe = {
      id, title,
      category: window.edSelectedCategories && window.edSelectedCategories.length > 0 ? window.edSelectedCategories : [],
      // Rad-Eingabe liefert "HH:MM" — in unser Anzeige-Format umrechnen
      time: (() => { const m = hhmmToMinutes($('#ed-time').value); return m != null ? formatDuration(m) : ''; })(),
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
    if (window.edSelectedRelated && window.edSelectedRelated.length) recipe.related = window.edSelectedRelated;
    // Hinzugefügt-Zeitpunkt: nur bei wirklich neuem Rezept setzen. Bestehende
    // Rezepte ohne created (ältere Bestandsrezepte) bekommen KEIN created,
    // sonst würde ein simples Bearbeiten fälschlich als "Neu" statt "Update"
    // markiert werden (created wäre sonst "jetzt" gewesen).
    if (!old) recipe.created = new Date().toISOString();
    else if (old.created) recipe.created = old.created;
    // Geändert-Zeitpunkt: immer jetzt — steuert den Neu/Update-Hinweis (1 Tag).
    recipe.updated = new Date().toISOString();
    // Wer war's
    recipe.updatedBy = userName();
    if (!old) recipe.createdBy = userName();
    else if (old.createdBy) recipe.createdBy = old.createdBy;

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
    const detailWasOpen = !$('#detail').hidden;
    const fromOverlay = history.state?.view === 'overlay';
    closeEditor();
    // Auf der (jetzt aktualisierten) Rezeptseite bleiben statt eine Ebene
    // zurückzuspringen. closeOverlay()/history.back() würde bei Rezepten, die
    // über die Tinder-Slot-Machine geöffnet wurden, auf der Slot-Machine
    // landen statt beim Rezept — das wollen wir hier vermeiden.
    renderDetail(recipe.id);
    $('#detail').hidden = false;
    document.body.style.overflow = 'hidden';
    if (!fromOverlay) replaceView({ view: 'recipe', id: recipe.id });
    // Editor über der Rezeptseite: dessen Eintrag einfach zurücknehmen
    else if (detailWasOpen) history.back();
    // z. B. "+ Neues Rezept" von der Übersicht: Editor-Eintrag wird zum Rezept
    else replaceView({ view: 'recipe', id: recipe.id });
    render();
    toast('Gespeichert ✓');
  } catch (e) {
    toast('Fehler: ' + e.message);
  } finally {
    edBusy = false;
  }
}

// Ein einzelnes Foto an ein Rezept anhängen (z. B. am Ende des Kochmodus).
// Gibt das verkleinerte Foto als Vorschau zurück
async function addPhotoToRecipe(id, file) {
  if (edBusy) throw new Error('Gerade wird etwas anderes gespeichert');
  edBusy = true;
  try {
    const photo = await resizePhoto(file);
    const { sha, json: remote } = await freshRemoteData();
    const recipe = remote.recipes.find(r => r.id === id);
    if (!recipe) throw new Error('Das Rezept gibt es nicht mehr');
    const path = `data/images/${id}-${Math.floor(Date.now() / 1000)}-0.jpg`;
    await ghPut(path, photo.split(',')[1], `Foto: ${recipe.title} (vom Handy)`);
    // gleich fürs Offline-Kochen merken (Cache ist Zugabe, darf scheitern)
    try {
      const cache = await caches.open(IMG_CACHE);
      await cache.put(assetURL(path), new Response(dataUrlToBlob(photo), { headers: { 'Content-Type': 'image/jpeg' } }));
    } catch (e) { /* ohne Cache wird beim Ansehen geladen */ }
    recipe.images = [...imagesOf(recipe), path];
    recipe.image = recipe.images[0];
    recipe.updated = new Date().toISOString();
    recipe.updatedBy = userName();
    await commitRemoteData(remote, sha, `${recipe.title}: Foto hinzugefügt (vom Handy)`);
    data = remote;
    saveLocal();
    render();
    // Rezeptseite darunter gleich mit dem neuen Foto zeigen
    if (!$('#detail').hidden) {
      const top = $('#detail').scrollTop;
      renderDetail(id);
      $('#detail').scrollTop = top;
    }
    return photo;
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
    const index = remote.recipes.findIndex(x => x.id === id);
    const target = remote.recipes[index];
    if (target) {
      remote.recipes.splice(index, 1);
      await commitRemoteData(remote, sha, `${r.title} gelöscht (vom Handy)`);
    }
    data = remote;
    saveLocal();
    // Editor UND die Seite des gelöschten Rezepts aus dem Verlauf nehmen
    const steps = Math.min(history.state?.view === 'overlay' ? 2 : 1, navDepth());
    closeEditor();
    if (steps) history.go(-steps);
    else hideDetail();
    render();
    if (target) offerRecipeUndo('Rezept gelöscht', { items: [{ recipe: target, index }], links: [] });
    else toast('Gelöscht ✓');
  } catch (e) {
    toast('Fehler: ' + e.message);
  } finally {
    edBusy = false;
  }
}

/* ---------- Token-Einrichtung und Umzug ---------- */

// Prüft echtes Schreibrecht: legt einen losen Datenblock an, der in keiner
// Datei und keinem Stand auftaucht (öffentliche Speicher lesen darf jeder)
async function tokenCanWrite(repo, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/git/blobs`, {
    method: 'POST',
    headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
    body: JSON.stringify({ content: 'Schreibtest', encoding: 'utf-8' }),
  });
  lastWriteStatus = res.status;
  return res.ok;
}
let lastWriteStatus = 0; // für eine verständliche Fehlermeldung

function writeProblem() {
  if (lastWriteStatus === 401) return 'Token ungültig oder unvollständig eingefügt (401)';
  return `Dem Token fehlt „Contents: Read and write“ für den neuen Speicher (${lastWriteStatus})`;
}

// Stand der Rezepte beim Kopieren in den neuen Speicher
const MOVE_BASELINE = '2026-11-25T09:58:22.410Z';

async function readRepoJSON(repo, path, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=main&t=${Date.now()}`,
    { headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(ghErrorMessage(res.status, path));
  const file = await res.json();
  return { sha: file.sha, json: JSON.parse(utf8b64(file.content)) };
}

// Wechselt dieses Gerät auf den eigenen Daten-Speicher
async function moveToDataRepo(token) {
  if (!await tokenCanWrite(DATA_REPO, token)) throw new Error(writeProblem());
  if (await tokenCanWrite(APP_REPO, token)) throw new Error('Dieser Token darf auch die App ändern. Bitte den neuen nehmen');
  // Rezepte, die nach dem Kopieren noch am alten Ort landeten, gingen sonst verloren
  const old = await readRepoJSON(APP_REPO, 'data/recipes.json', token);
  if (new Date(old.json.updated).getTime() > new Date(MOVE_BASELINE).getTime()) {
    throw new Error('Am alten Ort wurde seit dem Kopieren etwas geändert. Sag Lars Bescheid');
  }
  await Promise.allSettled([flushWeekplanUpload(), flushBacklogUpload()]);
  // Wochenplan und Backlog: falls am alten Ort neuer, mitnehmen
  for (const path of ['data/weekplan.json', 'data/backlog.json']) {
    const before = await readRepoJSON(APP_REPO, path, token);
    const target = await readRepoJSON(DATA_REPO, path, token);
    if (new Date(before.json.updated).getTime() <= new Date(target.json.updated).getTime()) continue;
    const res = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
      body: JSON.stringify({ message: signMessage('Beim Umzug übernommen'), sha: target.sha, branch: 'main',
        content: b64utf8(JSON.stringify(before.json, null, 2)) }),
    });
    if (!res.ok) throw new Error(ghErrorMessage(res.status, path));
  }
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(MAIN_MOVED_KEY, 'true');
}

function openMoveDialog() {
  if (mainMoved() || activeLibrary().id !== 'main' || document.querySelector('.move-dialog')) return;
  const box = document.createElement('div');
  box.className = 'ed-modal-overlay move-dialog';
  box.innerHTML = `<form class="ed-modal">
    <h3>Eure Rezepte ziehen um</h3>
    <p class="setting-hint">Sie bekommen einen eigenen Speicher. Gib dafür einmal den neuen Token ein, den Lars erstellt hat.</p>
    <div class="ed-cat-new"><input name="token" type="password" placeholder="github_pat_…" autocomplete="off"></div>
    <div class="ed-modal-buttons"><button type="button" class="ed-modal-cancel">Später</button><button type="submit" class="ed-modal-ok">Umziehen</button></div>
  </form>`;
  document.body.appendChild(box);
  box.querySelector('.ed-modal-cancel').onclick = () => box.remove();
  const ok = box.querySelector('.ed-modal-ok');
  box.querySelector('form').onsubmit = async ev => {
    ev.preventDefault();
    const token = ev.target.elements.token.value.trim();
    if (!token) return toast('Bitte den neuen Token einfügen');
    ok.disabled = true;
    toast('Ziehe um …');
    try {
      await moveToDataRepo(token);
      location.replace(location.pathname + '?umzug=' + Date.now());
    } catch (err) {
      ok.disabled = false;
      toast(err.message);
    }
  };
}

function openTokenSetup() {
  enterOverlay('token');
  const has = !!ghToken();
  const el = edEl();
  el.innerHTML = `
  <div class="ed-body">
    <h2>Bearbeiten am Handy</h2>
    <p class="ed-text">${has
      ? 'Bearbeiten ist auf diesem Gerät <strong>aktiv</strong>. In jeder Rezept-Ansicht gibt es den ✏️-Knopf, in der Übersicht die „＋ Neues Rezept“-Kachel.'
      : 'Damit dieses Gerät Rezepte bearbeiten darf, braucht es einmalig einen GitHub-Schlüssel (Token). Er wird nur hier auf dem Gerät gespeichert.'}</p>
    ${has ? '' : `<p class="ed-text">Den Token bekommst du von jemandem, der diese Bibliothek schon nutzt.</p>`}
    <div class="ed-field"><label>GitHub-Token</label>
      <input id="ed-token" type="password" placeholder="github_pat_…" value="" autocomplete="off"></div>
    <div class="ed-buttons">
      <button type="button" class="ed-cancel">Schließen</button>
      <button type="button" class="ed-save">Speichern & testen</button>
    </div>
    ${has ? '<button type="button" class="ed-delete">Token von diesem Gerät entfernen</button>' : ''}
  </div>`;
  el.querySelector('.ed-cancel').onclick = leaveEditorPage;
  el.querySelector('.ed-save').onclick = async () => {
    const t = $('#ed-token').value.trim();
    if (!t) return toast('Bitte Token einfügen');
    toast('Prüfe Token …');
    if (!await tokenCanWrite(GH_REPO, t)) return toast('Dieser Token darf hier nicht schreiben');
    localStorage.setItem(TOKEN_KEY, t);
    leaveEditorPage();
    render();
    toast('Bearbeiten aktiviert ✓');
  };
  const del = el.querySelector('.ed-delete');
  if (del) del.onclick = () => {
    leaveEditorPage();
    window.clearToken();
  };
  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

/* ---------- Anbindung an die App ---------- */

// Aktuell im Editor gewählter Bereich (Kochen/Backen/Frühstück)
function edBereich() {
  return $('#ed-bereich')?.value || mode;
}

// Nur Rezepte aus dem im Editor gewählten Bereich — Kategorien und Gruppen
// gehören zu ihrem Bereich (z.B. "Kuchen" nur bei Backen)
function edRecipesImBereich() {
  const b = edBereich();
  return data.recipes.filter(x => (x.bereich || 'kochen') === b);
}

// Wird von render() aufgerufen: „＋ Neues Rezept”-Kachel, wenn Edit-Mode aktiviert ist
// Kategorien-Auswahl UI
function renderCategoriesContainer() {
  const container = $('#ed-categories-container');
  if (!container) return;

  const cats = [...new Set(edRecipesImBereich().map(x => {
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
      const i = window.edSelectedCategories.indexOf(cat);
      window.edSelectedCategories = window.edSelectedCategories.filter(c => c !== cat);
      renderCategoriesContainer();
      edUndo('Kategorie entfernt', container, () => {
        if (!window.edSelectedCategories.includes(cat)) window.edSelectedCategories.splice(i, 0, cat);
        renderCategoriesContainer();
      });
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

  // auch neu angelegte, noch an keinem Rezept gespeicherte Auswahl anzeigen
  for (const cat of [...new Set([...allCats, ...(window.edSelectedCategories || [])])]) {
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

  const allGroups = [...new Set(edRecipesImBereich().map(x => x.group).filter(Boolean))].sort();

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
      const group = window.edSelectedGroup;
      window.edSelectedGroup = '';
      renderGroupsContainer();
      edUndo('Gruppe entfernt', container, () => {
        window.edSelectedGroup = group;
        renderGroupsContainer();
      });
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

// "Dazu passt auch"-Auswahl UI: verlinkt andere Rezepte (z.B. Wrap ↔ Wrap-Sauce)
function renderRelatedContainer() {
  const container = $('#ed-related-container');
  if (!container) return;

  let html = '<div class="ed-related-chips">';
  for (const id of window.edSelectedRelated || []) {
    const rel = data.recipes.find(x => x.id === id);
    if (!rel) continue;
    html += `<span class="ed-related-chip">${esc(titleWithEmoji(rel))} <button type="button" class="ed-related-remove" data-id="${esc(id)}">×</button></span>`;
  }
  html += `<button type="button" class="ed-related-add" id="ed-related-add-btn">+ Dazu passt auch</button></div>`;

  container.innerHTML = html;

  for (const btn of container.querySelectorAll('.ed-related-remove')) {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      const i = window.edSelectedRelated.indexOf(id);
      window.edSelectedRelated = window.edSelectedRelated.filter(x => x !== id);
      renderRelatedContainer();
      edUndo('Verknüpfung entfernt', container, () => {
        if (!window.edSelectedRelated.includes(id)) window.edSelectedRelated.splice(i, 0, id);
        renderRelatedContainer();
      });
    };
  }

  container.querySelector('#ed-related-add-btn').onclick = (e) => {
    e.preventDefault();
    openRelatedSelector();
  };
}

function openRelatedSelector() {
  const allRecipes = data.recipes
    .filter(x => x.id !== window.edCurrentId)
    .sort((a, b) => a.title.localeCompare(b.title, 'de'));

  const modal = document.createElement('div');
  modal.className = 'ed-modal-overlay';

  const optionHTML = list => list.map(rec => {
    const checked = (window.edSelectedRelated || []).includes(rec.id);
    return `<label class="ed-cat-option"><input type="checkbox" data-id="${esc(rec.id)}" ${checked ? 'checked' : ''}> ${esc(titleWithEmoji(rec))}</label>`;
  }).join('');

  modal.innerHTML = `<div class="ed-modal">
    <h3>Dazu passt auch</h3>
    <input type="search" id="ed-related-search" placeholder="Rezept suchen …" class="ed-related-search">
    <div class="ed-cat-list" id="ed-related-list">${optionHTML(allRecipes)}</div>
    <div class="ed-modal-buttons">
      <button type="button" class="ed-modal-cancel">Abbrechen</button>
      <button type="button" class="ed-modal-ok">OK</button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  // Ausgewählte Häkchen bleiben beim Filtern erhalten, da wir sie erst
  // beim OK-Klick aus dem kompletten DOM einsammeln — die Suche entfernt
  // nur nicht-passende Optionen aus der Anzeige, nicht deren Zustand
  const listEl = modal.querySelector('#ed-related-list');
  const checkedIds = new Set((window.edSelectedRelated || []));
  modal.querySelector('#ed-related-search').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const label of listEl.querySelectorAll('.ed-cat-option')) {
      const cb = label.querySelector('input');
      if (cb.checked) checkedIds.add(cb.dataset.id); else checkedIds.delete(cb.dataset.id);
    }
    const filtered = q ? allRecipes.filter(rec => rec.title.toLowerCase().includes(q)) : allRecipes;
    listEl.innerHTML = optionHTML(filtered);
    for (const cb of listEl.querySelectorAll('input')) {
      if (checkedIds.has(cb.dataset.id)) cb.checked = true;
    }
  };

  modal.querySelector('.ed-modal-cancel').onclick = () => modal.remove();
  modal.querySelector('.ed-modal-ok').onclick = () => {
    for (const label of listEl.querySelectorAll('.ed-cat-option')) {
      const cb = label.querySelector('input');
      if (cb.checked) checkedIds.add(cb.dataset.id); else checkedIds.delete(cb.dataset.id);
    }
    window.edSelectedRelated = [...checkedIds];
    renderRelatedContainer();
    modal.remove();
  };

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

window.editorGridCard = () => {
  if (!isEditModeEnabled()) return null;
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
  if (!isEditModeEnabled()) return;
  const b = document.createElement('button');
  b.className = 'detail-edit';
  b.textContent = '✏️';
  b.setAttribute('aria-label', 'Bearbeiten');
  b.onclick = () => openEditor(id);
  el.appendChild(b);
};


/* ---------- Rezeptbibliothek (Einstellungen) ---------- */

let libBusy = false;
let libSelected = new Set();   // Rezept-IDs bzw. "bereich|Kategorie"
let libQuery = '';

function libraryAllowed() {
  if (isEditModeEnabled() || (ghToken() && localStorage.getItem(OFFLINE_MODE_KEY) !== 'true')) return true;
  toast('Dafür braucht es einen Token und eine Online-Verbindung');
  return false;
}

// Seitengerüst; behält die Auswahl, wenn dieselbe Seite nur neu gezeichnet wird
function libShell(page, title, hint) {
  if (history.state?.page !== page) { libSelected = new Set(); libQuery = ''; }
  enterOverlay(page);
  const el = edEl();
  el.innerHTML = `
    <button class="detail-close ed-close" aria-label="Zurück">←</button>
    <div class="ed-body lib-body">
      <h2>${title}</h2>
      <p class="ed-text">${hint}</p>
      <div id="lib-content"></div>
    </div>
    <div class="lib-bar" id="lib-bar" hidden>
      <span id="lib-count"></span>
      <button type="button" id="lib-action"></button>
    </div>`;
  el.querySelector('.ed-close').onclick = leaveEditorPage;
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  return el;
}

// Änderung auf den aktuellsten Stand anwenden und als EIN Commit speichern
async function libCommit(message, mutate) {
  if (libBusy || edBusy) return null;
  libBusy = edBusy = true;
  try {
    toast('Speichere …');
    const { sha, json: remote } = await freshRemoteData();
    const result = mutate(remote);
    await commitRemoteData(remote, sha, message);
    data = remote;
    saveLocal();
    render();
    return { remote, result };
  } catch (e) {
    toast('Fehler: ' + e.message);
    return null;
  } finally {
    libBusy = edBusy = false;
  }
}

function openLibraryRecipes() {
  if (!libraryAllowed()) return;
  const el = libShell('library-recipes', 'Rezepte verwalten',
    'Rezepte antippen, die weg sollen. Gelöscht wird erst nach einer Rückfrage.');
  el.querySelector('#lib-content').innerHTML = `
    <input type="search" id="lib-search" class="lib-search" placeholder="Rezept oder Kategorie suchen" autocomplete="off" value="${esc(libQuery)}">
    <div class="lib-list" id="lib-list"></div>`;
  el.querySelector('#lib-search').oninput = ev => { libQuery = ev.target.value; renderLibRecipeList(); };
  el.querySelector('#lib-action').onclick = libDeleteRecipes;
  renderLibRecipeList();
}

function renderLibRecipeList() {
  const list = $('#lib-list');
  if (!list) return;
  const q = libQuery.trim().toLowerCase();
  const recipes = data.recipes
    .filter(r => !q || [r.title, ...recipeCategories(r)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title, 'de'));
  list.innerHTML = recipes.map(r => {
    const img = imagesOf(r)[0];
    const meta = [MODES[recipeMode(r)]?.label, categoryLabel(r)].filter(Boolean).join(' · ');
    return `<label class="lib-row">
      <input type="checkbox" data-key="${esc(r.id)}" ${libSelected.has(r.id) ? 'checked' : ''}>
      ${img ? `<img src="${esc(assetURL(img))}" alt="" loading="lazy">` : `<span class="lib-thumb">${emojiFor(r)}</span>`}
      <span class="lib-text">${esc(r.title)}<small>${esc(meta)}</small></span>
    </label>`;
  }).join('') || '<div class="ed-text">Nichts gefunden.</div>';
  for (const box of list.querySelectorAll('input[type="checkbox"]')) {
    box.onchange = () => {
      if (box.checked) libSelected.add(box.dataset.key); else libSelected.delete(box.dataset.key);
      updateLibRecipeBar();
    };
  }
  updateLibRecipeBar();
}

function updateLibRecipeBar() {
  const n = libSelected.size;
  $('#lib-bar').hidden = !n;
  $('#lib-count').textContent = n === 1 ? '1 ausgewählt' : `${n} ausgewählt`;
  const btn = $('#lib-action');
  btn.textContent = 'Löschen';
  btn.className = 'danger';
}

async function libDeleteRecipes() {
  const chosen = data.recipes.filter(r => libSelected.has(r.id));
  if (!chosen.length) return;
  const names = chosen.slice(0, 6).map(r => '• ' + r.title).join('\n')
    + (chosen.length > 6 ? `\n… und ${chosen.length - 6} weitere` : '');
  const label = chosen.length === 1 ? '1 Rezept' : `${chosen.length} Rezepte`;
  if (!confirm(`${label} wirklich löschen?\n\n${names}`)) return;
  const ids = new Set(chosen.map(r => r.id));
  const done = await libCommit(`${label} gelöscht (vom Handy)`, remote => {
    // Position und Verknüpfungen merken, damit sich alles zurückholen lässt
    const items = remote.recipes.map((recipe, index) => ({ recipe, index })).filter(x => ids.has(x.recipe.id));
    remote.recipes = remote.recipes.filter(r => !ids.has(r.id));
    const links = [];
    for (const r of remote.recipes) {
      const lost = (r.related || []).filter(id => ids.has(id));
      if (!lost.length) continue;
      links.push({ id: r.id, related: lost });
      r.related = r.related.filter(id => !ids.has(id));
    }
    return { items, links };
  });
  if (!done) return;
  libSelected = new Set();
  renderLibRecipeList();
  offerRecipeUndo(`${label} gelöscht`, done.result);
}

// Nach dem Löschen 8 Sekunden "Rückgängig" anbieten. Die Fotos werden erst
// danach aus dem Repo entfernt, vorher wäre nichts mehr zurückzuholen
function offerRecipeUndo(label, snapshot) {
  const cleanup = setTimeout(async () => {
    // nacheinander (parallel gäbe Konflikte) und nur, was niemand mehr benutzt
    for (const { recipe } of snapshot.items) {
      for (const p of imagesOf(recipe)) {
        if (!data.recipes.some(r => imagesOf(r).includes(p))) await ghDeleteFile(p, `Foto entfernt: ${recipe.title}`);
      }
    }
  }, 9000);
  const offer = text => toastUndo(text, async () => {
    clearTimeout(cleanup);
    const done = await libCommit(`${snapshot.items.length === 1 ? snapshot.items[0].recipe.title : snapshot.items.length + ' Rezepte'} wiederhergestellt (vom Handy)`, remote => {
      for (const { recipe, index } of [...snapshot.items].sort((a, b) => a.index - b.index)) {
        if (!remote.recipes.some(r => r.id === recipe.id)) remote.recipes.splice(Math.min(index, remote.recipes.length), 0, recipe);
      }
      for (const link of snapshot.links) {
        const r = remote.recipes.find(x => x.id === link.id);
        if (r) r.related = [...new Set([...(r.related || []), ...link.related])];
      }
    });
    if (!done) return offer('Nicht wiederhergestellt');
    renderLibRecipeList();
    toast('Wiederhergestellt ✓');
  }, { ms: 8000 });
  offer(label);
}

// Kategorien je Bereich mit Anzahl der Rezepte
function libCategoryCounts(modeKey) {
  const counts = new Map();
  for (const r of data.recipes) {
    if (recipeMode(r) !== modeKey) continue;
    for (const c of recipeCategories(r)) counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts].sort((a, b) => a[0].localeCompare(b[0], 'de'));
}

function openLibraryCategories() {
  if (!libraryAllowed()) return;
  const el = libShell('library-categories', 'Kategorien verwalten',
    'Umbenennen oder entfernen. Zum Zusammenfassen mindestens zwei Kategorien eines Bereichs anhaken. Rezepte bleiben immer erhalten.');
  el.querySelector('#lib-action').onclick = libMergeCategories;
  renderLibCategoryList();
}

function renderLibCategoryList() {
  const box = $('#lib-content');
  if (!box) return;
  const sections = Object.entries(MODES).map(([key, m]) => {
    const cats = libCategoryCounts(key);
    if (!cats.length) return '';
    return `<div class="settings-section"><h3>${m.label}</h3>${cats.map(([name, n]) => {
      const k = key + '|' + name;
      return `<div class="lib-cat" data-mode="${key}" data-name="${esc(name)}">
        <label><input type="checkbox" data-key="${esc(k)}" ${libSelected.has(k) ? 'checked' : ''}>
          <span class="lib-text">${esc(name)}<small>${n === 1 ? '1 Rezept' : n + ' Rezepte'}</small></span></label>
        <button type="button" class="lib-rename">Umbenennen</button>
        <button type="button" class="lib-remove" aria-label="Kategorie ${esc(name)} entfernen">✕</button>
      </div>`;
    }).join('')}</div>`;
  }).join('');
  box.innerHTML = sections || '<div class="ed-text">Noch keine Kategorien.</div>';
  for (const row of box.querySelectorAll('.lib-cat')) {
    const { mode: modeKey, name } = row.dataset;
    row.querySelector('input').onchange = ev => {
      const k = ev.target.dataset.key;
      if (ev.target.checked) {
        // Zusammenfassen geht nur innerhalb eines Bereichs
        for (const other of [...libSelected]) if (!other.startsWith(modeKey + '|')) libSelected.delete(other);
        libSelected.add(k);
      } else libSelected.delete(k);
      for (const b of box.querySelectorAll('input[type="checkbox"]')) b.checked = libSelected.has(b.dataset.key);
      updateLibCategoryBar();
    };
    row.querySelector('.lib-rename').onclick = () => libRenameCategory(modeKey, name);
    row.querySelector('.lib-remove').onclick = () => libRemoveCategory(modeKey, name);
  }
  updateLibCategoryBar();
}

function updateLibCategoryBar() {
  const n = libSelected.size;
  $('#lib-bar').hidden = n < 2;
  $('#lib-count').textContent = `${n} Kategorien`;
  const btn = $('#lib-action');
  btn.textContent = 'Zusammenfassen';
  btn.className = '';
}

// Ersetzt die Kategorien "from" durch "to" (null = entfernen), ohne Doppelte
async function libApplyCategories(modeKey, from, to, message, doneText) {
  const excludedBefore = localStorage.getItem(TINDER_EXCLUDED_KEY);
  const done = await libCommit(message, remote => {
    const changed = [];
    for (const r of remote.recipes) {
      if ((r.bereich || 'kochen') !== modeKey) continue;
      const cats = recipeCategories(r);
      if (!cats.some(c => from.includes(c))) continue;
      const before = r.category;
      r.category = [...new Set(cats.map(c => from.includes(c) ? to : c).filter(Boolean))];
      changed.push({ id: r.id, before, after: JSON.stringify(r.category) });
    }
    return changed;
  });
  if (!done) return;
  // Gemerkte Auswahlen mitziehen: Food-Match-Ausschlüsse und aktiver Filter
  const excluded = tinderExcludedCategories();
  const stillExists = new Set(data.recipes.flatMap(recipeCategories));
  const next = [...new Set(excluded.flatMap(c => {
    if (!from.includes(c)) return [c];
    return [to, stillExists.has(c) ? c : null].filter(Boolean);
  }))];
  localStorage.setItem(TINDER_EXCLUDED_KEY, JSON.stringify(next));
  if (from.includes(activeCategory)) activeCategory = 'Alle';
  libSelected = new Set();
  render();
  renderLibCategoryList();
  offerCategoryUndo(doneText, done.result, excludedBefore);
}

function offerCategoryUndo(label, changed, excludedBefore) {
  const offer = text => toastUndo(text, async () => {
    const done = await libCommit('Kategorien wiederhergestellt (vom Handy)', remote => {
      for (const c of changed) {
        const r = remote.recipes.find(x => x.id === c.id);
        // inzwischen anders bearbeitete Rezepte nicht überschreiben
        if (r && JSON.stringify(r.category) === c.after) r.category = c.before;
      }
    });
    if (!done) return offer('Nicht wiederhergestellt');
    if (excludedBefore === null) localStorage.removeItem(TINDER_EXCLUDED_KEY);
    else localStorage.setItem(TINDER_EXCLUDED_KEY, excludedBefore);
    renderLibCategoryList();
    toast('Wiederhergestellt ✓');
  }, { ms: 8000 });
  offer(label.replace(' ✓', ''));
}

// Kleiner Dialog mit Namensfeld (und optionalen Vorschlägen)
function libAskName(title, preset, suggestions, onOk) {
  const modal = document.createElement('div');
  modal.className = 'ed-modal-overlay';
  modal.innerHTML = `<div class="ed-modal">
    <h3>${esc(title)}</h3>
    ${suggestions.length ? `<div class="lib-suggest">${suggestions.map(s => `<button type="button">${esc(s)}</button>`).join('')}</div>` : ''}
    <div class="ed-cat-new"><input id="lib-name" value="${esc(preset)}" placeholder="Name der Kategorie" autocomplete="off"></div>
    <div class="ed-modal-buttons"><button type="button" class="ed-modal-cancel">Abbrechen</button><button type="button" class="ed-modal-ok">Speichern</button></div>
  </div>`;
  document.body.appendChild(modal);
  const input = modal.querySelector('#lib-name');
  for (const b of modal.querySelectorAll('.lib-suggest button')) b.onclick = () => { input.value = b.textContent; };
  modal.querySelector('.ed-modal-cancel').onclick = () => modal.remove();
  modal.querySelector('.ed-modal-ok').onclick = () => {
    const name = input.value.trim();
    if (!name) return toast('Bitte einen Namen eingeben');
    if (name.toLowerCase() === 'alle') return toast('„Alle“ ist reserviert');
    modal.remove();
    onOk(name);
  };
  modal.onclick = ev => { if (ev.target === modal) modal.remove(); };
}

function libRenameCategory(modeKey, oldName) {
  libAskName(`„${oldName}“ umbenennen`, oldName, [], name => {
    if (name === oldName) return;
    const exists = libCategoryCounts(modeKey).some(([c]) => c === name);
    if (exists && !confirm(`„${name}“ gibt es schon. Beide Kategorien zusammenfassen?`)) return;
    libApplyCategories(modeKey, [oldName], name, `Kategorie ${oldName} -> ${name} (vom Handy)`, 'Umbenannt ✓');
  });
}

function libRemoveCategory(modeKey, name) {
  const n = libCategoryCounts(modeKey).find(([c]) => c === name)?.[1] || 0;
  if (!confirm(`Kategorie „${name}“ entfernen?\n\nSie wird aus ${n === 1 ? '1 Rezept' : n + ' Rezepten'} entfernt. Die Rezepte bleiben erhalten.`)) return;
  libApplyCategories(modeKey, [name], null, `Kategorie ${name} entfernt (vom Handy)`, 'Kategorie entfernt ✓');
}

function libMergeCategories() {
  const keys = [...libSelected];
  if (keys.length < 2) return;
  const modeKey = keys[0].split('|')[0];
  const names = keys.map(k => k.slice(k.indexOf('|') + 1));
  libAskName(`${names.length} Kategorien zusammenfassen`, names[0], names, target => {
    libApplyCategories(modeKey, names, target, `Kategorien zusammengefasst zu ${target} (vom Handy)`, 'Zusammengefasst ✓');
  });
}
