'use strict';

/* Wünsche an Lars. Abschicken kann jede Person mit einer Bibliothek; sie landen
   im KI-Dienst (Cloudflare). Jede Person sieht nur die eigenen (auf ihrem Gerät
   gemerkt). Alle zusammen zeigt nur die Entwickler-Ansicht mit eigenem
   Passwort. Nutzt zur Laufzeit die Funktionen aus app.js/editor.js. */

const WISH_MAX = 1000;
const OWN_WISHES_KEY = 'rezeptbuch-wishes';
const WISH_ADMIN_KEY = 'rezeptbuch-wish-admin';
let wishDraft = '';

const wishRequest = payload => askScanService(payload);

function ownWishes() {
  try { return JSON.parse(localStorage.getItem(OWN_WISHES_KEY)) || []; } catch (e) { return []; }
}
const saveOwnWishes = list => localStorage.setItem(OWN_WISHES_KEY, JSON.stringify(list));

function openWish() {
  enterOverlay('wish');
  const el = $('#editor');
  const may = !!ghToken();
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="ed-body settings-body">
      <h2>Wünsch dir was von Lars</h2>
      <p class="ed-text">Fehlt etwas, nervt etwas oder hast du eine Idee für die App? Schreib es Lars. 😁</p>
      ${may ? `<div class="ed-field"><textarea id="wish-text" rows="6" maxlength="${WISH_MAX}" placeholder="Ich wünsche mir …" aria-label="Dein Wunsch"></textarea></div>
        <button type="button" class="bulk-go" id="wish-send">Wunsch abschicken</button>`
        : '<p class="ed-text">Zum Abschicken braucht es eine Bibliothek.</p>'}
      <div id="wish-own"></div>
      <div id="wish-list"></div>
      ${may ? '<button type="button" class="wish-dev" id="wish-dev"></button>' : ''}
    </div>`;
  el.querySelector('.detail-close').onclick = () => closeOverlay();
  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  showOwnWishes();

  const area = el.querySelector('#wish-text');
  if (!area) return;
  area.value = wishDraft;
  area.oninput = () => { wishDraft = area.value; };
  const send = el.querySelector('#wish-send');
  send.onclick = async () => {
    const text = area.value.trim();
    if (!text) return toast('Schreib erst deinen Wunsch hinein');
    send.disabled = true;
    try {
      const { wish } = await wishRequest({ action: 'wish', text, name: userName(), library: libraryName() });
      if (wish) saveOwnWishes([wish, ...ownWishes()]);
      wishDraft = area.value = '';
      toast('Danke! Dein Wunsch ist bei Lars angekommen ✓');
      showOwnWishes();
      if (localStorage.getItem(WISH_ADMIN_KEY)) loadAllWishes();
    } catch (err) {
      toast('Nicht abgeschickt: ' + err.message);
    } finally {
      send.disabled = false;
    }
  };

  const dev = el.querySelector('#wish-dev');
  const isDev = !!localStorage.getItem(WISH_ADMIN_KEY);
  dev.textContent = isDev ? 'Entwickler-Ansicht beenden' : 'Entwickler-Ansicht';
  dev.onclick = () => {
    if (!localStorage.getItem(WISH_ADMIN_KEY)) return openWishLogin();
    localStorage.removeItem(WISH_ADMIN_KEY);
    openWish();
  };
  if (isDev) loadAllWishes();
}

// Eine Liste von Wünschen; onDelete(wish) wird beim ✕ aufgerufen
function renderWishes(box, title, wishes, withSender, onDelete) {
  const date = iso => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
  box.innerHTML = `<section class="set-group"><h3>${title}</h3><div class="set-card">${wishes.map((w, i) => `
    <div class="set-library">
      <div class="set-block wish-item">
        <span class="wish-text">${esc(w.text)}</span>
        <span class="set-hint">${esc((withSender ? [w.name || 'Unbekannt', w.library, date(w.created)] : [date(w.created)]).filter(Boolean).join(' · '))}</span>
      </div>
      <button type="button" class="lib-forget" data-i="${i}" aria-label="Wunsch löschen">✕</button>
    </div>`).join('') || '<div class="set-block"><span class="set-hint">Noch keine Wünsche.</span></div>'}</div></section>`;
  for (const button of box.querySelectorAll('.lib-forget')) {
    button.onclick = () => { button.disabled = true; onDelete(wishes[Number(button.dataset.i)]).catch(err => { button.disabled = false; toast(err.message); }); };
  }
}

// Löschen beim Dienst, mit "Rückgängig"
async function deleteWish(wish, afterDelete, afterRestore) {
  try { await wishRequest({ action: 'wish-delete', id: wish.id }); }
  catch (err) { throw new Error('Nicht gelöscht: ' + err.message); }
  afterDelete();
  toastUndo('Wunsch gelöscht', async () => {
    try {
      await wishRequest({ action: 'wish-restore', wish });
      afterRestore();
      toast('Wiederhergestellt ✓');
    } catch (err) {
      toast('Nicht wiederhergestellt: ' + err.message);
    }
  }, { ms: 8000 });
}

function showOwnWishes() {
  const box = $('#wish-own');
  const list = ownWishes();
  if (!box) return;
  if (!list.length) { box.innerHTML = ''; return; }
  renderWishes(box, 'Deine Wünsche', list, false, wish => deleteWish(wish,
    () => { saveOwnWishes(ownWishes().filter(w => w.id !== wish.id)); showOwnWishes(); },
    () => { saveOwnWishes([wish, ...ownWishes()].sort((a, b) => b.created.localeCompare(a.created))); showOwnWishes(); }));
}

/* ---------- Entwickler-Ansicht ---------- */

function openWishLogin() {
  const modal = document.createElement('div');
  modal.className = 'ed-modal-overlay';
  modal.innerHTML = `<form class="ed-modal">
    <h3>Entwickler-Ansicht</h3>
    <p class="setting-hint">Nur für Lars: zeigt alle eingegangenen Wünsche.</p>
    <div class="ed-cat-new"><input name="key" type="password" placeholder="Entwickler-Passwort" autocomplete="off"></div>
    <div class="ed-modal-buttons"><button type="button" class="ed-modal-cancel">Abbrechen</button><button type="submit" class="ed-modal-ok">Öffnen</button></div>
  </form>`;
  document.body.appendChild(modal);
  modal.querySelector('.ed-modal-cancel').onclick = () => modal.remove();
  modal.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const key = e.target.elements.key.value.trim();
    if (!key) return;
    try {
      await wishRequest({ action: 'wishes', adminKey: key });
      localStorage.setItem(WISH_ADMIN_KEY, key);
      modal.remove();
      openWish();
    } catch (err) {
      toast(err.message);
    }
  };
}

async function loadAllWishes(shown) {
  const box = $('#wish-list');
  if (!box) return;
  const show = wishes => renderWishes(box, 'Alle Wünsche', wishes, true, wish => deleteWish(wish,
    // Liste selbst kürzen: der Dienst zeigt Änderungen leicht verzögert
    () => show(wishes.filter(w => w !== wish)),
    () => show(wishes)));
  box.innerHTML = '<p class="ed-text">Lade alle Wünsche …</p>';
  try {
    const { wishes } = await wishRequest({ action: 'wishes', adminKey: localStorage.getItem(WISH_ADMIN_KEY) });
    show(wishes);
  } catch (err) {
    box.innerHTML = `<p class="ed-text">Wünsche nicht geladen: ${esc(err.message)}</p>`;
  }
}
