'use strict';

/* Mehrere Rezepte auf einmal anlegen: pro Zeile ein Gerichtname oder ein Link.
   Links liest der KI-Dienst kostenlos aus. Vor dem Speichern gibt es eine Liste
   zum Prüfen; gespeichert wird alles in einem Schritt.
   Nutzt zur Laufzeit die Funktionen aus app.js und editor.js. */

const BULK_MAX = 100;
const BULK_MAX_LINKS = 30; // schont das Tageskontingent der Gratis-KI
let bulkText = '';

// Eine Zeile je Eintrag; Aufzählungszeichen und Nummern fallen weg
function parseBulkLines(text) {
  return text.split('\n').map(line => {
    const url = line.match(/https?:\/\/[^\s<>"]+/)?.[0];
    if (url) return { url };
    const name = line.replace(/^\s*(?:[-*•–]|\d{1,3}[.)])\s+/, '').trim();
    return name ? { name: name.slice(0, 80) } : null;
  }).filter(Boolean).slice(0, BULK_MAX);
}

function openBulkAdd() {
  if (!isEditModeEnabled()) return toast('Dafür braucht es einen Zugang, Bearbeiten und eine Online-Verbindung');
  // aus "Neues Rezept" heraus: dessen Verlaufseintrag ersetzen
  if (history.state?.page === 'edit') replaceView({ view: 'overlay', page: 'bulk' });
  else enterOverlay('bulk');
  const el = $('#editor');
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="ed-body bulk-body">
      <h2>Mehrere hinzufügen</h2>
      <p class="ed-text">Pro Zeile ein Gericht oder ein Link zu einem Rezept. Namen werden ohne Details angelegt, Links liest die App aus.</p>
      <div class="ed-field"><label>Bereich</label>
        <select id="bulk-bereich">${Object.entries(MODES).map(([key, m]) =>
          `<option value="${key}"${key === mode ? ' selected' : ''}>${m.label}</option>`).join('')}</select></div>
      <div class="ed-field"><label>Liste</label>
        <textarea id="bulk-text" rows="10" placeholder="Spaghetti Carbonara&#10;Linsensuppe&#10;https://www.chefkoch.de/rezepte/…" autocapitalize="sentences"></textarea></div>
      <button type="button" class="bulk-go" id="bulk-check">Weiter zum Prüfen</button>
      <div id="bulk-result"></div>
    </div>`;
  el.querySelector('.detail-close').onclick = () => closeOverlay();
  const area = el.querySelector('#bulk-text');
  area.value = bulkText;
  area.oninput = () => { bulkText = area.value; };
  el.querySelector('#bulk-check').onclick = () => checkBulk(el);
  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

async function checkBulk(el) {
  const lines = parseBulkLines(el.querySelector('#bulk-text').value);
  if (!lines.length) return toast('Die Liste ist leer');
  if (lines.filter(l => l.url).length > BULK_MAX_LINKS) return toast(`Bitte höchstens ${BULK_MAX_LINKS} Links auf einmal`);
  const button = el.querySelector('#bulk-check');
  const result = el.querySelector('#bulk-result');
  const bereich = el.querySelector('#bulk-bereich').value;
  button.disabled = true;
  result.innerHTML = '';
  const known = new Set(data.recipes.map(r => r.title.trim().toLowerCase()));
  const entries = [];
  for (const [i, line] of lines.entries()) {
    if (!result.isConnected) return; // Seite verlassen: abbrechen
    button.textContent = `Lese ${i + 1} von ${lines.length} …`;
    let entry;
    if (line.url) {
      try {
        const found = await askScanService({ url: line.url });
        if (!found.title) throw new Error('Kein Titel gefunden');
        entry = {
          title: found.title,
          info: `${(found.ingredients || []).length} Zutaten, ${(found.steps || []).length} Schritte`,
          recipe: { ...found, source: line.url },
        };
      } catch (err) {
        entry = { title: line.url, error: err.message };
      }
    } else {
      entry = { title: line.name, info: 'nur Name', recipe: { title: line.name } };
    }
    if (!entry.error) {
      const key = entry.title.trim().toLowerCase();
      entry.duplicate = known.has(key);
      known.add(key);
    }
    entries.push(entry);
  }
  if (!result.isConnected) return;
  button.disabled = false;
  button.textContent = 'Liste neu prüfen';
  showBulkResult(result, entries, bereich);
}

function showBulkResult(result, entries, bereich) {
  result.innerHTML = `<div class="lib-list">${entries.map((e, i) => `
    <label class="lib-row${e.error ? ' bulk-failed' : ''}">
      <input type="checkbox" data-i="${i}" ${e.error ? 'disabled' : e.duplicate ? '' : 'checked'}>
      <span class="lib-text">${esc(e.title)}<small>${esc(e.error || (e.duplicate ? `gibt es schon · ${e.info}` : e.info))}</small></span>
    </label>`).join('')}</div>
    <button type="button" class="bulk-go" id="bulk-save"></button>`;
  const save = result.querySelector('#bulk-save');
  const chosen = () => [...result.querySelectorAll('input:checked')].map(c => entries[Number(c.dataset.i)]);
  const update = () => {
    const n = chosen().length;
    save.disabled = !n;
    save.textContent = n === 1 ? '1 Rezept hinzufügen' : `${n} Rezepte hinzufügen`;
  };
  for (const box of result.querySelectorAll('input')) box.onchange = update;
  update();
  save.onclick = async () => {
    save.disabled = true;
    if (!await saveBulk(chosen().map(e => e.recipe), bereich)) update();
  };
  save.scrollIntoView({ block: 'nearest' });
}

async function saveBulk(found, bereich) {
  const now = new Date().toISOString();
  const label = found.length === 1 ? '1 Rezept' : `${found.length} Rezepte`;
  const done = await libCommit(`${label} hinzugefügt (vom Handy)`, remote => {
    const ids = new Set(remote.recipes.map(r => r.id));
    return found.map(f => {
      const base = slugify(f.title);
      let id = base, n = 2;
      while (ids.has(id)) id = `${base}-${n++}`;
      ids.add(id);
      const minutes = parseTimeMinutes(f.time);
      remote.recipes.push({
        id, title: f.title, category: [],
        time: isFinite(minutes) ? formatDuration(minutes) : '',
        servings: f.servings || '', emoji: f.emoji || '', image: '', images: [],
        ingredients: f.ingredients || [], steps: f.steps || [],
        notes: f.source ? `Quelle: ${f.source}` : '',
        bereich, created: now, updated: now, createdBy: userName(), updatedBy: userName(),
      });
      return id;
    });
  });
  if (!done) return false;
  bulkText = '';
  const added = new Set(done.result);
  closeOverlay();
  toastUndo(`${label} hinzugefügt`, async () => {
    const ok = await libCommit(`${label} wieder entfernt (vom Handy)`, remote => {
      remote.recipes = remote.recipes.filter(r => !added.has(r.id));
    });
    if (ok) toast('Wieder entfernt ✓');
  }, { ms: 8000 });
  return true;
}
