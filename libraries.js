'use strict';

/* Nutzer (nur auf diesem Gerät) und Bibliotheken.
   Eine Bibliothek ist ein Daten-Speicher auf GitHub mit eigenen Rezepten,
   Wochenplan und Backlog. Es ist immer genau eine geöffnet; beim Wechseln lädt
   die App neu. Die erste ("main") ist die von Lars und Annika.
   Wird VOR editor.js, cook.js und app.js geladen. */

const USER_KEY = 'rezeptbuch-user';
const LIBRARIES_KEY = 'rezeptbuch-libraries';       // weitere Bibliotheken
const ACTIVE_LIBRARY_KEY = 'rezeptbuch-active-library';

/* Umzug der ersten Bibliothek: ihre Daten liegen jetzt in einem eigenen
   Speicher, getrennt von der App. Ein Gerät mit dem alten Token bleibt so lange
   beim alten Ort, bis dort der neue Token eingegeben wurde; Geräte ohne Token
   lesen gleich vom neuen Ort. */
const APP_REPO = 'lars97schroeder-art/rezeptbuch';
const DATA_REPO = 'lars97schroeder-art/schlemmer-daten-lars-annika';
const MAIN_MOVED_KEY = 'rezeptbuch-main-moved';

const mainMoved = (() => {
  const moved = localStorage.getItem(MAIN_MOVED_KEY) === 'true' || !localStorage.getItem('rezeptbuch-token');
  if (moved) localStorage.setItem(MAIN_MOVED_KEY, 'true');
  return () => moved; // bleibt bis zum Neuladen gleich
})();

const MAIN_LIBRARY = {
  id: 'main',
  name: 'Schrödamskis Schlemmerliste',
  repo: mainMoved() ? DATA_REPO : APP_REPO,
};

/* ---------- Nutzer ---------- */

function currentUser() {
  try {
    const user = JSON.parse(localStorage.getItem(USER_KEY));
    return user && user.name ? user : null;
  } catch (e) { return null; }
}
const userName = () => currentUser()?.name || '';

function saveUserName(name) {
  const id = currentUser()?.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  localStorage.setItem(USER_KEY, JSON.stringify({ id, name: name.trim().slice(0, 30) }));
}

/* ---------- Bibliotheken ---------- */

// Gespeichert je Eintrag: { id, name, repo: "konto/speicher", token }
function libraries() {
  let more = [];
  try { more = JSON.parse(localStorage.getItem(LIBRARIES_KEY)) || []; } catch (e) { /* leer */ }
  // Ohne Code ist keine Bibliothek da, auch die erste nicht
  return [...(localStorage.getItem('rezeptbuch-token') ? [MAIN_LIBRARY] : []), ...more.filter(l => l && /^[\w-]+$/.test(l.id) && l.id !== 'main'
    && /^[\w.-]+\/[\w.-]+$/.test(l.repo) && l.name)];
}

// Platzhalter, solange das Gerät noch keinen Code hat
const NO_LIBRARY = { id: 'none', name: 'Schlemmerliste', repo: null };

const activeLibrary = (() => {
  const all = libraries();
  const chosen = all.find(l => l.id === localStorage.getItem(ACTIVE_LIBRARY_KEY)) || all[0] || NO_LIBRARY;
  return () => chosen; // bleibt bis zum Neuladen gleich
})();

// Speicher-Schlüssel je Bibliothek; die erste behält die bisherigen Namen
const libKey = (key, lib = activeLibrary()) => lib.id === 'main' ? key : `${key}@${lib.id}`;

// Anzeigename: umbenannte Bibliotheken führen ihn in ihren Daten mit
function libraryName(lib = activeLibrary()) {
  try {
    const stored = typeof data !== 'undefined' && lib.id === activeLibrary().id && data.libraryName
      ? data : JSON.parse(localStorage.getItem(libKey('rezeptbuch-data', lib)));
    if (stored?.libraryName) return stored.libraryName;
  } catch (e) { /* noch keine Daten */ }
  return lib.name;
}

// Adresse einer Datei (z. B. Foto) aus einer Bibliothek
function assetURL(path, lib = activeLibrary()) {
  // Nur Daten im App-Speicher liegen unter derselben Adresse wie die App
  if (!path || !lib.repo || lib.repo === APP_REPO || /^(data:|blob:|https?:)/.test(path)) return path;
  return `https://raw.githubusercontent.com/${lib.repo}/main/${path}`;
}
