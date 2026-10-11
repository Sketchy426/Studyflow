// StudyFlow Schoology relay as a Vercel Function: POST /api/schoology {"url": "<feed link>"}.
// Same rules as worker/schoology-relay.js (the Cloudflare version): it only fetches Schoology
// calendar feed links, only answers StudyFlow's own pages, and stores and logs nothing.

// The StudyFlow sites allowed to use this relay. Add your own address here if it changes.
const ALLOWED_ORIGINS = ['https://studyflow-one-pi.vercel.app', 'https://sketchy426.github.io'];
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function feedUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://')); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.protocol = 'https:';
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'schoology.com' && !host.endsWith('.schoology.com')) return null;
  if (!/\/calendar\/feed\/ical\//i.test(u.pathname)) return null;
  return u;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const reply = (body, status, headers, type = 'text/plain; charset=utf-8') =>
  new Response(body, { status, headers: { ...headers, 'Content-Type': type, 'Cache-Control': 'no-store' } });

async function handle(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) return reply('Forbidden', 403, {});
  const cors = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply('Method not allowed', 405, cors);

  let body;
  try { body = await request.json(); } catch (e) { return reply('Bad request', 400, cors); }
  let url = feedUrl(body && body.url);
  if (!url) return reply('Not a Schoology calendar feed link', 400, cors);

  let res;
  for (let hops = 0; ; hops++) {
    try {
      res = await fetch(url.toString(), { redirect: 'manual', headers: { Accept: 'text/calendar' } });
    } catch (e) { return reply('Could not reach Schoology', 502, cors); }
    const next = res.status >= 300 && res.status < 400 && res.headers.get('Location');
    if (!next) break;
    if (hops >= MAX_REDIRECTS) return reply('Too many redirects', 502, cors);
    url = feedUrl(new URL(next, url).toString());
    if (!url) return reply('Schoology sent the feed somewhere else. Check the feed link.', 502, cors);
  }
  if (!res.ok) return reply('Schoology returned ' + res.status, 502, cors);
  if (Number(res.headers.get('Content-Length') || 0) > MAX_BYTES) return reply('Feed too large', 502, cors);

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return reply('Feed too large', 502, cors);
  const text = new TextDecoder().decode(buf);
  if (!/BEGIN:VCALENDAR/.test(text.slice(0, 2000))) return reply('That link did not return a calendar', 502, cors);
  return reply(text, 200, cors, 'text/calendar; charset=utf-8');
}

export const POST = handle;
export const OPTIONS = handle;
export const GET = handle;
