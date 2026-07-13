// POST { items: string[] } -> { translations: [{en,es,zh,ru,kk}] }
// Translates English nouns CONSISTENTLY into the learning languages in one call,
// so the same object keeps the same meaning across languages.
module.exports = async (req, res) => {
  if(req.method !== 'POST'){ res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if(typeof body === 'string'){ try { body = JSON.parse(body); } catch(_){ body = {}; } }
    body = body || {};

    // Simple Google mode: translate a list of texts into one target language.
    if(process.env.GOOGLE_TRANSLATE_API_KEY && Array.isArray(body.texts) && body.target){
      const { googleTranslate } = require('./_gtranslate.js');
      const tr = await googleTranslate(body.texts, body.target, body.source || 'en');
      res.status(200).json({ translations: tr || [] });
      return;
    }

    const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    if(!items.length){ res.status(400).json({ error: 'Missing items' }); return; }

    const key = process.env.QWEN_API_KEY;
    if(!key){ res.status(500).json({ error: 'Missing QWEN_API_KEY' }); return; }
    const base = (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
    const model = process.env.QWEN_MODEL || 'qwen-vl-max';

    const prompt = `For each English noun, give the common word AND a short natural example sentence using it, in Spanish, Mandarin Chinese (Simplified), Russian, and Kazakh.
Rules:
- Keep the SAME object meaning across every language.
- "word": Spanish includes the natural article (el/la/un/una); Chinese is just the noun characters (no measure word); Russian and Kazakh are the nominative singular noun.
- "example": one short, everyday sentence (max ~9 words) that uses the word, written naturally in that language.
English nouns (keep this order): ${JSON.stringify(items)}
Reply with ONLY strict JSON:
{"translations":[{"en":string,"es":{"word":string,"example":string},"zh":{"word":string,"example":string},"ru":{"word":string,"example":string},"kk":{"word":string,"example":string}}]}`;

    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model, temperature: 0.1,
        messages: [
          { role: 'system', content: 'You are a precise translator. Reply with ONLY strict JSON, no markdown fences.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if(!r.ok){ const t = await r.text(); res.status(502).json({ error: 'Qwen ' + r.status + ': ' + t.slice(0, 200) }); return; }
    const data = await r.json();
    let content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    const m = content.match(/\{[\s\S]*\}/);
    res.status(200).json(JSON.parse(m ? m[0] : content));
  } catch(e){
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
