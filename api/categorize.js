// POST { items: string[] } -> { categories: string[] } (same order)
// Classifies each word into one of a fixed set of everyday categories. Used to
// group the collection. Falls back to "Other" on any failure (never throws).
const CATS = ['Animals','Plants','Food & Drink','Clothing','Objects','People','Vehicles','Buildings & Places','Nature','Other'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(204).end(); return; }
  if(req.method !== 'POST'){ res.status(405).json({ error: 'Method not allowed' }); return; }
  let items = [];
  try {
    let body = req.body;
    if(typeof body === 'string'){ try { body = JSON.parse(body); } catch(_){ body = {}; } }
    body = body || {};
    items = Array.isArray(body.items) ? body.items.slice(0, 120) : [];
    if(!items.length){ res.status(400).json({ error: 'Missing items' }); return; }

    const key = process.env.QWEN_API_KEY;
    if(!key){ res.status(200).json({ categories: items.map(() => 'Other') }); return; }
    const base = (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
    const model = process.env.QWEN_MODEL || 'qwen-vl-max';

    const prompt = `Classify each item into EXACTLY one of these categories: ${CATS.join(', ')}.
Items may be written in any language. Pick the single best-fitting category for each.
Return ONLY strict JSON: {"categories":[...]} — one category name (spelled exactly as above) per item, in the same order.
Items: ${JSON.stringify(items)}`;

    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, temperature: 0, messages: [
        { role: 'system', content: 'You are a precise classifier. Reply with ONLY strict JSON, no markdown.' },
        { role: 'user', content: prompt },
      ] }),
    });
    if(!r.ok){ res.status(200).json({ categories: items.map(() => 'Other') }); return; }
    const data = await r.json();
    let content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    const m = content.match(/\{[\s\S]*\}/);
    let cats = [];
    try { cats = (JSON.parse(m ? m[0] : content).categories) || []; } catch(_){}
    res.status(200).json({ categories: items.map((_, i) => (CATS.includes(cats[i]) ? cats[i] : 'Other')) });
  } catch(e){
    res.status(200).json({ categories: items.map(() => 'Other'), error: String((e && e.message) || e) });
  }
};
