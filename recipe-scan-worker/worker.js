'use strict';

// Cloudflare Worker: nimmt ein Rezeptfoto entgegen, lässt Claude den Inhalt
// auslesen und gibt Titel/Zutaten/Zubereitung als JSON zurück.
// Der Anthropic-API-Key liegt als Secret (wrangler secret put ANTHROPIC_API_KEY)
// und wird dem Browser nie sichtbar.

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

    const { image, mediaType } = body;
    if (!image) {
      return new Response(JSON.stringify({ error: 'Kein Foto übergeben' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 2048,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image },
            },
            {
              type: 'text',
              text: 'Lies dieses abfotografierte Rezept aus und gib Titel, Zutaten (eine pro Zeile, ' +
                'mit Menge falls angegeben), Zubereitungsschritte (ein Schritt pro Zeile), Portionen ' +
                'und Zubereitungszeit (falls erkennbar, sonst leer lassen) auf Deutsch zurück. ' +
                'Wähle außerdem ein passendes einzelnes Emoji für das Gericht.',
            },
          ],
        }],
      }),
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

    const textBlock = result.content.find(b => b.type === 'text');
    return new Response(textBlock.text, {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
