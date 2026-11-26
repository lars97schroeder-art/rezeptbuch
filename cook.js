'use strict';

/* Kochmodus (ein Schritt pro Seite, Zutaten abhaken, Timer, Bildschirm an)
   sowie Textgröße, Datensicherung, Offline-Fotos und Hilfe.
   Nutzt zur Laufzeit die Funktionen und Daten aus app.js. */

const COOK_WAKE_KEY = 'rezeptbuch-cook-wake';
const COOK_SIZE_KEY = 'rezeptbuch-cook-size';
const COOK_ING_KEY = 'rezeptbuch-cook-ingredients-first';
const COOK_STATE_KEY = libKey('rezeptbuch-cook-state');
const TEXT_SIZE_KEY = 'rezeptbuch-text-size';
const COOK_RESUME_MS = 24 * 60 * 60 * 1000;

const cookFlag = key => localStorage.getItem(key) !== 'false'; // Standard: an
const cookSize = () => ['normal', 'large', 'xl'].includes(localStorage.getItem(COOK_SIZE_KEY))
  ? localStorage.getItem(COOK_SIZE_KEY) : 'large';

/* ---------- Textgröße der App ---------- */

const TEXT_SIZES = ['1', '1.12', '1.25'];
const textSize = () => TEXT_SIZES.includes(localStorage.getItem(TEXT_SIZE_KEY)) ? localStorage.getItem(TEXT_SIZE_KEY) : '1';
function applyTextSize(value = textSize()) {
  localStorage.setItem(TEXT_SIZE_KEY, value);
  document.documentElement.style.setProperty('--fs', value);
}
applyTextSize();

/* ---------- Kochmodus ---------- */

let cook = null; // { recipe, ingredients, steps, pages, page, checked, box }

const cookIngredients = r => (r.ingredients || []).map(x => String(x).trim()).filter(Boolean);
const cookSteps = r => (r.steps || []).map(x => String(x).trim()).filter(Boolean);
const canCook = r => cookIngredients(r).length > 0 || cookSteps(r).length > 0;

function cookStates() {
  try { return JSON.parse(localStorage.getItem(COOK_STATE_KEY)) || {}; } catch (e) { return {}; }
}
function saveCookState() {
  if (!cook) return;
  const all = cookStates();
  const done = cook.pages[cook.page].type === 'done';
  if (done) delete all[cook.recipe.id];
  else all[cook.recipe.id] = { page: cook.page, checked: [...cook.checked], ts: Date.now() };
  localStorage.setItem(COOK_STATE_KEY, JSON.stringify(all));
}

function openCook(id) {
  const recipe = data.recipes.find(r => r.id === id);
  if (!recipe || cook || !canCook(recipe)) return;
  const ingredients = cookIngredients(recipe);
  const steps = cookSteps(recipe);
  const pages = [];
  if (ingredients.length && (cookFlag(COOK_ING_KEY) || !steps.length)) pages.push({ type: 'ing' });
  steps.forEach((text, i) => pages.push({ type: 'step', text, i }));
  pages.push({ type: 'done' });

  const saved = cookStates()[id];
  const resume = saved && Date.now() - saved.ts < COOK_RESUME_MS;

  const box = document.createElement('div');
  box.className = 'cook cook-' + cookSize();
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Kochmodus');
  box.innerHTML = `
    <div class="cook-head">
      <button type="button" class="cook-icon cook-close" aria-label="Kochmodus schließen">✕</button>
      <div class="cook-where"></div>
      <button type="button" class="cook-icon cook-list" aria-label="Zutaten anzeigen">☰</button>
    </div>
    <div class="cook-progress"><span></span></div>
    <div class="cook-timers"></div>
    <div class="cook-body"></div>
    <div class="cook-foot">
      <button type="button" class="cook-back" aria-label="Zurück">←</button>
      <button type="button" class="cook-next"></button>
    </div>
    <div class="cook-sheet" hidden>
      <div class="cook-sheet-panel">
        <div class="cook-sheet-head"><span>Zutaten</span><button type="button" class="cook-icon cook-sheet-close" aria-label="Schließen">✕</button></div>
        <div class="cook-sheet-list"></div>
      </div>
    </div>`;
  document.body.appendChild(box);
  history.pushState({ ...history.state, view: 'cook', depth: navDepth() + 1 }, '');

  cook = {
    recipe, ingredients, steps, pages, box,
    page: resume ? Math.min(saved.page, pages.length - 1) : 0,
    checked: new Set(resume ? saved.checked : []),
  };

  const q = s => box.querySelector(s);
  q('.cook-close').onclick = () => history.back();
  q('.cook-back').onclick = () => cookGo(-1);
  q('.cook-next').onclick = () => cookGo(1);
  q('.cook-list').onclick = () => { renderCookIngredients(q('.cook-sheet-list')); q('.cook-sheet').hidden = false; };
  q('.cook-sheet-close').onclick = () => { q('.cook-sheet').hidden = true; renderCook(); };
  q('.cook-sheet').onclick = e => { if (e.target === q('.cook-sheet')) q('.cook-sheet-close').click(); };

  // Seitlich wischen blättert
  let start = null;
  box.addEventListener('touchstart', e => {
    start = e.touches.length === 1 && q('.cook-sheet').hidden && !e.target.closest('.cook-timers')
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  box.addEventListener('touchend', e => {
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) cookGo(dx < 0 ? 1 : -1, true);
  });

  renderCook();
  renderCookTimers();
  keepScreenOn();
  if (resume && cook.page > 0) toast('Weiter, wo du aufgehört hast');
}

// Wird von popstate aufgerufen (✕, Zurück-Geste)
function closeCook() {
  if (!cook) return;
  const { box } = cook;
  saveCookState();
  cook = null;
  box.remove();
  releaseScreen();
}

function cookGo(direction, swiped = false) {
  const next = cook.page + direction;
  if (next < 0) return;
  if (next >= cook.pages.length) { if (!swiped) history.back(); return; }
  cook.page = next;
  renderCook();
}

// Kamera direkt öffnen; das Foto wird sofort beim Rezept gespeichert
function wireCookPhoto(body, id) {
  const button = body.querySelector('.cook-photo');
  const input = body.querySelector('.cook-camera');
  const result = body.querySelector('.cook-photo-result');
  let failed = null; // nicht gespeichertes Foto für einen neuen Versuch
  const upload = async file => {
    button.disabled = true;
    button.textContent = 'Wird hochgeladen …';
    try {
      const preview = await addPhotoToRecipe(id, file);
      failed = null;
      result.innerHTML = `<img src="${preview}" alt="Dein Foto"><p>Beim Rezept gespeichert ✓</p>`;
      button.textContent = 'Noch ein Foto';
    } catch (err) {
      failed = file;
      result.textContent = 'Nicht gespeichert: ' + err.message;
      button.textContent = 'Erneut versuchen';
    }
    button.disabled = false;
  };
  button.onclick = () => { if (failed) upload(failed); else input.click(); };
  input.onchange = () => {
    const file = input.files[0];
    input.value = '';
    if (file) upload(file);
  };
}

function renderCookIngredients(container) {
  container.innerHTML = cook.ingredients.map((text, i) => {
    // Zwischenüberschrift: "*Teig" oder eine reine GROSSBUCHSTABEN-Zeile
    const heading = text.match(/^\*\s*(.+)/) || (/^[A-ZÄÖÜ][A-ZÄÖÜ .:&()-]{3,}$/.test(text) ? [text, text] : null);
    if (heading) return `<div class="cook-heading">${esc(heading[1])}</div>`;
    return `<label class="cook-ing"><input type="checkbox" data-i="${i}" ${cook.checked.has(i) ? 'checked' : ''}><span>${esc(text)}</span></label>`;
  }).join('') || '<p class="cook-note">Keine Zutaten eingetragen.</p>';
  for (const input of container.querySelectorAll('input')) {
    input.onchange = () => {
      const i = Number(input.dataset.i);
      if (input.checked) cook.checked.add(i); else cook.checked.delete(i);
      saveCookState();
    };
  }
}

function renderCook() {
  const q = s => cook.box.querySelector(s);
  const page = cook.pages[cook.page];
  const body = q('.cook-body');
  q('.cook-where').textContent = page.type === 'ing' ? 'Zutaten'
    : page.type === 'step' ? `Schritt ${page.i + 1} von ${cook.steps.length}` : 'Fertig';
  q('.cook-progress span').style.width = (cook.page / (cook.pages.length - 1) * 100) + '%';
  q('.cook-list').style.visibility = page.type === 'step' && cook.ingredients.length ? 'visible' : 'hidden';
  q('.cook-back').style.visibility = cook.page > 0 ? 'visible' : 'hidden';
  const nextPage = cook.pages[cook.page + 1];
  q('.cook-next').textContent = page.type === 'done' ? 'Schließen'
    : page.type === 'ing' && nextPage.type === 'step' ? 'Los geht’s'
    : nextPage.type === 'done' ? 'Fertig' : 'Weiter';

  if (page.type === 'ing') {
    body.innerHTML = `<h2>${esc(cook.recipe.title)}</h2><div></div>
      ${cook.steps.length ? '' : '<p class="cook-note">Für dieses Rezept sind noch keine Zubereitungsschritte eingetragen.</p>'}`;
    renderCookIngredients(body.querySelector('div'));
  } else if (page.type === 'step') {
    const times = stepTimes(page.text);
    // Aktueller Schritt groß, darunter die folgenden ausgegraut (wie Songtexte)
    const upcoming = cook.pages.map((p, index) => ({ ...p, index })).filter(p => p.type === 'step' && p.index > cook.page);
    body.innerHTML = `<div class="cook-flow"><p class="cook-step">${esc(page.text)}</p>
      <div class="cook-timer-buttons">${times.map((t, i) => `<button type="button" data-i="${i}">Timer ${esc(t.label)} starten</button>`).join('')}</div>
      ${upcoming.length ? `<div class="cook-upcoming">${upcoming.map(p =>
        `<button type="button" data-page="${p.index}" aria-label="Zu Schritt ${p.i + 1}">${esc(p.text)}</button>`).join('')}</div>` : ''}</div>`;
    for (const b of body.querySelectorAll('.cook-upcoming button')) {
      b.onclick = () => { cook.page = Number(b.dataset.page); renderCook(); };
    }
    for (const b of body.querySelectorAll('.cook-timer-buttons button')) {
      b.onclick = () => startTimer(times[Number(b.dataset.i)], `Schritt ${page.i + 1}`);
    }
  } else {
    const mayEdit = isEditModeEnabled();
    body.innerHTML = `<div class="cook-done"><div class="cook-done-emoji">${emojiFor(cook.recipe)}</div>
      <h2>Guten Appetit</h2>
      ${mayEdit ? `<p class="cook-note">Lust, ein Foto vom Ergebnis zu machen?</p>
        <button type="button" class="cook-photo">Foto aufnehmen</button>
        <input type="file" class="cook-camera" accept="image/*" capture="environment" hidden>
        <div class="cook-photo-result" aria-live="polite"></div>` : ''}</div>`;
    if (mayEdit) wireCookPhoto(body, cook.recipe.id);
  }
  body.scrollTop = 0;
  saveCookState();
}

/* ---------- Bildschirm anlassen ---------- */

let wakeLock = null;
async function keepScreenOn() {
  if (!cook || !cookFlag(COOK_WAKE_KEY) || !navigator.wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!cook) return lock.release();
    wakeLock = lock;
  } catch (e) { /* z. B. Stromsparmodus: Kochmodus läuft trotzdem */ }
}
function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
// Das System gibt die Sperre frei, sobald die App in den Hintergrund geht
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { keepScreenOn(); tickTimers(); }
});

/* ---------- Timer ---------- */

// Zeitangaben im Schritt finden: "10 Minuten", "20-25 Min.", "1,5 Stunden"
function stepTimes(text) {
  const pattern = /(\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?|½)(?:\s*(?:-|–|bis)\s*\d+(?:[.,]\d+)?)?\s*(stunden?|std\b\.?|h\b|minuten?|min\b\.?|sekunden?|sek\b\.?)/gi;
  const found = [];
  for (const m of text.matchAll(pattern)) {
    const raw = m[1].replace(/\s/g, '');
    const value = raw === '½' ? 0.5 : raw.includes('/') ? raw.split('/')[0] / raw.split('/')[1] : Number(raw.replace(',', '.'));
    const unit = m[2].toLowerCase();
    const factor = unit.startsWith('se') ? 1 : unit.startsWith('mi') ? 60 : 3600;
    const seconds = Math.round(value * factor);
    if (seconds > 0 && seconds <= 24 * 3600 && !found.some(f => f.seconds === seconds)) {
      found.push({ seconds, label: `${String(value).replace('.', ',')} ${factor === 1 ? 'Sek' : factor === 60 ? 'Min' : 'Std'}` });
    }
  }
  return found;
}

let timers = [];
let timerTick = null;
let audio = null;

function startTimer(time, where) {
  // Ton darf auf dem iPhone nur nach einem Antippen vorbereitet werden
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch (e) { /* ohne Ton */ }
  timers.push({ end: Date.now() + time.seconds * 1000, label: time.label, where, done: false });
  if (!timerTick) timerTick = setInterval(tickTimers, 500);
  renderCookTimers();
}

function timerAlarm() {
  if (!audio) return;
  audio.resume();
  for (let i = 0; i < 6; i++) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const at = audio.currentTime + i * 0.35;
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.27);
  }
}

function tickTimers() {
  for (const t of timers) {
    if (t.done || Date.now() < t.end) continue;
    t.done = true;
    timerAlarm();
    toast(`Timer fertig: ${t.label} (${t.where})`);
  }
  if (!timers.some(t => !t.done)) { clearInterval(timerTick); timerTick = null; }
  renderCookTimers();
}

function renderCookTimers() {
  const row = cook?.box.querySelector('.cook-timers');
  if (!row) return;
  const clock = ms => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  // Knöpfe nur neu bauen, wenn sich die Anzahl ändert (sonst verpufft ein Antippen)
  if (row.children.length !== timers.length) {
    row.innerHTML = timers.map((t, i) => `<button type="button" class="cook-timer" data-i="${i}"><small></small><strong></strong><span aria-hidden="true">✕</span></button>`).join('');
    for (const b of row.children) {
      b.onclick = () => {
        const [removed] = timers.splice(Number(b.dataset.i), 1);
        renderCookTimers();
        if (!removed.done) toastUndo('Timer gestoppt', () => {
          timers.push(removed);
          if (!timerTick) timerTick = setInterval(tickTimers, 500);
          tickTimers();
        });
      };
    }
  }
  timers.forEach((t, i) => {
    const b = row.children[i];
    b.classList.toggle('done', t.done);
    b.querySelector('small').textContent = t.where;
    b.querySelector('strong').textContent = t.done ? 'Fertig' : clock(t.end - Date.now());
  });
}

/* ---------- Datensicherung ---------- */

// Alles außer dem Token als eine Datei speichern/teilen
async function exportBackup() {
  const content = JSON.stringify({
    exported: new Date().toISOString(),
    recipes: data,
    weekplan: getAllWeekplans(),
    backlog: getBacklogItems(),
  }, null, 2);
  const name = `schlemmerliste-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([content], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  toast('Sicherung gespeichert');
}

/* ---------- Fotos offline ---------- */

async function photoStatus() {
  const wanted = [...new Set(data.recipes.flatMap(imagesOf))];
  if (!window.caches) return { wanted, missing: wanted };
  const cache = await caches.open(IMG_CACHE);
  const missing = [];
  for (const path of wanted) if (!await cache.match(assetURL(path), { ignoreSearch: true })) missing.push(path);
  return { wanted, missing };
}

let photoLoading = false;
async function updatePhotoRow() {
  const hint = document.querySelector('#photos-btn .set-hint');
  if (!hint || photoLoading) return;
  const { wanted, missing } = await photoStatus();
  hint.textContent = missing.length
    ? `${wanted.length - missing.length} von ${wanted.length} auf diesem Handy · antippen zum Laden`
    : `Alle ${wanted.length} Fotos sind auf diesem Handy`;
}

async function downloadPhotos() {
  if (photoLoading) return;
  if (localStorage.getItem(OFFLINE_MODE_KEY) === 'true') return toast('Im Offline-Modus nicht möglich');
  photoLoading = true;
  let failed = 0;
  try {
    const { missing } = await photoStatus();
    const cache = await caches.open(IMG_CACHE);
    for (let i = 0; i < missing.length; i++) {
      const hint = document.querySelector('#photos-btn .set-hint');
      if (hint) hint.textContent = `Lade Foto ${i + 1} von ${missing.length} …`;
      try {
        const url = assetURL(missing[i]);
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status);
        await cache.put(url, res);
      } catch (e) { failed++; }
    }
    toast(failed ? `${failed} Fotos konnten nicht geladen werden` : 'Alle Fotos gespeichert ✓');
  } finally {
    photoLoading = false;
    updatePhotoRow();
  }
}

/* ---------- Hilfe ---------- */

// Zeile: [Überschrift, Erklärung, optional Zeichen davor]
const helpRow = ([title, text, mark = '', tone = '']) => `<div class="help-row">
  ${mark ? `<span class="help-mark ${tone}" aria-hidden="true">${mark}</span>` : ''}
  <span class="set-text"><span class="set-title">${title}</span><span class="set-hint">${text}</span></span>
</div>`;

// Aufklappbares Thema mit kurzer Einleitung und Abschnitten
const helpTopic = (title, intro, parts) => `<details class="help-topic">
  <summary><span class="set-text"><span class="set-title">${title}</span><span class="set-hint">${intro}</span></span></summary>
  <div class="help-body">${parts.map(([heading, rows]) =>
    `${heading ? `<h4>${heading}</h4>` : ''}${rows.map(helpRow).join('')}`).join('')}</div>
</details>`;

function openHelp() {
  enterOverlay('help');
  const el = $('#editor');
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="ed-body settings-body">
      <h2>Hilfe und Gesten</h2>
      ${helpTopic('Food Match', 'Wenn keiner weiß, was es geben soll', [
        ['So läuft es', [
          ['Karten wischen', 'Du bekommst Rezepte in zufälliger Reihenfolge: aus dem gewählten Bereich, passend zu Kategorie und Suche auf der Startseite.', '1'],
          ['Drei Favoriten sammeln', 'Oben siehst du, wie viele du schon hast. Nach dem dritten heißt es „It’s a Match!“.', '2'],
          ['Das Los entscheidet', 'Eines der drei wird ausgelost. Tippe auf den Namen, um das Rezept zu öffnen, oder verschicke es als Nachricht.', '3']]],
        ['Knöpfe und Wischen', [
          ['Will ich', 'Nach rechts wischen oder auf das Herz tippen.', ICON.heart, 'good'],
          ['Nö', 'Nach links wischen oder auf das Kreuz tippen.', ICON.cross, 'bad'],
          ['Superlike', 'Der Stern: Genau das gibt es. Das Rezept öffnet sich sofort, ohne Auslosen.', ICON.star]]],
        ['Gut zu wissen', [
          ['Nochmal mischen', 'Nach dem Match wird nur neu gelost. Hast du alles weggewischt, startet eine neue Runde.'],
          ['Kategorien ausschließen', 'Zum Beispiel Saucen oder Beilagen: Einstellungen → Rezepte → Food Match.']]]])}

      ${helpTopic('Startseite', 'Finden, filtern, sortieren', [
        ['', [
          ['Bereich wechseln', 'Oben zwischen Frühstück, Kochen und Backen umschalten.'],
          ['Suchen und filtern', 'Nach Rezept oder Zutat suchen oder eine Kategorie antippen. Daneben sortierst du.'],
          ['Mehr Platz', 'Beim Runterscrollen verschwinden Suche und Kategorien, beim Hochscrollen sind sie wieder da.'],
          ['Neu und Update', 'Frisch hinzugefügte oder geänderte Rezepte sind einen Tag lang markiert.']]]])}

      ${helpTopic('Rezepte', 'Ansehen, bearbeiten, teilen', [
        ['', [
          ['Foto antippen', 'Groß ansehen. Mit zwei Fingern oder doppeltem Tippen zoomen, nach unten wischen zum Schließen.'],
          ['Teilen', 'Der Pfeil oben rechts macht aus dem Rezept ein Bild zum Verschicken.'],
          ['Bearbeiten', 'Mit Zugang: über den Stift. Neue Rezepte legst du über die Plus-Kachel an.'],
          ['Aus Foto oder Link', 'Beim neuen Rezept liest die KI Fotos oder Rezeptseiten aus. Bitte kurz prüfen.']]]])}

      ${helpTopic('Kochmodus', 'Schritt für Schritt am Herd', [
        ['', [
          ['Starten', '„Kochen starten“ im Rezept. Erst Zutaten abhaken, dann folgt ein Schritt nach dem anderen.'],
          ['Blättern', 'Mit „Weiter“ oder seitlich wischen. Tippe auf einen blassen Schritt, um dorthin zu springen.'],
          ['Zutaten nachsehen', 'Das Symbol oben rechts zeigt die Liste, ohne den Schritt zu verlassen.'],
          ['Timer', 'Zeitangaben im Schritt werden zu Timer-Knöpfen. Der Ton kommt nur bei offener App und lautem iPhone.'],
          ['Foto zum Schluss', 'Am Ende die Kamera öffnen, das Foto landet beim Rezept.']]]])}

      ${helpTopic('Wochenplan und Backlog', 'Planen und Ideen sammeln', [
        ['', [
          ['Eintragen', 'Beim Tag oder im Backlog tippen und ein Rezept wählen. Mit dem Plus wird daraus eine freie Notiz.'],
          ['Verschieben', 'Den Griff links kurz gedrückt halten, dann auf einen anderen Tag oder ins Backlog ziehen.'],
          ['Tag ausblenden', 'Das Minus am Tag, falls ihr nicht kocht.'],
          ['Wochen wechseln', 'Mit den Pfeilen oben. Alle in der Bibliothek sehen denselben Plan.']]]])}
    </div>`;
  el.querySelector('.detail-close').onclick = () => closeOverlay();
  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}
