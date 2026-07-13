// ---------------------------------------------------------------------------
// AI provider abstraction for object naming.
//
// To switch providers later, change PROVIDER (or set an AI_PROVIDER env var on
// Vercel) and fill in the matching function + its API key. Only THIS file
// changes — the rest of the app stays the same.
// ---------------------------------------------------------------------------

const PROVIDER = process.env.AI_PROVIDER || 'gemini';

const LANG_NAMES = {
  en: 'English', es: 'Spanish', zh: 'Mandarin Chinese', ru: 'Russian', kk: 'Kazakh',
  it: 'Italian', tr: 'Turkish', fr: 'French',
  de: 'German', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean',
};

function buildPrompt(spoken, learning){
  const L = LANG_NAMES[learning] || learning;
  const S = LANG_NAMES[spoken] || spoken;
  return [
    `You help people learn ${L} vocabulary from the world around them.`,
    `Look at the image and identify the SINGLE main subject — the thing that takes up the most space in the frame (the largest, most central, closest item). It can be an object, a person, an animal, a plant, or food.`,
    `If several things are visible, pick the biggest, most prominent one and ignore small background details.`,
    `Name the WHOLE main object, not a small part of it (say "a shoe", not "a shoelace" or "an aglet").`,
    `Answer with ONLY the object's everyday NAME — the most natural word a native speaker would use — usually ONE or TWO words, NEVER a description. Do NOT mention the container it's in, the background, the surface it sits on, or the setting, and don't tack on extra descriptive words. Examples: "dough" (not "bread dough in a bowl"), "keys" (not "a set of keys on the table"), "a cat" (not "a cat sitting on a sofa"), "soup" (not "a bowl of soup").`,
    `Name it as SPECIFICALLY as a normal person naturally would in everyday speech — prefer "a rose" over "a flower", "an oak" over "a tree", "a golden retriever" over "a dog", "a mango" over "fruit". BUT only when you are genuinely sure of the exact kind; if you cannot confidently tell the specific type, use the more general everyday word instead (e.g. "a flower" rather than guessing the wrong species). Never use scientific or Latin names, and avoid rare or technical terms — keep it to common words a regular person would actually know.`,
    `If the image is a drawing, sticker, painting, illustration, logo, or photo OF something, name what is DEPICTED (e.g. "a butterfly"), not the medium — do not answer "sticker", "drawing", "picture", or "photo".`,
    `Name a PHYSICAL, touchable object — NEVER a place, venue, room, or location, and never where the photo was taken. Do not name what a sign or screen REFERS TO: an airport sign is "a sign" or "a departure board", NOT "an airport"; a "Café" sign is "a sign", NOT "a café"; a station board is "a sign", NOT "a station".`,
    `If the photo mainly shows writing or text (a sign, board, screen, newspaper, book, menu, billboard, label), name the OBJECT the text sits on — be specific about the KIND of sign when you can (e.g. "a departure board", "a road sign", "an exit sign", "a street sign"), otherwise just "the sign". Do NOT translate, transcribe, or turn the text into the place or thing it describes.`,
    `If the subject is a person, name them with a general everyday word (e.g. "a person", "a woman", "a man", "a baby", "a child"). Do NOT try to identify who the specific individual is.`,
    `BE DECISIVE. Everyday things — kitchen tools and utensils, furniture, appliances, clothing, food, plants, containers, stationery — are almost ALWAYS nameable. A common object photographed from above, at an angle, close up, or on a busy/cluttered surface is still that object (e.g. a wooden cylinder with two handles lying on a counter is "a rolling pin"). Only set found=false when the image is genuinely blank, blurry beyond recognition, or shows no discernible object at all — NOT just because the angle is unusual or you are slightly unsure of the exact type (fall back to a more general everyday word instead).`,
    `Return JSON with these fields:`,
    `- found: true if there is one clear main subject, otherwise false.`,
    `- word: its name in ${L}, including the article if that language uses one (e.g. Spanish "la ventana"). Use the natural dictionary form.`,
    `- reading: ${learning === 'ja' ? 'the Hepburn romaji of the word (e.g. "inu" for 犬, "ringo" for りんご) — lowercase, spaces between words' : 'an empty string ""'}.`,
    `- meaning: that same word translated into ${S}.`,
    `- example: ONE short, beginner-friendly sentence in ${L} that actually uses the word.`,
    `- en: the same word in plain English (always English, e.g. "a mango").`,
    `- en_example: the same example sentence written in plain English.`,
    `- example_meaning: the example sentence translated into ${S}.`,
    `- confidence: "high", "medium", or "low".`,
    `If there is no clear subject, set found=false and use empty strings for the other fields.`,
  ].join('\n');
}

// ---- Google Gemini ---------------------------------------------------------
async function gemini({ imageBase64, mimeType, spoken, learning }){
  const key = process.env.GEMINI_API_KEY;
  if(!key) throw new Error('Missing GEMINI_API_KEY');
  // Try several models so we use whichever one this key has access to.
  // Best model FIRST; the rest are only fallbacks if the primary is rate-limited/unavailable
  // (on the paid tier that almost never happens, so it stays on gemini-2.5-flash).
  const models = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL]
    : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];
  const body = {
    contents: [{ parts: [
      { text: buildPrompt(spoken, learning) },
      { inline_data: { mime_type: mimeType, data: imageBase64 } },
    ] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          found:           { type: 'BOOLEAN' },
          word:            { type: 'STRING' },
          reading:         { type: 'STRING' },
          meaning:         { type: 'STRING' },
          example:         { type: 'STRING' },
          en:              { type: 'STRING' },
          en_example:      { type: 'STRING' },
          example_meaning: { type: 'STRING' },
          confidence:      { type: 'STRING' },
        },
        required: ['found', 'word', 'reading', 'meaning', 'example', 'en', 'en_example', 'example_meaning', 'confidence'],
      },
    },
  };
  const errors = [];
  for(const model of models){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if(r.ok){
      const data = await r.json();
      const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
        && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
        && data.candidates[0].content.parts[0].text;
      if(!text) throw new Error('Empty response from model');
      const parsed = JSON.parse(text);
      parsed._model = model;
      return parsed;
    }
    const t = await r.text();
    errors.push(`${model}:${r.status}`);
    if([429, 404, 500, 502, 503].includes(r.status)){ continue; }  // quota / missing / overloaded → try next model
    throw new Error(`Gemini ${model} ${r.status}: ${t.slice(0, 200)}`);  // other errors → stop
  }
  throw new Error('All models failed [' + errors.join(', ') + ']');
}

// ---- Qwen (OpenAI-compatible; works with Alibaba DashScope or OpenRouter) ---
function parseJsonLoose(text){
  if(typeof text !== 'string') return text;
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); }
  catch(e){
    const m = s.match(/\{[\s\S]*\}/);
    if(m) return JSON.parse(m[0]);
    throw new Error('Could not parse JSON from Qwen output');
  }
}
async function qwen({ imageBase64, mimeType, spoken, learning }){
  const key = process.env.QWEN_API_KEY;
  if(!key) throw new Error('Missing QWEN_API_KEY');
  const base = (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  const model = process.env.QWEN_MODEL || 'qwen-vl-max';
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'You are a vision assistant. Reply with ONLY a strict JSON object — no extra text, no markdown fences.' },
      { role: 'user', content: [
        { type: 'text', text: buildPrompt(spoken, learning) + '\nReply with ONLY this JSON: {"found":boolean,"word":string,"reading":string,"meaning":string,"example":string,"en":string,"en_example":string,"example_meaning":string,"confidence":string}' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
      ] },
    ],
  };
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
  });
  if(!r.ok){ const t = await r.text(); throw new Error('Qwen ' + r.status + ': ' + t.slice(0, 300)); }
  const data = await r.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if(!content) throw new Error('Empty response from Qwen');
  return parseJsonLoose(content);
}

// ---- Provider selector -----------------------------------------------------
// input.provider (optional) overrides the AI_PROVIDER env default for this one
// request — used by the live A/B test (?ai=gemini). Falls back to the env default.
async function identifyObject(input){
  const provider = (input && input.provider) || PROVIDER;
  if(provider === 'gemini') return gemini(input);
  if(provider === 'qwen')   return qwen(input);
  // if(provider === 'anthropic') return anthropic(input);
  // if(provider === 'openai')    return openai(input);
  throw new Error('Unknown AI provider: ' + provider);
}

module.exports = { identifyObject };
