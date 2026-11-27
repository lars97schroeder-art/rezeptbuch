'use strict';

/* Wünsche an den Entwickler. Abschicken kann jede Person mit einer Bibliothek;
   sie landen im KI-Dienst (Cloudflare) und werden mit dem Zugang der ersten
   Bibliothek gelesen. Nutzt zur Laufzeit die Funktionen aus app.js/editor.js. */

const WISH_MAX = 1000;
let wishDraft = '';

// Zugang zum Lesen der Wünsche: nur wer die erste Bibliothek hat
const wishAdminToken = () => mainMoved() ? localStorage.getItem(TOKEN_KEY) || '' : '';

const wishRequest = payload => askScanService(payload);

function openWish() {
  enterOverlay('wish');
  const el = $('#editor');
  const may = !!ghToken();
  el.innerHTML = `
    <button class="detail-close" aria-label="Zurück">←</button>
    <div class="ed-body settings-body">
      <h2>Wünsch dir was</h2>
      <p class="ed-text">Fehlt etwas, nervt etwas oder hast du eine Idee? Schreib es dem Entwickler dieser App. 😁</p>
      ${may ? `<div class="ed-field"><textarea id="wish-text" rows="6" maxlength="${WISH_MAX}" placeholder="Ich wünsche mir …" aria-label="Dein Wunsch"></textarea></div>
        <button type="button" class="bulk-go" id="wish-send">Wunsch abschicken</button>`
        : '<p class="ed-text">Zum Abschicken braucht es eine Bibliothek.</p>'}
      <div id="wish-list"></div>
    </div>`;
  el.querySelector('.detail-close').onclick = () => closeOverlay();
  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';

  const area = el.querySelector('#wish-text');
  if (area) {
    area.value = wishDraft;
    area.oninput = () => { wishDraft = area.value; };
    const button = el.querySelector('#wish-send');
    button.onclick = async () => {
      const text = area.value.trim();
      if (!text) return toast('Schreib erst deinen Wunsch hinein');
      button.disabled = true;
      try {
        await wishRequest({ action: 'wish', text, name: userName(), library: libraryName() });
        wishDraft = area.value = '';
        toast('Danke! Dein Wunsch ist angekommen ✓');
        if (wishAdminToken()) loadWishes();
      } catch (err) {
        toast('Nicht abgeschickt: ' + err.message);
      } finally {
        button.disabled = false;
      }
    };
  }
  if (wishAdminToken()) loadWishes();
}

const wishAdmin = payload => wishRequest({ ...payload, token: wishAdminToken(), repo: DATA_REPO });

async function loadWishes() {
  const box = $('#wish-list');
  if (!box) return;
  box.innerHTML = '<p class="ed-text">Lade eingegangene Wünsche …</p>';
  try {
    const { wishes } = await wishAdmin({ action: 'wishes' });
    showWishes(wishes);
  } catch (err) {
    box.innerHTML = `<p class="ed-text">Wünsche nicht geladen: ${esc(err.message)}</p>`;
  }
}

function showWishes(wishes) {
  const box = $('#wish-list');
  if (!box) return;
  const date = iso => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
  box.innerHTML = `<section class="set-group"><h3>Eingegangene Wünsche</h3><div class="set-card">${wishes.map((w, i) => `
    <div class="set-library">
      <div class="set-block wish-item">
        <span class="wish-text">${esc(w.text)}</span>
        <span class="set-hint">${esc([w.name || 'Unbekannt', w.library, date(w.created)].filter(Boolean).join(' · '))}</span>
      </div>
      <button type="button" class="lib-forget" data-i="${i}" aria-label="Wunsch löschen">✕</button>
    </div>`).join('') || '<div class="set-block"><span class="set-hint">Noch keine Wünsche.</span></div>'}</div></section>`;
  for (const button of box.querySelectorAll('.lib-forget')) {
    button.onclick = async () => {
      const index = Number(button.dataset.i);
      const wish = wishes[index];
      button.disabled = true;
      try {
        await wishAdmin({ action: 'wish-delete', id: wish.id });
      } catch (err) {
        button.disabled = false;
        return toast('Nicht gelöscht: ' + err.message);
      }
      // Liste hier selbst kürzen: der Dienst zeigt Änderungen leicht verzögert
      showWishes(wishes.filter(w => w !== wish));
      toastUndo('Wunsch gelöscht', async () => {
        try {
          await wishAdmin({ action: 'wish-restore', wish });
          showWishes(wishes);
          toast('Wiederhergestellt ✓');
        } catch (err) {
          toast('Nicht wiederhergestellt: ' + err.message);
        }
      }, { ms: 8000 });
    };
  }
}
