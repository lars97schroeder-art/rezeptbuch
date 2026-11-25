'use strict';

// Cloudflare Worker: nimmt Rezeptfotos ODER einen Rezept-Link entgegen und
// gibt Titel/Zutaten/Zubereitung als JSON zurück.
//  - Links: kostenlos (siehe link.js)
//  - Fotos: Claude Haiku (kostet etwas). Der Anthropic-API-Key liegt als
//    Secret (wrangler secret put ANTHROPIC_API_KEY) und wird dem Browser nie
//    sichtbar.

import { readRecipeFromLink, LinkError } from './link.js';

// Zugang: Nur wer in einen dieser Daten-Speicher schreiben darf, darf die KI
// benutzen (jede Anfrage kostet Geld). Neue Bibliotheken hier ergänzen.
const ALLOWED_REPOS = [
  'lars97schroeder-art/schlemmer-daten-lars-annika',
  'lars97schroeder-art/rezeptbuch', // Geräte vor dem Umzug
];

// Echte Prüfung auf Schreibrecht: einen losen Datenblock anlegen, der in keiner
// Datei auftaucht (lesen darf bei öffentlichen Speichern jeder)
async function hasAccess(token) {
  if (typeof token !== 'string' || !/^[\w]{20,255}$/.test(token)) return false;
  for (const repo of ALLOWED_REPOS) {
    const res = await fetch(`https://api.github.com/repos/${repo}/git/blobs`, {
      method: 'POST',
      headers: {
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'rezeptbuch-scan',
      },
      body: JSON.stringify({ content: 'Zugangsprüfung', encoding: 'utf-8' }),
    });
    if (res.ok) return true;
  }
  return false;
}

// Haiku ist das günstigste Modell und reicht zum Abschreiben von Rezepten.
// Es denkt vor der Antwort kurz nach ("effort: low"); dafür braucht
// max_tokens Reserve, sonst bricht die Antwort ab.
const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 8000;

const ALLOWED_ORIGINS = [
  'https://lars97schroeder-art.github.io',
  'http://localhost:8123',
];

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    servings: { type: 'string' },
    time: { type: 'string' },
    ingredients: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    emoji: { type: 'string' },
  },
  required: ['title', 'ingredients', 'steps'],
  additionalProperties: false,
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Ungültiger Request-Body' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    // "images" (mehrere Fotos, z.B. mehrseitiges Rezept) oder das ältere
    // einzelne "image" — beide werden unterstützt
    const { image, mediaType, images, url, token } = body || {};
    if (!await hasAccess(token)) {
      return new Response(JSON.stringify({ error: 'Kein Zugang: Bitte App updaten und Token in den Einstellungen prüfen' }),
        { status: 401, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
    const imageList = Array.isArray(images) && images.length
      ? images
      : (image ? [{ data: image, mediaType: mediaType || 'image/jpeg' }] : []);

    if (!imageList.length && !url) {
      return new Response(JSON.stringify({ error: 'Kein Foto und kein Link übergeben' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    if (!imageList.length) {
      const json = { ...headers, 'Content-Type': 'application/json' };
      try {
        return new Response(JSON.stringify(await readRecipeFromLink(url, env, SCHEMA)), { headers: json });
      } catch (err) {
        if (!(err instanceof LinkError)) console.error(err);
        const message = err instanceof LinkError ? err.message : 'Rezept konnte nicht ausgelesen werden';
        return new Response(JSON.stringify({ error: message }), { status: 422, headers: json });
      }
    }

    const anthropicBody = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          ...imageList.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data },
          })),
          {
            type: 'text',
            text: (imageList.length > 1
              ? `Das sind ${imageList.length} Fotos EINES zusammenhängenden Rezepts (z.B. mehrere Seiten ` +
                'oder Ausschnitte). Kombiniere den Inhalt aller Fotos zu einem Rezept und gib '
              : 'Lies dieses abfotografierte Rezept aus und gib ') +
              'Titel, Zutaten (eine pro Zeile, mit Menge falls angegeben), Zubereitungsschritte ' +
              '(ein Schritt pro Zeile), Portionen und Zubereitungszeit (falls erkennbar, sonst leer ' +
              'lassen) auf Deutsch zurück. Wähle außerdem ein passendes einzelnes Emoji für das Gericht.',
          },
        ],
      }],
    };

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return new Response(JSON.stringify({ error: 'Anthropic-Fehler: ' + errText }),
        { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    const result = await anthropicRes.json();
    if (result.stop_reason === 'refusal') {
      return new Response(JSON.stringify({ error: 'Anfrage wurde abgelehnt' }),
        { status: 422, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    if (result.stop_reason === 'max_tokens') {
      return new Response(JSON.stringify({ error: 'Das Rezept war zu lang, um es vollständig auszulesen' }),
        { status: 422, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    const textBlocks = result.content.filter(b => b.type === 'text');
    const textBlock = textBlocks[textBlocks.length - 1];
    if (!textBlock) {
      return new Response(JSON.stringify({ error: 'Rezept konnte nicht ausgelesen werden' }),
        { status: 422, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
    return new Response(textBlock.text, {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
