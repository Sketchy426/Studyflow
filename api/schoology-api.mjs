// StudyFlow Schoology API sync as a Vercel Function: POST /api/schoology-api
//   {"action":"connect","key":"…","secret":"…"}  checks a personal Schoology API key and returns it locked (encrypted)
//   {"action":"sync","token":"…"}                  reads the student's classes, assignments, due dates and grades
// Every request needs the student's StudyFlow (Firebase) sign-in: "Authorization: Bearer <Firebase ID token>".
//
// Security:
// - Read-only: it only sends GET requests to api.schoology.com, so it can't turn in, change or delete anything.
// - Stores nothing and logs nothing. The key comes back sealed with AES-256-GCM using SCHOOLOGY_TOKEN_KEY
//   (a Vercel environment variable, never in the code) and bound to the student's Firebase account, so a copied
//   token is useless without both this server's secret and that student's sign-in.
// - Only answers StudyFlow's own pages.
import crypto from 'node:crypto';

const ALLOWED_ORIGINS = ['https://studyflow-one-pi.vercel.app', 'https://sketchy426.github.io'];
const FIREBASE_PROJECT = 'studyflow-dca86';
const GOOGLE_KEYS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const API = 'https://api.schoology.com/v1';
const MAX_SUBMISSION_CHECKS = 40;
export const maxDuration = 60;

class Fail extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- StudyFlow sign-in (Firebase ID token, checked against Google's public keys) ---------- */
let keyCache = { keys: null, until: 0 };
async function googleKeys() {
  if (keyCache.keys && Date.now() < keyCache.until) return keyCache.keys;
  const r = await fetch(GOOGLE_KEYS);
  if (!r.ok) throw new Fail(502, "Couldn't check your sign-in. Try again in a minute.");
  const age = /max-age=(\d+)/.exec(r.headers.get('Cache-Control') || '');
  keyCache = { keys: (await r.json()).keys || [], until: Date.now() + (age ? +age[1] : 3600) * 1000 };
  return keyCache.keys;
}
async function signedInUser(request) {
  const bad = new Fail(401, 'Sign in with Google at the top of Settings first.');
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) throw bad;
  let head, body;
  try { head = JSON.parse(Buffer.from(m[1], 'base64url')); body = JSON.parse(Buffer.from(m[2], 'base64url')); } catch (e) { throw bad; }
  if (head.alg !== 'RS256') throw bad;
  const jwk = (await googleKeys()).find(k => k.kid === head.kid);
  if (!jwk) throw bad;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(m[1] + '.' + m[2]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(m[3], 'base64url'));
  const now = Date.now() / 1000;
  if (!ok || body.aud !== FIREBASE_PROJECT || body.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT ||
      typeof body.sub !== 'string' || !body.sub || !(body.exp > now) || !(body.iat < now + 300)) throw bad;
  return body.sub;
}

/* ---------- Locking the key ---------- */
function secretKey() {
  const k = Buffer.from(process.env.SCHOOLOGY_TOKEN_KEY || '', 'base64');
  if (k.length !== 32) throw new Fail(500, "StudyFlow's server isn't set up for Schoology keys yet (SCHOOLOGY_TOKEN_KEY is missing).");
  return k;
}
function seal(data, uid) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  c.setAAD(Buffer.from('studyflow-schoology:' + uid));
  const ct = Buffer.concat([c.update(JSON.stringify(data)), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function unseal(token, uid) {
  try {
    const b = Buffer.from(String(token).replace(/^v1\./, ''), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), b.subarray(0, 12));
    d.setAAD(Buffer.from('studyflow-schoology:' + uid)); d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail(403, 'This Schoology connection belongs to a different StudyFlow account, or has expired. Connect Schoology again.');
  }
}

/* ---------- Schoology API (OAuth 1.0a two-legged, HMAC-SHA1, GET only) ---------- */
const enc = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function authorization(url, cred) {
  const u = new URL(url);
  const o = { oauth_consumer_key: cred.k, oauth_nonce: crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_version: '1.0' };
  const params = [...u.searchParams.entries(), ...Object.entries(o)].map(([k, v]) => enc(k) + '=' + enc(v)).sort();
  const base = ['GET', enc(u.origin + u.pathname), enc(params.join('&'))].join('&');
  o.oauth_signature = crypto.createHmac('sha1', enc(cred.s) + '&').update(base).digest('base64');
  return 'OAuth realm="Schoology API", ' + Object.entries(o).map(([k, v]) => `${k}="${enc(v)}"`).join(', ');
}
async function get(cred, path, hops = 0) {
  const url = path.startsWith('https://') ? path : API + path;
  if (new URL(url).hostname !== 'api.schoology.com') throw new Fail(502, 'Schoology sent an unexpected address.');
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetch(url, { redirect: 'manual', headers: { Authorization: authorization(url, cred), Accept: 'application/json' } }); }
    catch (e) { throw new Fail(502, "Couldn't reach Schoology. Try again in a minute."); }
    if (r.status === 429 && attempt < 4) { await sleep(1200 * (attempt + 1)); continue; }
    if (r.status >= 300 && r.status < 400) {
      const next = r.headers.get('Location');
      if (!next || hops >= 3) throw new Fail(502, 'Schoology sent too many redirects.');
      return get(cred, new URL(next, url).toString(), hops + 1);
    }
    if (r.status === 401) throw new Fail(401, "Schoology didn't accept that key and secret. Copy both again from Schoology's API page (if you pressed Reset there, use the new ones).");
    if (r.status === 403 || r.status === 404) return null;
    if (!r.ok) throw new Fail(502, 'Schoology returned an error (' + r.status + '). Try again later.');
    try { return await r.json(); } catch (e) { return null; }
  }
}
async function list(cred, path, field) {
  const out = [];
  for (let start = 0, page = 0; page < 10; page++, start += 200) {
    const j = await get(cred, `${path}${path.includes('?') ? '&' : '?'}start=${start}&limit=200`);
    const rows = (j && Array.isArray(j[field])) ? j[field] : [];
    out.push(...rows);
    if (rows.length < 200 || !(j.links && j.links.next)) break;
  }
  return out;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
async function me(cred) {
  const u = await get(cred, '/users/me');
  if (!u || !(u.uid || u.id)) throw new Fail(401, "Schoology didn't accept that key and secret. Copy both again from Schoology's API page.");
  return { id: String(u.uid || u.id), name: u.name_display || [u.name_first, u.name_last].filter(Boolean).join(' ') };
}

/* ---------- Building StudyFlow's course list (same shape as a pasted Grades page) ---------- */
const day = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
const usDate = v => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(v || ''); if (!m) return ''; const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; };
const num = v => v === null || v === undefined || v === '' || isNaN(+v) ? null : +v;

async function courses(cred) {
  const user = await me(cred);
  const sections = await list(cred, `/users/${user.id}/sections`, 'section');
  const periodInfo = new Map();
  async function periodDates(id, title) {
    const t = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(title || '');
    if (t) return { start: usDate(t[1]), end: usDate(t[2]) };
    if (!periodInfo.has(id)) periodInfo.set(id, get(cred, `/gradingperiods/${id}`).catch(() => null));
    const p = await periodInfo.get(id);
    return { start: day(p && p.start), end: day(p && p.end) };
  }
  let checks = 0;
  const today = new Date().toISOString().slice(0, 10);
  const built = await pool(sections, 3, async s => {
    const [assignments, grades] = await Promise.all([
      list(cred, `/sections/${s.id}/assignments`, 'assignment'),
      get(cred, `/users/${user.id}/grades?section_id=${s.id}`),
    ]);
    const g = grades && Array.isArray(grades.section) ? (grades.section.find(x => String(x.section_id) === String(s.id)) || grades.section[0]) : null;
    let cats = g && Array.isArray(g.grading_category) ? g.grading_category : null;
    if (!cats) { const c = await get(cred, `/sections/${s.id}/grading_categories`); cats = c && Array.isArray(c.grading_category) ? c.grading_category : []; }
    const catName = new Map(cats.map(c => [String(c.id), String(c.title || '').trim()]));
    // Each graded item and the grading period it is in.
    const scored = new Map(), periodOf = new Map(), periods = new Map();
    for (const p of (g && Array.isArray(g.period) ? g.period : [])) {
      periods.set(String(p.period_id), String(p.period_title || '').trim());
      for (const a of (Array.isArray(p.assignment) ? p.assignment : [])) { scored.set(String(a.assignment_id), a); periodOf.set(String(a.assignment_id), String(p.period_id)); }
    }
    // Discussions and tests can be graded without being in the assignments list; the section's grade items fill them in.
    let items = assignments.filter(a => a && a.id && a.published !== 0 && a.published !== '0');
    const known = new Set(items.map(a => String(a.id)));
    if ([...scored.keys()].some(id => !known.has(id))) {
      const extra = await list(cred, `/sections/${s.id}/grade_items`, 'assignment').catch(() => []);
      items = items.concat(extra.filter(a => a && a.id && !known.has(String(a.id))));
    }
    const byPeriod = new Map();
    for (const a of items) {
      const id = String(a.id), gr = scored.get(id), pid = periodOf.get(id) || String(a.grading_period || '');
      const due = day(a.due);
      const it = { title: String(a.title || '').trim(), cat: catName.get(String((gr && gr.category_id) || a.grading_category || '')) || '', due, score: null, total: null, submitted: false };
      if (!it.title) continue;
      const exception = gr ? +gr.exception || 0 : 0;   // 1 excused, 2 incomplete, 3 missing
      if (gr && num(gr.grade) !== null && exception !== 1) { it.score = num(gr.grade); it.total = num(gr.max_points) ?? num(a.max_points); if (!(it.total > 0)) { it.score = null; it.total = null; } }
      if (exception === 1) it.submitted = true;
      // Turned in but not graded yet: ask Schoology about recent work that takes submissions.
      const recent = due && due >= new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10) && due <= new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
      if (it.score === null && !it.submitted && recent && String(a.allow_dropbox) === '1' && checks < MAX_SUBMISSION_CHECKS) {
        checks++;
        const sub = await get(cred, `/sections/${s.id}/submissions/${id}/${user.id}`).catch(() => null);
        if (sub && Array.isArray(sub.revision) && sub.revision.length) it.submitted = true;
      }
      if (!byPeriod.has(pid)) byPeriod.set(pid, []);
      byPeriod.get(pid).push(it);
    }
    const cw = {};
    cats.forEach(c => { const w = num(c.weight); if (w > 0 && c.title) cw[String(c.title).trim()] = w; });
    const out = [];
    for (const [pid, list2] of byPeriod) {
      const name = (periods.get(pid) || '').replace(/:\s*\d{1,2}\/.*$/, '').trim();
      const dates = pid ? await periodDates(pid, periods.get(pid)) : { start: '', end: '' };
      out.push({ name, ...dates, cats: cw, items: list2 });
    }
    out.sort((a, b) => (a.start || '9') < (b.start || '9') ? -1 : 1);
    const name = [String(s.course_title || '').trim(), String(s.section_title || '').trim()].filter(Boolean).join(': ');
    return out.length && name ? { name, periods: out } : null;
  });
  return { name: user.name, courses: built.filter(Boolean), today };
}

/* ---------- Requests ---------- */
const cors = origin => ({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' });
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function handle(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Forbidden' }, 403, {});
  const h = cors(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, h);
  try {
    const uid = await signedInUser(request);
    let body; try { body = await request.json(); } catch (e) { throw new Fail(400, 'Bad request'); }
    if (body && body.action === 'connect') {
      const k = String(body.key || '').replace(/\s+/g, ''), s = String(body.secret || '').replace(/\s+/g, '');
      if (!/^[\x21-\x7e]{6,200}$/.test(k) || !/^[\x21-\x7e]{6,200}$/.test(s)) throw new Fail(400, 'Paste both the Consumer Key and the Consumer Secret from Schoology\'s API page.');
      const user = await me({ k, s });
      return json({ token: seal({ k, s }, uid), name: user.name }, 200, h);
    }
    if (body && body.action === 'sync') {
      const cred = unseal(body.token, uid);
      return json(await courses(cred), 200, h);
    }
    throw new Fail(400, 'Bad request');
  } catch (e) {
    return json({ error: e instanceof Fail ? e.message : 'Something went wrong on the server. Try again later.' }, e instanceof Fail ? e.status : 500, h);
  }
}

export const POST = handle;
export const OPTIONS = handle;
export const GET = handle;
