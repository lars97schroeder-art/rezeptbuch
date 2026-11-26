'use strict';

/* Bibliotheken teilen: Codes, Beitreten (samt Einrichtung einer neuen),
   Entfernen vom Gerät und Rezepte in eine andere Bibliothek kopieren.
   Ein "Code" ist Speicher-Adresse + Token in einem Text.
   Nutzt zur Laufzeit die Funktionen aus app.js und editor.js. */

const CODE_PREFIX = 'SL1.';
// Nur Daten-Speicher dieses Kontos (so prüft auch der KI-Dienst)
const LIBRARY_REPO = /^lars97schroeder-art\/schlemmer-daten-[\w.-]+$/;

function encodeLibraryCode(repo, token) {
  return CODE_PREFIX + btoa(JSON.stringify([repo, token])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Liefert { repo, token } oder null. Ein blanker Token gilt für die erste Bibliothek
function decodeLibraryCode(text) {
  const raw = String(text).replace(/\s+/g, '');
  if (/^(github_pat_|ghp_)\w+$/.test(raw)) return { repo: DATA_REPO, token: raw };
  if (!raw.startsWith(CODE_PREFIX)) return null;
  try {
    const [repo, token] = JSON.parse(atob(raw.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')));
    return LIBRARY_REPO.test(repo) && /^\w{20,255}$/.test(token) ? { repo, token } : null;
  } catch (e) { return null; }
}

const libraryToken = lib => lib.id === 'main' ? localStorage.getItem(TOKEN_KEY) || '' : lib.token || '';

// Anfrage an eine Datei in einem beliebigen Speicher
function repoFile(repo, token, path, options = {}) {
  return fetch(`https://api.github.com/repos/${repo}/contents/${encodeURI(path)}${options.method ? '' : '?t=' + Date.now()}`, {
    cache: 'no-store',
    ...options,
    headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
  });
}

// { sha, json } oder null, wenn es die Datei noch nicht gibt
async function readRepoFile(repo, token, path) {
  const res = await repoFile(repo, token, path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(ghErrorMessage(res.status, path));
  const file = await res.json();
  return { sha: file.sha, json: JSON.parse(utf8b64(file.content)) };
}

async function writeRepoFile(repo, token, path, base64, message, sha) {
  const res = await repoFile(repo, token, path, {
    method: 'PUT',
    body: JSON.stringify({ message: signMessage(message), content: base64, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(ghErrorMessage(res.status, path));
}

const writeRepoJSON = (repo, token, path, json, message, sha) =>
  writeRepoFile(repo, token, path, b64utf8(JSON.stringify(json, null, 2)), message, sha);

const emptyRecipeFile = name => ({ version: '5.5', updated: new Date().toISOString(), libraryName: name, recipes: [] });

// Frisch angelegter Speicher: die Dateien anlegen, die die App erwartet
async function setUpLibrary(repo, token, name) {
  const updated = new Date().toISOString();
  for (const [path, empty] of [['data/weekplan.json', { updated, weeks: {} }], ['data/backlog.json', { updated, items: [] }]]) {
    if (!await readRepoFile(repo, token, path)) await writeRepoJSON(repo, token, path, empty, 'Bibliothek eingerichtet');
  }
  // zuletzt: erst mit den Rezepten gilt die Bibliothek als eingerichtet
  await writeRepoJSON(repo, token, 'data/recipes.json', emptyRecipeFile(name), `Bibliothek ${name} eingerichtet`);
}

// Bibliothek auf diesem Gerät eintragen und als geöffnet merken
function rememberLibrary({ repo, token, name }) {
  if (repo === DATA_REPO) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(MAIN_MOVED_KEY, 'true');
    localStorage.setItem(ACTIVE_LIBRARY_KEY, 'main');
    return;
  }
  const more = libraries().filter(l => l.id !== 'main');
  let entry = more.find(l => l.repo === repo);
  if (entry) entry.token = token;
  else {
    entry = { id: 'l' + Date.now().toString(36), name, repo, token };
    more.push(entry);
  }
  localStorage.setItem(LIBRARIES_KEY, JSON.stringify(more));
  localStorage.setItem(ACTIVE_LIBRARY_KEY, entry.id);
}

const reloadApp = () => location.replace(location.pathname + '?bib=' + Date.now());

/* ---------- Beitreten ---------- */

// first: Vollbild ohne Abbrechen, solange das Gerät noch keine Bibliothek hat
function openJoinDialog(first = false) {
  if (document.querySelector('.join-dialog')) return;
  const box = document.createElement('div');
  box.className = `${first ? 'setup' : 'ed-modal-overlay'} join-dialog`;
  const iPhoneBrowser = /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone;
  box.innerHTML = `<form class="${first ? 'setup-card' : 'ed-modal'}">
    <h3>${first ? 'Hast du einen Code?' : 'Bibliothek hinzufügen'}</h3>
    <p class="setting-hint join-text">${first && iPhoneBrowser
      ? 'Tipp: Leg die App zuerst auf den Home-Bildschirm (Teilen → „Zum Home-Bildschirm“) und gib den Code dort ein.'
      : 'Den Code bekommst du von jemandem aus der Bibliothek.'}</p>
    <div class="ed-cat-new join-code"><input name="code" placeholder="Code einfügen" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <div class="ed-cat-new join-name" hidden><input name="title" maxlength="32" placeholder="Name deiner Bibliothek" autocomplete="off"></div>
    <div class="ed-modal-buttons">${first ? '' : '<button type="button" class="ed-modal-cancel">Abbrechen</button>'}<button type="submit" class="ed-modal-ok">Beitreten</button></div>
  </form>`;
  document.body.appendChild(box);
  box.querySelector('.ed-modal-cancel')?.addEventListener('click', () => box.remove());

  const form = box.querySelector('form');
  const ok = box.querySelector('.ed-modal-ok');
  let pending = null; // geprüfter Code, dessen Bibliothek noch einen Namen braucht

  form.onsubmit = async e => {
    e.preventDefault();
    ok.disabled = true;
    try {
      if (!pending) {
        const code = decodeLibraryCode(form.elements.code.value);
        if (!code) throw new Error('Das ist kein gültiger Code. Bitte ganz kopieren');
        toast('Prüfe Code …');
        if (!await tokenCanWrite(code.repo, code.token)) {
          throw new Error(lastWriteStatus === 409 ? 'Dieser Speicher ist noch ganz leer (README fehlt)'
            : `Der Code funktioniert nicht (${lastWriteStatus})`);
        }
        const file = await readRepoFile(code.repo, code.token, 'data/recipes.json');
        if (!file) {
          // Neue Bibliothek: erst benennen
          pending = code;
          box.querySelector('h3').textContent = 'Deine neue Bibliothek';
          box.querySelector('.join-text').textContent = 'Sie ist noch leer. Wie soll sie heißen?';
          box.querySelector('.join-code').hidden = true;
          box.querySelector('.join-name').hidden = false;
          ok.textContent = 'Einrichten';
          $('#toast').hidden = true;
          return;
        }
        rememberLibrary({ ...code, name: file.json.libraryName || 'Bibliothek' });
      } else {
        const name = form.elements.title.value.trim().replace(/\s+/g, ' ');
        if (!name) throw new Error('Bitte einen Namen eingeben');
        toast('Richte ein …');
        await setUpLibrary(pending.repo, pending.token, name);
        rememberLibrary({ ...pending, name });
      }
      reloadApp();
    } catch (err) {
      toast(err instanceof TypeError ? 'Keine Verbindung. Bitte Internet prüfen' : err.message);
    } finally {
      ok.disabled = false;
    }
  };
}

/* ---------- Teilen ---------- */

function showCodeDialog(title, code, introHTML) {
  const modal = document.createElement('div');
  modal.className = 'token-share-modal';
  modal.innerHTML = `
    <div class="token-share-content">
      <button class="token-share-close" aria-label="Schließen">✕</button>
      <h3>${esc(title)}</h3>
      ${introHTML}
      <input type="text" readonly value="${esc(code)}" class="token-share-input">
      ${navigator.share ? '<button class="token-share-copy token-share-send">Code verschicken</button>' : ''}
      <button class="token-share-copy token-share-clip">Code kopieren</button>
      <p class="token-share-hint">Eingeben: App öffnen, Namen eintragen, Code einfügen. Wer schon dabei ist: Einstellungen → Bibliotheken → Code eingeben.</p>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.token-share-close').onclick = () => modal.remove();
  modal.querySelector('.token-share-send')?.addEventListener('click', () => navigator.share({ text: code }).catch(() => {}));
  modal.querySelector('.token-share-clip').onclick = async () => {
    try { await navigator.clipboard.writeText(code); }
    catch (e) { modal.querySelector('.token-share-input').select(); document.execCommand('copy'); }
    toast('Code kopiert ✓');
  };
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
}

function openShareDialog() {
  const token = ghToken();
  if (!token) return toast('Kein Zugang vorhanden');
  if (activeLibrary().id === 'main' && !mainMoved()) return toast('Bitte erst den Umzug abschließen');
  showCodeDialog('Zugang teilen', encodeLibraryCode(activeLibrary().repo, token), `
    <p>Wer diesen Code hat, darf in <strong>${esc(libraryName())}</strong>:</p>
    <ul class="token-share-rights">
      <li>Rezepte und Fotos hinzufügen, ändern und löschen</li>
      <li>Kategorien, Wochenplan und Backlog bearbeiten</li>
      <li>die Bibliothek umbenennen</li>
      <li>die KI-Erkennung nutzen</li>
      <li>den Code weitergeben</li>
    </ul>
    <p>Gib ihn nur Personen, denen du vertraust. Er lässt sich nicht für Einzelne zurücknehmen.</p>`);
}

// Verwalter: Code für einen frisch bei GitHub angelegten Speicher erzeugen
function openNewLibraryDialog() {
  const box = document.createElement('div');
  box.className = 'ed-modal-overlay';
  box.innerHTML = `<form class="ed-modal">
    <h3>Neue Bibliothek</h3>
    <p class="setting-hint">Vorher bei GitHub anlegen: Speicher „schlemmer-daten-…“ mit README und ein Token nur dafür (Contents: Read and write).</p>
    <div class="ed-cat-new"><input name="repo" placeholder="schlemmer-daten-tom" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <div class="ed-cat-new"><input name="token" type="password" placeholder="github_pat_…" autocomplete="off"></div>
    <div class="ed-modal-buttons"><button type="button" class="ed-modal-cancel">Abbrechen</button><button type="submit" class="ed-modal-ok">Code erzeugen</button></div>
  </form>`;
  document.body.appendChild(box);
  box.querySelector('.ed-modal-cancel').onclick = () => box.remove();
  const ok = box.querySelector('.ed-modal-ok');
  box.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const short = e.target.elements.repo.value.trim().replace(/^.*\//, '');
    const repo = `${DATA_REPO.split('/')[0]}/${short}`;
    const token = e.target.elements.token.value.trim();
    if (!LIBRARY_REPO.test(repo)) return toast('Der Speicher muss mit „schlemmer-daten-“ beginnen');
    ok.disabled = true;
    try {
      if (!await tokenCanWrite(repo, token)) return toast(`Der Token darf dort nicht schreiben (${lastWriteStatus})`);
      if (await tokenCanWrite(APP_REPO, token)) return toast('Dieser Token darf auch die App ändern. Bitte einen engeren nehmen');
      box.remove();
      showCodeDialog('Code für die neue Bibliothek', encodeLibraryCode(repo, token),
        `<p>Schick diesen Code an die Person, der <strong>${esc(short)}</strong> gehören soll. Beim ersten Beitritt gibt sie ihr einen Namen.</p>`);
    } catch (err) {
      toast('Keine Verbindung. Bitte Internet prüfen');
    } finally {
      ok.disabled = false;
    }
  };
}

/* ---------- Vom Gerät entfernen ---------- */

// Nimmt die Bibliothek nur von diesem Gerät; für alle anderen bleibt sie
function removeLibrary(id) {
  const lib = libraries().find(l => l.id === id);
  if (!lib || !confirm(`„${libraryName(lib)}“ von diesem Gerät entfernen?\n\nDie Rezepte bleiben erhalten. Zum Zurückholen brauchst du den Code.`)) return;
  const wasActive = id === activeLibrary().id;
  const before = { token: localStorage.getItem(TOKEN_KEY), more: localStorage.getItem(LIBRARIES_KEY) };
  if (id === 'main') localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(LIBRARIES_KEY, JSON.stringify(libraries().filter(l => l.id !== 'main' && l.id !== id)));
  // War sie geöffnet, lädt die App neu, sobald "Rückgängig" abgelaufen ist
  const later = wasActive ? setTimeout(reloadApp, 6500) : null;
  if (history.state?.page === 'settings-bibliotheken') openSettings('bibliotheken');
  toastUndo('Bibliothek entfernt', () => {
    clearTimeout(later);
    for (const [key, value] of [[TOKEN_KEY, before.token], [LIBRARIES_KEY, before.more]]) {
      if (value !== null) localStorage.setItem(key, value);
    }
    if (history.state?.page === 'settings-bibliotheken') openSettings('bibliotheken');
    toast('Wiederhergestellt ✓');
  });
}

/* ---------- Rezepte in eine andere Bibliothek kopieren ---------- */

// Fragt nach dem Ziel; ruft done() nach erfolgreichem Kopieren auf
function openCopyDialog(recipes, done) {
  const targets = libraries().filter(l => l.id !== activeLibrary().id && libraryToken(l));
  if (!targets.length) return toast('Es gibt keine andere Bibliothek auf diesem Gerät');
  const modal = document.createElement('div');
  modal.className = 'ed-modal-overlay';
  modal.innerHTML = `<div class="ed-modal"><h3>${recipes.length === 1 ? '1 Rezept' : recipes.length + ' Rezepte'} kopieren nach</h3>
    <div class="library-list">${targets.map(l => `<button type="button" data-id="${esc(l.id)}">${esc(libraryName(l))}</button>`).join('')}</div>
    <div class="ed-modal-buttons"><button type="button" class="ed-modal-cancel">Abbrechen</button></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.ed-modal-cancel').onclick = () => modal.remove();
  for (const b of modal.querySelectorAll('.library-list button')) {
    b.onclick = async () => {
      modal.remove();
      const target = targets.find(l => l.id === b.dataset.id);
      try {
        const lost = await copyRecipes(recipes, target);
        toast(lost ? `Kopiert, aber ${lost} Fotos fehlen` : `Nach „${libraryName(target)}“ kopiert ✓`);
        done?.();
      } catch (err) {
        toast('Nicht kopiert: ' + err.message);
      }
    };
  }
}

let copying = false;
async function copyRecipes(recipes, target) {
  if (copying) throw new Error('Es wird gerade schon kopiert');
  copying = true;
  try {
    const repo = target.repo;
    const token = libraryToken(target);
    const first = await readRepoFile(repo, token, 'data/recipes.json');
    const taken = new Set((first?.json.recipes || []).map(r => r.id));
    const newIds = new Map();
    for (const r of recipes) {
      let id = r.id, n = 2;
      while (taken.has(id)) id = `${r.id}-${n++}`;
      taken.add(id);
      newIds.set(r.id, id);
    }

    const stamp = Math.floor(Date.now() / 1000);
    const copies = [];
    let lost = 0;
    for (const [index, r] of recipes.entries()) {
      showToastWithoutTimeout(`Kopiere ${index + 1} von ${recipes.length} …`);
      const id = newIds.get(r.id);
      const images = [];
      for (const [i, path] of imagesOf(r).entries()) {
        try {
          const res = await fetch(assetURL(path));
          if (!res.ok) throw new Error(res.status);
          const base64 = await blobToBase64(await res.blob());
          const to = `data/images/${id}-${stamp}-${i}.jpg`;
          await writeRepoFile(repo, token, to, base64, `Foto: ${r.title} (kopiert)`);
          images.push(to);
        } catch (e) { lost++; }
      }
      const now = new Date().toISOString();
      const copy = { ...r, id, images, image: images[0] || '', created: now, updated: now, createdBy: userName(), updatedBy: userName() };
      // Verknüpfungen nur zu Rezepten, die mitkommen
      const related = (r.related || []).map(x => newIds.get(x)).filter(Boolean);
      if (related.length) copy.related = related; else delete copy.related;
      copies.push(copy);
    }

    // frisch lesen: das Hochladen der Fotos kann gedauert haben
    const file = await readRepoFile(repo, token, 'data/recipes.json');
    const json = file?.json || emptyRecipeFile(libraryName(target));
    json.recipes.push(...copies);
    json.updated = new Date().toISOString();
    await writeRepoJSON(repo, token, 'data/recipes.json', json,
      `${copies.length === 1 ? copies[0].title : copies.length + ' Rezepte'} kopiert (vom Handy)`, file?.sha);
    return lost;
  } finally {
    copying = false;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
