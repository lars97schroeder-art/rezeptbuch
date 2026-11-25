// Rezept von einer Webseite holen, ohne Kosten:
//  1. Viele Seiten liefern das Rezept maschinenlesbar mit (JSON-LD) → direkt
//     übernehmen, ganz ohne KI
//  2. Sonst liest die Gratis-KI von Cloudflare den Seitentext (Tageskontingent)

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_PAGE_CHARS = 2_000_000;
const MAX_TEXT_CHARS = 14000; // hält den Verbrauch pro Rezept klein

export class LinkError extends Error {}

export async function readRecipeFromLink(url, env, schema) {
  const html = await loadPage(url);
  const structured = fromStructuredData(html);
  if (structured) return structured;
  return fromAI(pageText(html), env, schema);
}

async function loadPage(url) {
  let target;
  try { target = new URL(url); } catch { throw new LinkError('Das ist kein gültiger Link'); }
  if (!['http:', 'https:'].includes(target.protocol)) throw new LinkError('Das ist kein gültiger Link');
  let res;
  try {
    res = await fetch(target.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Schlemmerliste/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
      },
      redirect: 'follow',
    });
  } catch { throw new LinkError('Die Seite ist nicht erreichbar'); }
  if (!res.ok) throw new LinkError(`Die Seite lässt sich nicht abrufen (${res.status}). Du kannst ein Foto oder Screenshot nehmen`);
  return (await res.text()).slice(0, MAX_PAGE_CHARS);
}

/* ---------- 1. Maschinenlesbares Rezept ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', ndash: '–', mdash: '—',
  eacute: 'é', egrave: 'è', agrave: 'à', hellip: '…' };

function decode(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => safeChar(parseInt(n, 16), m))
    .replace(/&#(\d+);/g, (m, n) => safeChar(Number(n), m))
    .replace(/&([a-z0-9]+);/gi, (m, name) => ENTITIES[name] ?? m);
}
const safeChar = (code, fallback) => code <= 0x10ffff ? String.fromCodePoint(code) : fallback;

// Reiner Text: HTML-Reste und überflüssige Leerzeichen entfernen
const clean = text => decode(decode(text ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function findRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findRecipe(item, depth + 1); if (hit) return hit; }
    return null;
  }
  if ([].concat(node['@type']).includes('Recipe')) return node;
  for (const value of Object.values(node)) {
    const hit = findRecipe(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Zubereitung kommt als Text, Liste oder Abschnitte mit eigenen Listen
function stepsOf(value) {
  if (!value) return [];
  if (typeof value === 'string') {
    return value.split(/\r?\n|<\/p>|<br\s*\/?>|<\/li>/i).map(clean).filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap(stepsOf);
  if (value.itemListElement) return stepsOf(value.itemListElement);
  return stepsOf(value.text || value.name);
}

// "PT1H30M" → "90 Min" (die App rechnet in Minuten)
function minutesOf(duration) {
  const m = String(duration || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/i);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

export function fromStructuredData(html) {
  const blocks = html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of blocks) {
    let json;
    // rohe Zeilenumbrüche in Texten sind auf manchen Seiten üblich, aber ungültig
    try { json = JSON.parse(raw.trim().replace(/[\u0000-\u001f]+/g, ' ')); } catch { continue; }
    const recipe = findRecipe(json);
    if (!recipe) continue;
    const ingredients = [].concat(recipe.recipeIngredient || recipe.ingredients || []).map(clean).filter(Boolean);
    const steps = stepsOf(recipe.recipeInstructions);
    if (!ingredients.length && !steps.length) continue;
    const minutes = minutesOf(recipe.totalTime) || minutesOf(recipe.cookTime) + minutesOf(recipe.prepTime);
    const yields = [].concat(recipe.recipeYield || []).map(clean).filter(Boolean);
    const servings = yields.find(y => /\D/.test(y)) || (yields[0] ? `${yields[0]} Portionen` : '');
    return {
      title: clean(recipe.name),
      servings,
      time: minutes ? `${minutes} Min` : '',
      ingredients,
      steps,
      emoji: '',
    };
  }
  return null;
}

/* ---------- 2. Gratis-KI ---------- */

export function pageText(html) {
  const main = html.match(/<(main|article)\b[\s\S]*<\/\1>/i)?.[0] || html;
  const text = main
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|li|h\d|div|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decode(text).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .join('\n').slice(0, MAX_TEXT_CHARS);
}

async function fromAI(text, env, schema) {
  if (text.length < 80) throw new LinkError('Auf der Seite ist kein Text lesbar. Nimm ein Foto oder einen Screenshot');
  if (!env.AI) throw new LinkError('Die Gratis-KI ist im Dienst noch nicht eingerichtet');
  let result;
  try {
    result = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: 'Du überträgst Rezepte aus Webseiten-Text. Antworte auf Deutsch. Übernimm nur, was im Text steht, und erfinde nichts. '
          + 'ingredients: eine Zutat pro Eintrag mit Menge. steps: ein Zubereitungsschritt pro Eintrag. '
          + 'time: gesamte Dauer in Minuten, z. B. "90 Min". Fehlen Zeit oder Portionen, lasse sie leer. Steht kein Rezept im Text, gib leere Listen zurück. emoji: ein passendes Emoji.' },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_schema', json_schema: schema },
      max_tokens: 2048,
      temperature: 0.1,
    });
  } catch (e) {
    const limit = /neuron|limit|quota|4006/i.test(String(e?.message));
    throw new LinkError(limit ? 'Das kostenlose Tageskontingent ist aufgebraucht. Morgen geht es wieder'
      : 'Die Gratis-KI konnte die Seite nicht auslesen. Nochmal versuchen oder ein Foto nehmen');
  }
  let recipe = result?.response;
  if (typeof recipe === 'string') { try { recipe = JSON.parse(recipe); } catch { recipe = null; } }
  if (!recipe || !(recipe.ingredients?.length || recipe.steps?.length)) {
    throw new LinkError('Auf der Seite wurde kein Rezept gefunden');
  }
  return recipe;
}
