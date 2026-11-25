'use strict';

/* Nutzer (nur auf diesem Gerät) und Bibliotheken.
   Eine Bibliothek ist ein Daten-Speicher auf GitHub mit eigenen Rezepten,
   Wochenplan und Backlog. Es ist immer genau eine geöffnet; beim Wechseln lädt
   die App neu. Die erste ("main") liegt im App-Repository selbst.
   Wird VOR editor.js, cook.js und app.js geladen. */

const USER_KEY = 'rezeptbuch-user';
const LIBRARIES_KEY = 'rezeptbuch-libraries';       // weitere Bibliotheken
const ACTIVE_LIBRARY_KEY = 'rezeptbuch-active-library';

const MAIN_LIBRARY = {
  id: 'main',
  name: 'Schrödamskis Schlemmerliste',
  repo: 'lars97schroeder-art/rezeptbuch',
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
  return [MAIN_LIBRARY, ...more.filter(l => l && /^[\w-]+$/.test(l.id) && l.id !== 'main'
    && /^[\w.-]+\/[\w.-]+$/.test(l.repo) && l.name)];
}

const activeLibrary = (() => {
  const all = libraries();
  const chosen = all.find(l => l.id === localStorage.getItem(ACTIVE_LIBRARY_KEY)) || all[0];
  return () => chosen; // bleibt bis zum Neuladen gleich
})();

// Speicher-Schlüssel je Bibliothek; die erste behält die bisherigen Namen
const libKey = (key, lib = activeLibrary()) => lib.id === 'main' ? key : `${key}@${lib.id}`;

// Adresse einer Datei (z. B. Foto) aus einer Bibliothek
function assetURL(path, lib = activeLibrary()) {
  if (!path || lib.id === 'main' || /^(data:|blob:|https?:)/.test(path)) return path;
  return `https://raw.githubusercontent.com/${lib.repo}/main/${path}`;
}
