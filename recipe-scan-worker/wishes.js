// Wünsche an den Entwickler, gespeichert im Cloudflare-Speicher "WISHES".
// Abschicken: jede Person mit Zugang zu einer Bibliothek (prüft worker.js).
// Löschen/Wiederherstellen: wer die (nicht erratbare) Kennung des Wunsches kennt,
// also nur die Absenderin oder der Absender selbst und der Entwickler.
// Alle lesen: nur mit dem Entwickler-Passwort (Secret WISH_ADMIN_KEY).

const PREFIX = 'wish:';
const ID = /^wish:[\w:-]{10,60}$/;
const clip = (value, max) => String(value ?? '').trim().slice(0, max);

export async function handleWish(body, env) {
  if (!env.WISHES) return [503, { error: 'Der Wunsch-Speicher ist noch nicht eingerichtet' }];

  if (body.action === 'wish') {
    const text = clip(body.text, 1000);
    if (!text) return [400, { error: 'Der Wunsch ist leer' }];
    const created = new Date().toISOString();
    const id = `${PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const wish = { id, text, name: clip(body.name, 30), library: clip(body.library, 40), created };
    await env.WISHES.put(id, JSON.stringify(wish));
    return [200, { ok: true, wish }];
  }

  if (body.action === 'wishes') {
    if (!env.WISH_ADMIN_KEY) return [503, { error: 'Das Entwickler-Passwort ist noch nicht eingerichtet' }];
    if (body.adminKey !== env.WISH_ADMIN_KEY) return [403, { error: 'Falsches Passwort' }];
    const { keys } = await env.WISHES.list({ prefix: PREFIX, limit: 200 });
    const stored = await Promise.all(keys.map(k => env.WISHES.get(k.name, 'json')));
    return [200, { wishes: stored.filter(Boolean).sort((a, b) => b.created.localeCompare(a.created)) }];
  }
  if (body.action === 'wish-delete' && ID.test(body.id)) {
    await env.WISHES.delete(body.id);
    return [200, { ok: true }];
  }
  if (body.action === 'wish-restore' && ID.test(body.wish?.id)) {
    const { id, text, name, library, created } = body.wish;
    await env.WISHES.put(id, JSON.stringify({ id, text: clip(text, 1000), name: clip(name, 30), library: clip(library, 40), created: clip(created, 30) }));
    return [200, { ok: true }];
  }
  return [400, { error: 'Unbekannte Anfrage' }];
}
