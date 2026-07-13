// Serverless endpoint: POST { image (data URL) } + Bearer <user JWT> -> { path }.
// Uploads a card image to a PRIVATE Supabase Storage bucket ("card-images") under an
// owner-scoped path {user_id}/{random}.ext. The bucket is private, so the file is NOT
// world-readable — it can only be viewed through a short-lived signed URL that the
// owner's logged-in app requests (see api/sign-images.js). The service key lives only here.

const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://xvowkwlznphpifyudphx.supabase.co').replace(/\/$/, '');
const BUCKET = 'card-images';
const PUBLISHABLE = process.env.SUPABASE_ANON_KEY || 'sb_publishable_Qt3eagHiQlVSCwOGAorR7A_DrbC5W8b';

function parseDataUrl(dataUrl){
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || '');
  if(!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}
async function getUser(token){
  if(!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + token, apikey: PUBLISHABLE } });
    return r.ok ? await r.json() : null;
  } catch(e){ return null; }
}
function svcHeaders(extra){ const svc = process.env.SUPABASE_SERVICE_ROLE_KEY; return Object.assign({ Authorization: 'Bearer ' + svc, apikey: svc }, extra || {}); }
// Make sure the bucket exists and is PRIVATE (login-gated). Update if it exists, create
// otherwise. Runs once per warm instance (cheap during the bulk one-time migration).
let _bucketEnsured = false;
async function ensureBucketPrivate(){
  if(_bucketEnsured) return;
  const body = JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 6291456 });
  const up = await fetch(SUPABASE_URL + '/storage/v1/bucket/' + BUCKET, { method: 'PUT', headers: svcHeaders({ 'Content-Type': 'application/json' }), body });
  if(!up.ok){ await fetch(SUPABASE_URL + '/storage/v1/bucket', { method: 'POST', headers: svcHeaders({ 'Content-Type': 'application/json' }), body }); }
  _bucketEnsured = true;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(204).end(); return; }
  if(req.method !== 'POST'){ res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    if(!process.env.SUPABASE_SERVICE_ROLE_KEY){ res.status(500).json({ error: 'server not configured' }); return; }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = await getUser(token);
    if(!user || !user.id){ res.status(401).json({ error: 'Sign-in required' }); return; }

    let body = req.body;
    if(typeof body === 'string'){ try { body = JSON.parse(body); } catch(_){ body = {}; } }
    body = body || {};
    const parsed = parseDataUrl(body.image);
    if(!parsed){ res.status(400).json({ error: 'image must be a base64 data URL' }); return; }
    if(parsed.buf.length > 6 * 1024 * 1024){ res.status(413).json({ error: 'image too large' }); return; }

    await ensureBucketPrivate();
    const ext = /png/i.test(parsed.mime) ? 'png' : (/webp/i.test(parsed.mime) ? 'webp' : 'jpg');
    const path = user.id + '/' + crypto.randomBytes(16).toString('hex') + '.' + ext;   // owner-scoped, unguessable
    const url = SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path;
    const r = await fetch(url, { method: 'POST', headers: svcHeaders({ 'Content-Type': parsed.mime, 'x-upsert': 'true', 'Cache-Control': 'private, max-age=31536000, immutable' }), body: parsed.buf });
    if(!r.ok){ const tt = await r.text(); throw new Error('upload ' + r.status + ': ' + tt.slice(0, 200)); }

    res.status(200).json({ path });
  } catch(e){
    console.error('store-image error:', e);
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '8mb' } } };
