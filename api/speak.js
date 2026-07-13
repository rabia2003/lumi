// Serverless endpoint: POST { text, lang } -> MP3 audio (text-to-speech).
// Azure powers every language (a NATIVE voice per language). ElevenLabs is kept
// as an easy fallback: set TTS_ELEVEN=1 to use ElevenLabs for all langs except
// Kazakh (which ElevenLabs can't do, so it always stays on Azure).
//
// PERSISTENT CACHE: each unique (voice + text) is generated ONCE and stored in a
// public Supabase Storage bucket ("tts"), then reused forever. Repeat taps skip
// the paid TTS call entirely and play back near-instantly. The bucket is created
// automatically on first write — no manual setup.
//
// All API keys live only here (server-side), never in the browser.

const crypto = require('crypto');

function xmlEsc(s){
  return String(s).replace(/[<>&'"]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' }[c]));
}

// One native voice per language. Locale is derived from the voice name (e.g. "ja-JP").
const AZURE_VOICES = {
  en: 'en-US-JennyNeural',
  es: 'es-ES-ElviraNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ru: 'ru-RU-SvetlanaNeural',
  kk: 'kk-KZ-AigulNeural',
  it: 'it-IT-ElsaNeural',
  tr: 'tr-TR-EmelNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  pt: 'pt-BR-FranciscaNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
};

function azureVoice(lang){ return (lang === 'kk' && process.env.AZURE_VOICE_KK) || AZURE_VOICES[lang] || AZURE_VOICES.en; }
function elevenVoice(){ return process.env.ELEVEN_VOICE || '9BWtsMINqrJLrRacOk9x'; }   // "Aria" — built-in default voice

// ---- Azure (native voice per language) ------------------------------------
async function azureTTS(text, lang){
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;   // e.g. "eastus"
  if(!key || !region) throw new Error('Missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION');
  const voice = azureVoice(lang);
  const locale = voice.split('-').slice(0, 2).join('-');   // "ja-JP-NanamiNeural" -> "ja-JP"
  const ssml = `<speak version='1.0' xml:lang='${locale}'><voice name='${voice}'>${xmlEsc(text)}</voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'lumi',
    },
    body: ssml,
  });
  if(!r.ok){ const t = await r.text(); throw new Error('Azure ' + r.status + ': ' + t.slice(0, 200)); }
  return Buffer.from(await r.arrayBuffer());
}

// ---- ElevenLabs (optional; enable with TTS_ELEVEN=1) ----------------------
async function elevenTTS(text, lang){
  const key = process.env.ELEVEN_API_KEY;
  if(!key) throw new Error('Missing ELEVEN_API_KEY');
  const voice = elevenVoice();
  const model = process.env.ELEVEN_MODEL || 'eleven_multilingual_v2';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`;
  const opt = (p) => ({ method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, body: JSON.stringify(p) });
  const payload = { text, model_id: model };
  if(lang) payload.language_code = lang;   // helps some models; retried without it below
  let r = await fetch(url, opt(payload));
  if(!r.ok && payload.language_code){ delete payload.language_code; r = await fetch(url, opt(payload)); }
  if(!r.ok){ const t = await r.text(); throw new Error('ElevenLabs ' + r.status + ': ' + t.slice(0, 200)); }
  return Buffer.from(await r.arrayBuffer());
}

// ---- Persistent cache (Supabase Storage) ----------------------------------
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://xvowkwlznphpifyudphx.supabase.co').replace(/\/$/, '');
const BUCKET = 'tts';

// Key by voice+text so a voice/provider change naturally regenerates (no stale audio).
function cacheKey(voice, lang, text){
  const h = crypto.createHash('sha256').update(voice + '\n' + text).digest('hex');
  return `${lang}/${h}.mp3`;
}

async function cacheGet(key){
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`);
    if(r.ok) return Buffer.from(await r.arrayBuffer());
  } catch(_){}
  return null;
}

async function cachePut(key, buf){
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!svc) return;   // no service key -> caching disabled, still works uncached
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`;
  const headers = { Authorization: `Bearer ${svc}`, apikey: svc, 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' };
  let r = await fetch(url, { method: 'POST', headers, body: buf });
  if(!r.ok && (r.status === 400 || r.status === 404)){
    // Bucket probably doesn't exist yet -> create it (public) and retry once.
    await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${svc}`, apikey: svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
    r = await fetch(url, { method: 'POST', headers, body: buf });
  }
  return r.ok;
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){ res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if(typeof body === 'string'){ try { body = JSON.parse(body); } catch(_){ body = {}; } }
    body = body || {};
    const text = (body.text || '').toString().slice(0, 400);   // keep it short/cheap
    const lang = (body.lang || '').toString();
    if(!text.trim()){ res.status(400).json({ error: 'Missing text' }); return; }

    // Default: Azure for everything. Set TTS_ELEVEN=1 to route non-Kazakh to ElevenLabs.
    const useEleven = process.env.TTS_ELEVEN === '1' && lang !== 'kk';
    const voice = useEleven ? elevenVoice() : azureVoice(lang);
    const key = cacheKey(voice, lang, text);

    let buf = await cacheGet(key);
    const hit = !!buf;
    if(!buf){
      buf = useEleven ? await elevenTTS(text, lang) : await azureTTS(text, lang);
      try { await cachePut(key, buf); } catch(_){}   // caching failure must never break playback
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    res.status(200).send(buf);
  } catch(e){
    console.error('speak error:', e);
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
