// Google Cloud Translation (v2) helper.
// Returns an array of translated strings, or null if the key is missing or the
// call fails — callers fall back to the AI's own output, so nothing breaks.
async function googleTranslate(texts, target, source){
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if(!key) return null;
  const arr = (Array.isArray(texts) ? texts : [texts]).map(t => (t == null ? '' : String(t)));
  if(!arr.some(t => t.trim())) return null;
  try {
    const r = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: arr, target, source: source || undefined, format: 'text' }),
    });
    if(!r.ok) return null;
    const data = await r.json();
    const out = data && data.data && data.data.translations;
    if(!out) return null;
    const dec = s => String(s)
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return out.map(o => dec(o.translatedText));
  } catch(e){ return null; }
}
module.exports = { googleTranslate };
