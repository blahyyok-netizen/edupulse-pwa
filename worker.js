import indexHtml from './index.html';
import stylesCss from './styles.css';
import appJs from './app.js';
import manifestJson from './manifest.webmanifest';
import swJs from './sw.js';
import icon192 from './icon-192.png';
import icon512 from './icon-512.png';
import appleIcon from './apple-touch-icon.png';
import { encryptPush, generateEcdhKeyPair, signVapidJwt, b64uDecode } from './webpush.mjs';

const TT = 'https://tt.sclnau.com.ua';
const TT_API = 'https://tt-api.sclnau.com.ua';
const JOURNAL_API = 'https://journal-api.sclnau.com.ua/api/v1';

// JOURNAL_API_URL — перевизначення бази журнального API для локальних тестів (mock у test/roster.e2e.mjs і test/push.e2e.mjs).
function journalApiBase(env) {
  return (env && env.JOURNAL_API_URL) || JOURNAL_API;
}
const WP = 'https://sclnau.com.ua/wp-json/wp/v2';

const GOOGLE_CLIENT_ID = '510124052044-i8hhrh7s4ijmfn0jstm2hktghp94pvup.apps.googleusercontent.com';
const FIREBASE_API_KEY = 'AIzaSyD2QDru_xQHFAZ1rad97jnUi-DEcnTR0Rw';
const WORKSPACE_DOMAIN = 'sclnau.com.ua';

// Ключ Journal API. Публічний за своєю природою: той самий, що вбудований у мобільний
// додаток коледжу, і доступний кожному, хто встановив застосунок.
// Тому лежить у відкритому коді — це не витік. Якщо все ж захочеш сховати його,
// задайте JOURNAL_API_TOKEN (wrangler secret): він матиме пріоритет.
const PUBLIC_JOURNAL_TOKEN = 'Wx8zMVFSWqDbCwYrEhX66rYCtThPeuxHPC11SzY6Q0BDcdRycm5ta6KFrV7WcsAJ';

// Публічні шляхи кабінету коледжу, які проксіюються з Bearer-токеном користувача.
const TT_API_PATHS = {
  '/me': '/workspace/profile',
  '/admin-status': '/workspace/admin-status',
  '/parent/schedule': '/parent/schedule',
  '/parent/schedule/dates': '/parent/schedule/dates',
  '/parent/journal': '/parent/journal',
};

// Публічний ключ VAPID — він і так роздається браузерам. Приватний лежить у секреті
// воркера (VAPID_PRIVATE_KEY), його генерує scripts/gen-vapid-keys.mjs.
const VAPID_PUBLIC_KEY = 'BD9WRsrpsAahSZYjE3IOWnJCUpzY0l0jV_-HD6pyAwTz0uZSUnewbMc9N-JvMy3lRBc-TOoW4H-zzxLT2RSAd3o';
const VAPID_SUBJECT = 'mailto:admin@sclnau.com.ua';
const PUSH_PREFIX = 'sub:';
const PUSH_KEEP_ENTRIES = 2000;

function toText(v) {
  return typeof v === 'string' ? v : new TextDecoder().decode(v);
}

function toBytes(v) {
  if (typeof v === 'string') {
    const out = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i) & 0xff;
    return out;
  }
  return v;
}

function hashOf(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const INDEX_HTML = toText(indexHtml);
const STYLES_CSS = toText(stylesCss);
const APP_JS = toText(appJs);
const MANIFEST = toText(manifestJson);
const SW_JS = toText(swJs);

// Версія = хеш вмісту. Змінюється разом із кодом, тому кеш у браузері та в service worker
// скидається сам, без ручного "?v=N".
const VERSION = hashOf(INDEX_HTML + APP_JS + STYLES_CSS + SW_JS + MANIFEST);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function toApiDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  return m ? m[3] + '.' + m[2] + '.' + m[1] : d;
}

function isSameOrigin(request, origin) {
  const o = request.headers.get('origin');
  return !o || o === origin;
}

async function passThrough(upstream, pathAndQuery, opts = {}) {
  const fetchOpts = Object.assign({}, opts);
  fetchOpts.headers = Object.assign({ 'user-agent': 'okhttp/4.12.0' }, opts.headers || {});
  const res = await fetch(upstream + pathAndQuery, fetchOpts);
  const text = await res.text();
  const isPrivate = !!(opts.headers && opts.headers.authorization);
  return new Response(text, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/json',
      'cache-control': isPrivate ? 'private, no-store' : res.ok ? 'public, max-age=60' : 'no-store',
    },
  });
}

let authConfig = null;
async function getAuthConfig() {
  if (authConfig) return authConfig;
  try {
    const res = await fetch(TT_API + '/admin/auth/config');
    if (res.ok) {
      const data = await res.json();
      if (data && data.workspace_domain) authConfig = data;
    }
  } catch (e) { }
  if (!authConfig) authConfig = { google_client_id: GOOGLE_CLIENT_ID, workspace_domain: WORKSPACE_DOMAIN };
  return authConfig;
}

async function firebaseExchange(idToken, requestUri) {
  const postBody = new URLSearchParams({ id_token: idToken, providerId: 'google.com' }).toString();
  return fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postBody, requestUri, returnIdpCredential: true, returnSecureToken: true }),
    }
  );
}

function assetHeaders(contentType, url) {
  const v = url.searchParams.get('v');
  const immutable = v && v === VERSION;
  return {
    'content-type': contentType,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  };
}

// --- Сповіщення (Web Push) ---

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function listKvKeys(kv, prefix) {
  const names = [];
  let cursor;
  do {
    const res = await kv.list({ prefix, cursor });
    for (const k of res.keys) names.push(k.name);
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return names;
}

async function fetchJournalFor(env, sub) {
  const token = (env && env.JOURNAL_API_TOKEN) || PUBLIC_JOURNAL_TOKEN;
  const q = new URLSearchParams({
    group: sub.group,
    last_name: sub.lastName,
    first_name: sub.firstName,
  });
  try {
    const res = await fetch(journalApiBase(env) + '/journal/?' + q.toString(), {
      headers: { 'X-Auth-Token': token, 'user-agent': 'okhttp/4.12.0' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Карта оцінок журналу: ключ заняття -> підпис його записів.
// Порядок записів у відповіді API не гарантований, тому підпис будуємо з відсортованих
// частин — інакше одна й та сама пара щоразу виглядала б як «нова оцінка».
const FS = '\u001f';
const RS = '\u001e';

function collectMarks(journal) {
  const marks = {};
  const meta = {};
  const disciplines = journal && Array.isArray(journal.journal) ? journal.journal : [];
  disciplines.forEach((d) => {
    const sessions = Array.isArray(d.sessions) ? d.sessions : [];
    sessions.forEach((s) => {
      const entries = Array.isArray(s.entries) ? s.entries : [];
      const parts = entries.map((e) => [
        e.number == null ? '' : String(e.number),
        e.kind || '',
        e.type || '',
        e.mark && e.mark.value ? String(e.mark.value) : '',
      ].join(FS)).sort();
      const key = [s.date || '', d.discipline_id ?? '', s.pair_number ?? ''].join('|');
      marks[key] = marks[key] ? marks[key].split(RS).concat(parts).sort().join(RS) : parts.join(RS);
      meta[key] = { discipline: d.discipline || 'Предмет', date: s.date || '', pair: s.pair_number };
    });
  });
  return { marks, meta };
}

// Лишаємо останні N записів (ключ починається з дати, тож порядок — хронологічний).
// Важливо не різати за «сьогодні»: у学期і журнал може не оновлюватись місяцями,
// і тоді знімок спорожніє, а перша перевірка пришле купу «нових» оцінок.
function pruneMarks(marks) {
  const keys = Object.keys(marks).sort();
  if (keys.length <= PUSH_KEEP_ENTRIES) return marks;
  const out = {};
  for (const k of keys.slice(keys.length - PUSH_KEEP_ENTRIES)) out[k] = marks[k];
  return out;
}

function pushText(change) {
  const m = change.meta;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date.slice(8) + '.' + m.date.slice(5, 7) : '';
  const pair = m.pair ? ', ' + m.pair + ' пара' : '';
  const mark = change.value === 'нб' ? 'не був' : 'оцінка ' + change.value;
  const what = m.kind === 'assessment' ? (m.type || 'оцінювання') : '';
  return m.discipline + (date ? ' (' + date + pair + ')' : '') + ' — ' + mark + (what ? ', ' + what : '');
}

async function sendPush(env, sub, payload, keyPair) {
  const priv = env && env.VAPID_PRIVATE_KEY;
  if (!priv) return { ok: false, status: 0, error: 'no vapid key' };
  let audience;
  try {
    audience = new URL(sub.endpoint).origin;
  } catch (e) {
    return { ok: false, status: 0, error: 'bad endpoint' };
  }
  const token = await signVapidJwt({
    privateKeyRaw: b64uDecode(priv),
    publicKeyRaw: b64uDecode(VAPID_PUBLIC_KEY),
    audience,
    subject: VAPID_SUBJECT,
  });
  const body = await encryptPush({
    plaintext: JSON.stringify(payload),
    p256dh: sub.p256dh,
    auth: sub.auth,
    keyPair,
  });
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: 'vapid t=' + token + ', k=' + VAPID_PUBLIC_KEY,
      ttl: '43200',
      urgency: 'normal',
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'crypto-key': 'dh=' + sub.p256dh,
    },
    body,
  });
  return { ok: res.ok, status: res.status };
}

// Порівняння знімків: ключі сортуємо, бо порядок об'єктів залежить від порядку
// відповіді API, а значення вже відсортовано під час збору.
function snapshotEq(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i]] !== b[kb[i]]) return false;
  }
  return true;
}

// Перевіряє журнал одного підписника і надсилає сповіщення про нові оцінки.
async function checkSubscription(env, sub, keyPair, journal) {
  const { marks, meta } = collectMarks(journal);
  const prev = sub.marks || {};
  const prevCount = Object.keys(prev).length;
  const newCount = Object.keys(marks).length;

  // Базового знімка ще немає — зберігаємо його мовчки, без сповіщень.
  if (!prevCount) {
    sub.marks = pruneMarks(marks);
    return { dead: false, changed: true, notify: false };
  }
  // Сервер віддав менше занять, ніж було в знімку — відповідь обрізана.
  // Ігноруємо такий цикл, інакше наступного разу «зайві» оцінки
  // виглядатимуть як нові й прийдуть фальшиві сповіщення.
  if (newCount < prevCount) return { dead: false, changed: false, notify: false };

  const changes = [];
  for (const key of Object.keys(marks)) {
    const before = (prev[key] || '').split(RS).filter(Boolean);
    if (before.join(RS) === marks[key]) continue;
    const seen = new Set(before);
    for (const part of marks[key].split(RS).filter(Boolean)) {
      if (seen.has(part)) continue;
      const fields = part.split(FS);
      const value = fields[3] || '';
      if (!value) continue;
      changes.push({
        key,
        value,
        meta: Object.assign({}, meta[key], { kind: fields[1], type: fields[2] }),
      });
    }
  }
  if (changes.length) {
    const payload = {
      title: changes.length === 1 ? 'Новий запис у журналі' : 'Нові записи в журналі: ' + changes.length,
      body: changes.slice(0, 3).map(pushText).join('\n') + (changes.length > 3 ? '\n…' : ''),
      url: '/#/journal',
      tag: 'journal',
    };
    const res = await sendPush(env, sub, payload, keyPair);
    if (res.status === 404 || res.status === 410) return { dead: true };
  }
  const next = pruneMarks(marks);
  const changed = !snapshotEq(prev, next);
  sub.marks = next;
  return { dead: false, changed, notify: changes.length > 0 };
}

// --- Ростер і журнал групи ---
// Склад груп — не само registrations: список збирається з PDF «Рейтинг успішності
// студентів» коледжу, а кожне ПІБ перевіряється журнальним API (200 лише для
// справжньої пари «група + прізвище + ім'я»). Готовий ростер лежить у D1.

const GROUP_JOURNAL_PREFIX = 'gj:';
const GROUP_JOURNAL_TTL = 6 * 3600 * 1000;
const GROUP_FETCH_CONC = 6;

function normalizeGroupCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

// Чисельна оцінка. «нб» (не був) та інші нечислові позначення не враховуються.
// Порожня оцінка — це відсутність оцінки, а не нуль: Number('') дав би 0 і
// «розтягнуло» б середній бал усіх неоцінених занять.
function markValue(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().replace(',', '.');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

// Журнал зберігає історію, тож беремо лише поточний навчальний рік.
// Рік у коледжі починається 1 вересня: якщо найновіша дата ще до вересня,
// то це завершений рік і поточним вважаємо попередній.
function academicCutoff(latest) {
  if (!latest) return new Date().getFullYear() + '-09-01';
  let year = Number(latest.slice(0, 4));
  if (Number(latest.slice(5, 7)) < 9) year--;
  return year + '-09-01';
}

function summarizeJournal(data, since) {
  const subjects = new Map();
  const byDiscipline = new Map();
  const all = [];
  for (const d of (data && data.journal) || []) {
    const id = d.discipline_id;
    if (!subjects.has(id)) subjects.set(id, { id, name: d.discipline || 'Предмет', teacher: d.teacher || '' });
    for (const s of d.sessions || []) {
      if (since && (s.date || '') < since) continue;
      for (const e of s.entries || []) {
        const value = markValue(e.mark && e.mark.value);
        if (value == null) continue;
        const item = { id, value, date: s.date || '' };
        all.push(item);
        if (!byDiscipline.has(id)) byDiscipline.set(id, []);
        byDiscipline.get(id).push(item);
      }
    }
  }
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((n, x) => n + x.value, 0) / arr.length) * 100) / 100 : null);
  const marks = {};
  for (const [id, arr] of byDiscipline) marks[id] = avg(arr);
  return {
    subjects: [...subjects.values()],
    marks,
    average: avg(all),
    count: all.length,
  };
}

async function fetchGroupJournals(env, code, students) {
  const token = (env && env.JOURNAL_API_TOKEN) || PUBLIC_JOURNAL_TOKEN;
  const raw = [];
  let failed = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(GROUP_FETCH_CONC, students.length) }, async () => {
    while (cursor < students.length) {
      const s = students[cursor++];
      const q = new URLSearchParams({ group: code, last_name: s.last_name, first_name: s.first_name });
      try {
        const res = await fetch(journalApiBase(env) + '/journal/?' + q.toString(), {
          headers: { 'X-Auth-Token': token, 'user-agent': 'okhttp/4.12.0' },
        });
        if (!res.ok) { failed++; continue; }
        raw.push({ student: s, data: await res.json() });
      } catch (e) { failed++; }
    }
  }));

  // Відкидаємо минулі навчальніроки — у журналі лишаються оцінки за попередні роки.
  let latest = '';
  for (const r of raw) {
    for (const d of (r.data && r.data.journal) || []) {
      for (const s of d.sessions || []) if ((s.date || '') > latest) latest = s.date || '';
    }
  }
  const since = academicCutoff(latest);

  const subjects = new Map();
  const rows = [];
  for (const r of raw) {
    const summary = summarizeJournal(r.data, since);
    for (const sub of summary.subjects) if (!subjects.has(sub.id)) subjects.set(sub.id, sub);
    rows.push({
      student_id: r.student.student_id,
      last_name: r.student.last_name,
      first_name: r.student.first_name,
      average: summary.average,
      count: summary.count,
      marks: summary.marks,
    });
  }
  return { rows, subjects: [...subjects.values()], since, failed };
}

async function groupJournal(env, db, code) {
  const key = GROUP_JOURNAL_PREFIX + code;
  if (env.PUSH_SUBS) {
    try {
      const raw = await env.PUSH_SUBS.get(key);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Date.now() - cached.updated_at < GROUP_JOURNAL_TTL) {
          cached.cached = true;
          return cached;
        }
      }
    } catch (e) { }
  }

  const res = await db.prepare(
    'SELECT student_id, last_name, first_name FROM group_students WHERE group_code = ? ORDER BY student_id'
  ).bind(code).all();
  const students = res.results || [];
  const { rows, subjects, since, failed } = await fetchGroupJournals(env, code, students);

  const disciplineTotals = new Map();
  for (const row of rows) {
    for (const [id, value] of Object.entries(row.marks || {})) {
      if (!disciplineTotals.has(id)) disciplineTotals.set(id, []);
      disciplineTotals.get(id).push(value);
    }
  }
  const disciplineAverage = {};
  for (const [id, arr] of disciplineTotals) {
    disciplineAverage[id] = Math.round((arr.reduce((n, x) => n + x, 0) / arr.length) * 100) / 100;
  }
  const all = rows.filter((r) => r.average != null).map((r) => r.average);
  const payload = {
    code,
    updated_at: Date.now(),
    academic_year_from: since,
    subjects: subjects.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    students: rows,
    discipline_average: disciplineAverage,
    group_average: all.length ? Math.round((all.reduce((n, x) => n + x, 0) / all.length) * 100) / 100 : null,
    // Увесь журнал не прийшов — сервер коледжу не відповів або віддає помилку.
    journal_error: failed > 0 && !rows.length ? 'Сервер журналу коледжу зараз недоступний' : null,
    failed_students: failed || 0,
  };
  if (env.PUSH_SUBS && !payload.journal_error) {
    try { await env.PUSH_SUBS.put(key, JSON.stringify(payload)); } catch (e) { }
  }
  return payload;
}

async function handleRoster(request, env, url) {
  if (!env.DB) return json({ error: 'Ростер недоступний' }, 503);
  const db = env.DB;
  const rest = url.pathname.slice('/api/roster'.length).split('/').filter(Boolean);
  const code = normalizeGroupCode(decodeURIComponent(rest[0] || ''));

  // GET /api/roster — групи, для яких є ростер
  if (!code) {
    const res = await db.prepare(
      'SELECT group_code, COUNT(*) AS count FROM group_students GROUP BY group_code ORDER BY group_code'
    ).all();
    return json({ groups: res.results || [] });
  }

  // GET /api/roster/:code — склад групи
  if (rest.length === 1) {
    const res = await db.prepare(
      'SELECT student_id, last_name, first_name FROM group_students WHERE group_code = ? ORDER BY last_name, first_name'
    ).bind(code).all();
    return json({ code, students: res.results || [] });
  }

  // GET /api/roster/:code/journal — електронний журнал групи
  if (rest.length === 2 && rest[1] === 'journal') {
    const data = await groupJournal(env, db, code);
    return json(data);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const origin = url.origin;
    const journalToken = (env && env.JOURNAL_API_TOKEN) || PUBLIC_JOURNAL_TOKEN;

    if (pathname === '/api/config') {
      const cfg = await getAuthConfig();
      return json({
        googleClientId: cfg.google_client_id || GOOGLE_CLIENT_ID,
        workspaceDomain: cfg.workspace_domain || WORKSPACE_DOMAIN,
      });
    }

    if (pathname === '/api/auth' && request.method === 'POST') {
      if (!isSameOrigin(request, origin)) return json({ error: 'Origin not allowed' }, 403);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Bad request' }, 400);
      }
      if (!body || !body.idToken) return json({ error: 'idToken required' }, 400);

      const cfg = await getAuthConfig();
      const domain = cfg.workspace_domain || WORKSPACE_DOMAIN;
      // requestUri має належати Firebase-проєкту коледжу, а не домену воркера.
      const res = await firebaseExchange(body.idToken, 'https://' + domain);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        return json({ error: 'Auth failed', details: data && data.error ? data.error.message : null }, res.status || 500);
      }
      const email = (data.email || '').toLowerCase();
      if (!email || !email.endsWith('@' + domain)) {
        return json({ error: 'Account not allowed', details: 'Доступ лише для акаунтів @' + domain }, 403);
      }
      return json({
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        email: data.email || null,
        displayName: data.displayName || null,
        photoUrl: data.photoUrl || null,
        localId: data.localId,
      });
    }

    if (pathname === '/api/refresh' && request.method === 'POST') {
      if (!isSameOrigin(request, origin)) return json({ error: 'Origin not allowed' }, 403);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Bad request' }, 400);
      }
      if (!body || !body.refreshToken) return json({ error: 'refreshToken required' }, 400);

      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:refresh?key=${FIREBASE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: body.refreshToken }),
        }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return json({ error: 'Refresh failed' }, res.status || 500);
      return json({
        idToken: data.id_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        userId: data.user_id,
      });
    }

    if (pathname.startsWith('/api/')) {
      const q = url.searchParams.toString();

      if (pathname.startsWith('/api/roster')) {
        return handleRoster(request, env, url);
      }

      if (pathname === '/api/push/key') {
        return json({ publicKey: VAPID_PUBLIC_KEY });
      }

      if (pathname === '/api/push/subscribe' && request.method === 'POST') {
        if (!isSameOrigin(request, origin)) return json({ error: 'Origin not allowed' }, 403);
        if (!env.PUSH_SUBS) return json({ error: 'Push is not configured' }, 503);
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'Bad request' }, 400);
        }
        const sub = body && body.subscription;
        if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return json({ error: 'Invalid subscription' }, 400);
        }
        const group = String(body.group || '').trim();
        const lastName = String(body.lastName || '').trim();
        const firstName = String(body.firstName || '').trim();
        if (!group || !lastName || !firstName) {
          return json({ error: 'group, lastName and firstName are required' }, 400);
        }
        const id = await sha256Hex(sub.endpoint);
        const record = {
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          group,
          lastName,
          firstName,
          createdAt: Date.now(),
          marks: {},
        };
        // Базовий знімок журналу: щоб перша перевірка не повідомила про всю історію.
        const journal = await fetchJournalFor(env, record);
        if (journal) record.marks = pruneMarks(collectMarks(journal).marks);
        await env.PUSH_SUBS.put(PUSH_PREFIX + id, JSON.stringify(record));
        return json({ ok: true, id });
      }

      if (pathname === '/api/push/unsubscribe' && request.method === 'POST') {
        if (!isSameOrigin(request, origin)) return json({ error: 'Origin not allowed' }, 403);
        if (!env.PUSH_SUBS) return json({ error: 'Push is not configured' }, 503);
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'Bad request' }, 400);
        }
        const endpoint = body && body.endpoint;
        if (!endpoint) return json({ error: 'endpoint required' }, 400);
        const id = await sha256Hex(endpoint);
        await env.PUSH_SUBS.delete(PUSH_PREFIX + id);
        return json({ ok: true });
      }

      if (pathname === '/api/groups') {
        return passThrough(TT, '/student/getGroups.php');
      }
      if (pathname === '/api/dates') {
        return passThrough(TT, '/getScheduleDates.php');
      }
      if (pathname === '/api/schedule') {
        const p = new URLSearchParams(q);
        if (p.get('date')) p.set('date', toApiDate(p.get('date')));
        return passThrough(TT, '/student/GetStudent.php' + (p.toString() ? '?' + p.toString() : ''));
      }
      if (pathname === '/api/teachers') {
        return passThrough(TT, '/teacher/getTeacherList.php');
      }
      if (pathname === '/api/teacher-schedule') {
        const p = new URLSearchParams(q);
        if (p.get('date')) p.set('date', toApiDate(p.get('date')));
        return passThrough(TT, '/teacher/GetTeacher.php' + (p.toString() ? '?' + p.toString() : ''));
      }
      if (pathname === '/api/contacts') {
        return passThrough(TT, '/others/contacts.json');
      }
      if (pathname === '/api/payments') {
        return passThrough(TT, '/others/payments.json');
      }
      if (pathname === '/api/journal') {
        return passThrough(journalApiBase(env), '/journal/' + (q ? '?' + q : ''), {
          headers: { 'X-Auth-Token': journalToken },
        });
      }
      if (pathname === '/api/news') {
        return passThrough(WP, '/posts' + (q ? '?' + q : ''));
      }
      if (pathname.startsWith('/api/news/')) {
        const id = pathname.split('/')[3];
        return passThrough(WP, `/posts/${encodeURIComponent(id)}` + (q ? '?' + q : ''));
      }

      const authHeader = request.headers.get('authorization') || '';
      const upstreamPath = TT_API_PATHS[pathname.replace(/^\/api/, '')];
      if (upstreamPath) {
        if (!authHeader) return json({ error: 'Not authenticated' }, 401);
        const headers = { authorization: authHeader };
        const init = { method: request.method, headers };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          headers['content-type'] = 'application/json';
          init.body = await request.text();
        }
        return passThrough(TT_API, upstreamPath + (q ? '?' + q : ''), init);
      }

      return json({ error: 'Not found' }, 404);
    }

    if (pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }
    if (pathname === '/sw.js') {
      const body = SW_JS.replace(/__VERSION__/g, () => VERSION);
      return new Response(body, {
        headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    if (pathname === '/icon-192.png') {
      return new Response(toBytes(icon192), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
    }
    if (pathname === '/icon-512.png') {
      return new Response(toBytes(icon512), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
    }
    if (pathname === '/apple-touch-icon.png') {
      return new Response(toBytes(appleIcon), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
    }
    if (pathname === '/styles.css') {
      return new Response(STYLES_CSS, { headers: assetHeaders('text/css; charset=utf-8', url) });
    }
    if (pathname === '/app.js') {
      return new Response(APP_JS, { headers: assetHeaders('application/javascript; charset=utf-8', url) });
    }

    const html = INDEX_HTML.replace(/__VERSION__/g, () => VERSION);
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  },

  // Хронологія: перевіряє журнал підписників і шле сповіщення про нові оцінки.
  async scheduled(event, env, ctx) {
    if (!env.PUSH_SUBS) return;
    const names = await listKvKeys(env.PUSH_SUBS, PUSH_PREFIX);
    if (!names.length) return;

    const keyPair = await generateEcdhKeyPair();
    const journals = new Map();

    // Один і той самий студент у кількох підписках — запит до коледжу робимо один раз.
    const journalFor = async (sub) => {
      const key = sub.group + '|' + sub.lastName + '|' + sub.firstName;
      if (!journals.has(key)) journals.set(key, await fetchJournalFor(env, sub));
      return journals.get(key);
    };

    for (const name of names) {
      const raw = await env.PUSH_SUBS.get(name);
      if (!raw) continue;
      let sub;
      try {
        sub = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      try {
        const journal = await journalFor(sub);
        if (!journal) continue;
        const res = await checkSubscription(env, sub, keyPair, journal);
        if (res.dead) {
          await env.PUSH_SUBS.delete(name);
          continue;
        }
        // Пишемо в KV лише коли знімок справді змінився: безкоштовний
        // тариф дає 1000 записів на добу, а хронологія бігає двічі на годину.
        if (res.changed) await env.PUSH_SUBS.put(name, JSON.stringify(sub));
      } catch (e) { }
    }
  },
};
