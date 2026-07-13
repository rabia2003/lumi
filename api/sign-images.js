// Serverless endpoint: POST { paths: [ "{user_id}/{file}", ... ] } + Bearer <user JWT>
// -> { signed: { path: signedUrl } }.
// Returns short-lived signed URLs so a logged-in user can view THEIR OWN private card
// images. Paths are owner-scoped ({user_id}/…), and we only sign paths that start with
// the caller's own id — so nobody can request a signed URL for someone else's image.

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://xvowkwlznphpifyudphx.supabase.co').replace(/\/$/, '');
const BUCKET = 'card-images';
const PUBLISHABLE = process.env.SUPABASE_ANON_KEY || 'sb_publishable_Qt3eagHiQlVSCwOGAorR7A_DrbC5W8b';
const EXPIRES = 86400;   // 1 day — long enough for a session, short enough to stay private

async function getUser(token){
  if(!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + token, apikey: PUBLISHABLE } });
    return r.ok ? await r.json() : null;
  } catch(e){ return null; }
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){ res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(!svc){ res.status(500).json({ error: 'server not configured' }); return; }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = await getUser(token);
    if(!user || !user.id){ res.status(401).json({ error: 'Sign-in required' }); return; }

    let body = req.body;
    if(typeof body === 'string'){ try { body = JSON.parse(body); } catch(_){ body = {}; } }
    body = body || {};
    let paths = Array.isArray(body.paths) ? body.paths : [];
    // Only ever sign the caller's OWN images.
    paths = paths.filter(p => typeof p === 'string' && p.indexOf(user.id + '/') === 0).slice(0, 500);
    if(!paths.length){ res.status(200).json({ signed: {} }); return; }

    const r = await fetch(SUPABASE_URL + '/storage/v1/object/sign/' + BUCKET, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + svc, apikey: svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: EXPIRES, paths }),
    });
    if(!r.ok){ const t = await r.text(); throw new Error('sign ' + r.status + ': ' + t.slice(0, 200)); }
    const arr = await r.json();
    const signed = {};
    (Array.isArray(arr) ? arr : []).forEach(o => {
      if(o && o.signedURL && o.path){ signed[o.path] = SUPABASE_URL + (o.signedURL[0] === '/' ? o.signedURL : '/' + o.signedURL); }
    });
    res.status(200).json({ signed });
  } catch(e){
    console.error('sign-images error:', e);
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
