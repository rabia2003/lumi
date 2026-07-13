// Serverless endpoint: POST { image (data URL), spoken, learning }
// -> { found, word, meaning, example, confidence }.
// The API key lives only here (server-side), never in the browser.

const { identifyObject } = require('./_providers.js');
const { googleTranslate } = require('./_gtranslate.js');

// Translate an English word + its example sentence into `target` in ONE request,
// so Google uses the SAME term for the word in both places (otherwise it picks
// different synonyms — e.g. the word "señal" but "letrero" inside the sentence).
// Falls back to independent translation if the newline separator doesn't survive.
async function translatePair(enWord, enEx, target){
  if(!enWord) return null;
  if(enEx){
    const t = await googleTranslate([enWord + '\n' + enEx], target, 'en');
    if(t && t[0]){
      const nl = t[0].indexOf('\n');
      if(nl > 0) return { word: t[0].slice(0, nl).trim(), example: t[0].slice(nl + 1).trim() };
    }
    const t2 = await googleTranslate([enWord, enEx], target, 'en');   // newline lost → translate separately
    if(t2 && t2[0]) return { word: (t2[0] || '').trim(), example: (t2[1] || '').trim() };
    return null;
  }
  const tw = await googleTranslate([enWord], target, 'en');
  return tw && tw[0] ? { word: tw[0].trim(), example: '' } : null;
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    let body = req.body;
    if(typeof body === 'string'){ try { body = JSON.parse(body); } catch(_){ body = {}; } }
    body = body || {};
    const { image, spoken, learning } = body;
    if(!image || !spoken || !learning){
      res.status(400).json({ error: 'Missing image, spoken, or learning' });
      return;
    }
    const m = /^data:(.+?);base64,(.*)$/s.exec(image);
    if(!m){
      res.status(400).json({ error: 'image must be a base64 data URL' });
      return;
    }
    // Which vision model identifies the object. Default from AI_PROVIDER env (now "gemini");
    // ?ai=qwen / ?ai=gemini overrides per request (allow-listed).
    const provider = ['qwen', 'gemini'].includes(body.provider) ? body.provider : (process.env.AI_PROVIDER || 'gemini');
    // "direct" = use the model's OWN target-language words (skip the Google Translate pivot).
    // Default ON for Gemini — tested best, esp. Kazakh. ?direct=off restores the Google pipeline.
    let direct;
    if(body.direct === false || body.direct === 'off' || body.direct === '0') direct = false;
    else if(body.direct === true || body.direct === '1' || body.direct === 1) direct = true;
    else direct = (provider === 'gemini');
    const result = await identifyObject({ mimeType: m[1], imageBase64: m[2], spoken, learning, provider });

    let word = result.word || '', example = result.example || '', meaning = result.meaning || '';
    // exampleTr = the example sentence in the learner's OWN (spoken) language.
    let exampleTr = result.example_meaning || (spoken === 'en' ? (result.en_example || '') : '') || '';
    let _translator = 'ai';
    // The AI is reliable in English, so we use the English word/example as a PIVOT and
    // translate FROM English into each language with Google (strongest pairs, esp. Kazakh).
    // Falls back to the AI's own output when Google isn't configured.
    const enWord = result.en || (spoken === 'en' ? result.meaning : '') || '';
    const enEx = result.en_example || (learning === 'en' ? result.example : '') || '';
    if(result.found && enWord && !direct){
      // word + example in the LEARNING language — translated TOGETHER so the same
      // term appears in both (no more "señal" as the word but "letrero" in the sentence).
      if(learning !== 'en'){
        const tr = await translatePair(enWord, enEx, learning);
        if(tr){ if(tr.word) word = tr.word; if(tr.example) example = tr.example; _translator = 'google'; }
      }
      // meaning + example translation in the learner's OWN (spoken) language
      if(spoken !== 'en'){
        const tm = await translatePair(enWord, enEx, spoken);
        if(tm){ if(tm.word) meaning = tm.word; if(tm.example) exampleTr = tm.example; _translator = 'google'; }
      } else if(enEx){
        exampleTr = enEx;   // spoken is English → the English example IS the translation
      }
    }

    // Japanese: keep the AI's word + its romaji reading together (a consistent pair; the
    // model is strong in Japanese) rather than Google's word, which wouldn't match the reading.
    let reading = '';
    if(learning === 'ja'){
      if(result.word) word = result.word;
      reading = (result.reading || '').toString().trim();
    }

    res.status(200).json({
      found: !!result.found,
      word,
      reading,
      meaning,
      example,
      exampleTr,
      confidence: result.confidence || '',
      _provider: provider || process.env.AI_PROVIDER || 'gemini',   // debug: which provider answered
      _model: result._model || process.env.QWEN_MODEL || process.env.GEMINI_MODEL || null,
      _translator: direct ? 'ai' : _translator,   // debug: 'google' if Google refined it, else the model's own output
    });
  } catch(e){
    console.error('naming error:', e);
    // 200 with an error flag so the app can show a friendly message rather than crashing.
    res.status(200).json({ found: false, error: String((e && e.message) || e) });
  }
};
