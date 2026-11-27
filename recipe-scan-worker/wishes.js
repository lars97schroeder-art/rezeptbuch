// Wünsche an den Entwickler, gespeichert im Cloudflare-Speicher "WISHES".
// Abschicken: jede Person mit Zugang zu einer Bibliothek (prüft worker.js).
// Lesen, Löschen, Wiederherstellen: nur mit Schreibrecht auf die erste Bibliothek.

const PREFIX = 'wish:';
const ID = /^wish:[\w:-]{10,60}$/;
const clip = (value, max) => String(value ?? '').trim().slice(0, max);

export async function handleWish(body, env, isAdmin) {
  if (!env.WISHES) return [503, { error: 'Der Wunsch-Speicher ist noch nicht eingerichtet' }];

  if (body.action === 'wish') {
    const text = clip(body.text, 1000);
    if (!text) return [400, { error: 'Der Wunsch ist leer' }];
    const created = new Date().toISOString();
    const id = `${PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await env.WISHES.put(id, JSON.stringify({ id, text, name: clip(body.name, 30), library: clip(body.library, 40), created }));
    return [200, { ok: true }];
  }

  if (!await isAdmin()) return [403, { error: 'Dafür fehlt die Berechtigung' }];

  if (body.action === 'wishes') {
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
