// Serverless endpoint: POST { image (data URL) } -> { cutout: transparent-PNG data URL }
// Uses fal.ai BiRefNet for high-quality background removal. The key lives only here.

async function callFal(key, scheme, payload){
  return fetch('https://fal.run/fal-ai/birefnet/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': scheme + ' ' + key },
    body: JSON.stringify(payload),
  });
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){ res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let body = req.body;
    if(typeof body === 'string'){ try { body = JSON.parse(body); } catch(_){ body = {}; } }
    body = body || {};
    const { image } = body;
    if(!image){ res.status(400).json({ error: 'Missing image' }); return; }

    const key = process.env.FAL_KEY;
    if(!key){ res.status(200).json({ error: 'Missing FAL_KEY' }); return; }
    const model = process.env.FAL_MODEL || 'General Use (Heavy)';

    const payload = { image_url: image, model, output_format: 'png', operating_resolution: '1024x1024' };

    // fal REST normally uses "Key <token>"; fall back to "Bearer" if the key is rejected.
    let r = await callFal(key, 'Key', payload);
    if(r.status === 401 || r.status === 403){ r = await callFal(key, 'Bearer', payload); }
    if(!r.ok){ const t = await r.text(); res.status(200).json({ error: 'fal ' + r.status + ': ' + t.slice(0, 200) }); return; }

    const data = await r.json();
    const url = data && data.image && data.image.url;
    if(!url){ res.status(200).json({ error: 'no output url' }); return; }

    const imgResp = await fetch(url);
    if(!imgResp.ok){ res.status(200).json({ error: 'result fetch ' + imgResp.status }); return; }
    const buf = Buffer.from(await imgResp.arrayBuffer());
    res.status(200).json({ cutout: 'data:image/png;base64,' + buf.toString('base64') });
  } catch(e){
    console.error('cutout error:', e);
    res.status(200).json({ error: String((e && e.message) || e) });
  }
};
