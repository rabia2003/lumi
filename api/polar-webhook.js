// Polar → Lumi webhook. When someone subscribes (or cancels) in Polar, Polar
// POSTs an event here and we flip `profiles.is_premium` in Supabase so the app
// unlocks (or re-locks) Pro for that account.
//
// Required Vercel env vars:
//   SUPABASE_SERVICE_ROLE_KEY   (Supabase → Settings → API → service_role secret)
//   SUPABASE_URL                (optional; defaults to the known project URL below)
//   POLAR_WEBHOOK_SECRET        (the signing secret Polar shows when you add the endpoint)
//   POLAR_WEBHOOK_INSECURE=1    (optional, SANDBOX ONLY — skips signature check while testing)
//
// Matching: we set is_premium for the profile whose id == the customer's external_id
// (the app passes the Supabase user id as customer_external_id at checkout). If that's
// missing we fall back to matching by email.

const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://xvowkwlznphpifyudphx.supabase.co').replace(/\/$/, '');

// Read the EXACT raw request body — the bytes Polar signed. With body parsing
// disabled (see config export at the bottom), the request stream is untouched,
// so we can read the precise payload; re-serializing a parsed object would not
// match the signature and verification would always fail.
function getRawBody(req){
  // Read the stream FIRST (don't touch req.body — accessing it can trigger Vercel's
  // lazy parser and consume the stream). Fall back to the parsed body only if the
  // stream yields nothing.
  return new Promise((resolve) => {
    let data = '', got = false, done = false;
    const finish = () => {
      if(done) return; done = true;
      if(got) return resolve({ raw: data, fromStream: true });
      try {
        if(Buffer.isBuffer(req.body)) return resolve({ raw: req.body.toString('utf8'), fromStream: false });
        if(typeof req.body === 'string') return resolve({ raw: req.body, fromStream: false });
        if(req.body && typeof req.body === 'object') return resolve({ raw: JSON.stringify(req.body), fromStream: false });
      } catch(_){}
      resolve({ raw: '', fromStream: false });
    };
    try {
      req.on('data', (c) => { got = true; data += c; });
      req.on('end', finish);
      req.on('error', finish);
      setTimeout(finish, 2500);   // safety net if no stream events fire
    } catch(e){ finish(); }
  });
}

function safeEq(a, b){
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Standard Webhooks signature check (the spec Polar follows). Tries several secret
// encodings (base64 / raw, with or without a `whsec_`-style prefix) so it works
// regardless of exactly how Polar formats the secret.
function candidateKeys(secret){
  const forms = new Set([secret]);
  if(secret.startsWith('whsec_')) forms.add(secret.slice(6));
  const us = secret.indexOf('_');
  if(us > 0 && us < 12) forms.add(secret.slice(us + 1));   // strip a short prefix like "polar_whs_"
  const keys = [];
  for(const f of forms){
    try { keys.push(Buffer.from(f, 'base64')); } catch(_){}
    keys.push(Buffer.from(f, 'utf8'));
  }
  return keys;
}
function verifySignature(secret, headers, payload){
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'] || '';
  if(!id || !ts || !sigHeader) return false;
  const signed = `${id}.${ts}.${payload}`;
  const provided = sigHeader.split(' ').map(p => p.split(',')[1]).filter(Boolean);
  for(const key of candidateKeys(secret)){
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    if(provided.some(sig => safeEq(sig, expected))) return true;
  }
  return false;
}

// PATCH profiles.is_premium via the Supabase REST API using the service-role key.
async function setPremium({ externalId, email }, value){
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key){ console.error('polar-webhook: missing SUPABASE_SERVICE_ROLE_KEY'); return false; }
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const body = JSON.stringify({ is_premium: value });
  const tryPatch = async (filter) => {
    const r = await fetch(SUPABASE_URL + '/rest/v1/profiles?' + filter, { method: 'PATCH', headers, body });
    if(!r.ok){ console.error('polar-webhook: PATCH failed', r.status, await r.text()); return 0; }
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  };
  let matched = 0;
  if(externalId) matched = await tryPatch('id=eq.' + encodeURIComponent(externalId));
  // Fallback by email is CASE-INSENSITIVE: Polar may return a different case than the one
  // stored on the profile, and an exact match would silently upgrade nobody.
  if(!matched && email) matched = await tryPatch('email=ilike.' + encodeURIComponent(email));
  // Loud on failure: this means somebody PAID and did NOT get Pro — needs manual reconciliation.
  if(!matched) console.error('polar-webhook: PAID BUT NO ACCOUNT MATCHED — grant manually', { externalId, email, value });
  else console.log('polar-webhook: set is_premium=' + value + ' matched ' + matched + ' row(s)', { externalId, email });
  return matched;
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){ res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { raw } = await getRawBody(req);
    const secret = process.env.POLAR_WEBHOOK_SECRET;
    const insecure = process.env.POLAR_WEBHOOK_INSECURE === '1';
    if(secret && !insecure){
      if(!verifySignature(secret, req.headers, raw)){
        console.warn('polar-webhook: signature verification failed');
        res.status(401).json({ error: 'bad signature' });
        return;
      }
    }

    let event; try { event = JSON.parse(raw); } catch(e){ res.status(400).json({ error: 'bad json' }); return; }
    const type = event.type || '';
    const d = event.data || {};
    const cust = d.customer || {};
    const externalId = d.customer_external_id || cust.external_id
      || (d.metadata && d.metadata.user_id) || (cust.metadata && cust.metadata.user_id) || null;
    const email = cust.email || d.customer_email || d.email || null;

    // Decide grant vs revoke from the event type.
    let grant = null;
    if(['subscription.active', 'subscription.created', 'order.paid'].includes(type)) grant = true;
    else if(type === 'subscription.revoked') grant = false;
    else if(type === 'subscription.updated'){
      const s = String(d.status || '').toLowerCase();
      if(s === 'active' || s === 'trialing') grant = true;
      else if(s === 'unpaid' || s === 'canceled') grant = false;   // canceled + ended
    }

    if(grant === null){ res.status(200).json({ ok: true, ignored: type }); return; }
    if(!externalId && !email){ console.warn('polar-webhook: no customer id/email on', type); res.status(200).json({ ok: true, note: 'no customer match key' }); return; }

    const matched = await setPremium({ externalId, email }, grant);
    // In sandbox (insecure) mode, echo how many accounts matched — handy for debugging the test.
    res.status(200).json({ ok: true, type, granted: grant, ...(insecure ? { matched, externalId, email } : {}) });
  } catch(e){
    console.error('polar-webhook error:', e);
    res.status(500).json({ error: String((e && e.message) || e) });   // 500 → Polar will retry
  }
};

// Disable Vercel's automatic body parsing so we can read the raw payload for
// signature verification (Polar signs the exact bytes it sends).
module.exports.config = { api: { bodyParser: false } };
