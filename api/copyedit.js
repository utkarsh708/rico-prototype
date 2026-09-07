import { put, list } from '@vercel/blob';

const PREFIX = 'copyedit/log/';
const PAGES = new Set(['website', 'hello', 'install', 'setup', 'console', 'slack', 'prototype-shell']);
const ALIGN = new Set(['left', 'center', 'right', 'justify']);
const CASE = new Set(['none', 'uppercase', 'lowercase', 'capitalize']);

/* Append-only store: one immutable blob per log entry. No read-modify-write,
   so concurrent saves never clobber each other and CDN caching is harmless. */
async function readLog() {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, limit: 1000, cursor });
    const chunk = await Promise.all(page.blobs.map(async b => {
      try {
        const r = await fetch(b.url);
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    }));
    out.push(...chunk.filter(Boolean));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)));
  return out;
}

async function writeEntry(entry) {
  const name = PREFIX + String(entry.ts).padStart(14, '0') + '_' + entry.id + '.json';
  await put(name, JSON.stringify(entry), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    cacheControlMaxAge: 31536000
  });
}

function fold(log) {
  const reverted = new Set(log.filter(e => e.action === 'revert').map(e => e.target));
  const out = {};
  for (const e of log) {
    if (e.action !== 'save' || reverted.has(e.id)) continue;
    (out[e.page] ||= {})[e.key] = { after: e.after, props: e.props || {}, logId: e.id, user: e.user, ts: e.ts };
  }
  return out;
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function cleanProps(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (p.fontSize != null && isFinite(+p.fontSize)) out.fontSize = clamp(+p.fontSize, 8, 120);
  if (p.fontWeight != null && /^[1-9]00$/.test(String(p.fontWeight))) out.fontWeight = +p.fontWeight;
  if (p.lineHeight != null && isFinite(+p.lineHeight)) out.lineHeight = clamp(+p.lineHeight, 0.8, 3);
  if (p.letterSpacing != null && isFinite(+p.letterSpacing)) out.letterSpacing = clamp(+p.letterSpacing, -5, 20);
  if (ALIGN.has(p.textAlign)) out.textAlign = p.textAlign;
  if (CASE.has(p.textTransform)) out.textTransform = p.textTransform;
  if (typeof p.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(p.color)) out.color = p.color;
  return out;
}

function cleanUser(u) {
  if (!u || typeof u !== 'object') return { name: 'Unknown', email: '' };
  return {
    name: String(u.name || 'Unknown').slice(0, 60),
    email: String(u.email || '').slice(0, 120)
  };
}

function newId(kind) {
  return kind + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    const log = await readLog();
    return res.status(200).json({ log, overrides: fold(log) });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'bad json' });

    if (body.action === 'save') {
      const e = body.entry || {};
      if (!PAGES.has(e.page)) return res.status(400).json({ ok: false, error: 'bad page' });
      if (typeof e.key !== 'string' || e.key.length > 400 || !/^[a-z0-9>:()#-]+$/i.test(e.key)) {
        return res.status(400).json({ ok: false, error: 'bad key' });
      }
      if (typeof e.after !== 'string' || e.after.length > 2000) return res.status(400).json({ ok: false, error: 'bad after' });
      const entry = {
        id: newId('e'),
        action: 'save',
        page: e.page,
        key: e.key,
        before: String(e.before || '').slice(0, 2000),
        after: e.after,
        props: cleanProps(e.props),
        user: cleanUser(e.user),
        ts: Date.now()
      };
      await writeEntry(entry);
      const log = await readLog();
      return res.status(200).json({ ok: true, id: entry.id, overrides: fold(log) });
    }

    if (body.action === 'revert') {
      if (typeof body.logId !== 'string' || body.logId.length > 40) return res.status(400).json({ ok: false, error: 'bad logId' });
      const entry = { id: newId('r'), action: 'revert', target: body.logId, user: cleanUser(body.user), ts: Date.now() };
      await writeEntry(entry);
      const log = await readLog();
      return res.status(200).json({ ok: true, overrides: fold(log) });
    }

    return res.status(400).json({ ok: false, error: 'bad action' });
  }

  return res.status(405).json({ ok: false, error: 'method' });
}
