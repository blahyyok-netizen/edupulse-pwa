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

// Firebase-проєкт коледжу. Ці ідентифікатори публічні за своєю природою: ті самі,
// що вбудовані в офіційний застосунок EduPulse (Google OAuth-клієнт і web-ключ
// Firebase). Єдиний секрет у проекті — приватний ключ VAPID.
const GOOGLE_CLIENT_ID = '510124052044-i8hhrh7s4ijmfn0jstm2hktghp94pvup.apps.googleusercontent.com';
const FIREBASE_API_KEY = 'AIzaSyD2QDru_xQHFAZ1rad97jnUi-DEcnTR0Rw';
const FIREBASE_AUTH_DOMAIN = 'edupulse-main.firebaseapp.com';
const FIREBASE_PROJECT_ID = 'edupulse-main';
const WORKSPACE_DOMAIN = 'sclnau.com.ua';
const WP = 'https://sclnau.com.ua/wp-json/wp/v2';

// TT_URL — перевизначення бази старого PHP-сайту для локальних тестів.
function ttPhpBase(env) {
  return (env && env.TT_URL) || TT;
}

// TT_API_URL — перевизначення бази кабінету коледжу (mock у test/push.e2e.mjs).
function ttApiBase(env) {
  return (env && env.TT_API_URL) || TT_API;
}

// FIREBASE_API_URL — те саме для Firebase.
function firebaseBase(env) {
  return (env && env.FIREBASE_API_URL) || 'https://identitytoolkit.googleapis.com';
}


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
  return new Response(text, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/json',
      'cache-control': res.ok ? 'public, max-age=60' : 'no-store',
    },
  });
}

function assetHeaders(contentType, url) {
  const v = url.searchParams.get('v');
  const immutable = v && v === VERSION;
  return {
    'content-type': contentType,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  };
}

// --- Вхід через Google (Firebase) ---

let authConfig = null;

async function getAuthConfig(env) {
  if (authConfig) return authConfig;
  try {
    const res = await fetch(ttApiBase(env) + '/admin/auth/config');
    if (res.ok) {
      const data = await res.json();
      if (data && data.workspace_domain) authConfig = data;
    }
  } catch (e) { }
  if (!authConfig) authConfig = { google_client_id: GOOGLE_CLIENT_ID, workspace_domain: WORKSPACE_DOMAIN };
  return authConfig;
}

// Перевірка токена на боці Firebase: відповідь приходить лише для справжнього
// токена цього проєкту (підпис перевіряє сам Firebase).
async function firebaseLookup(env, idToken) {
  const res = await fetch(firebaseBase(env) + '/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  const users = data && Array.isArray(data.users) ? data.users : [];
  return users[0] || null;
}

// Твердження токена без підпису — лише щоб дізнатися термін дії.
function jwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  } catch (e) {
    return null;
  }
}

// Оновлення сесії: refresh-токен -> новий id-токен (живе до години).
async function firebaseRefresh(env, refreshToken) {
  return fetch(firebaseBase(env) + '/v1/accounts:refresh?key=' + FIREBASE_API_KEY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
}

// --- Журнал ---
//
// Кабінет коледжу (tt-api) не описує формат відповіді в OpenAPI, тож приводимо її
// до стабільної структури {journal: [...]}, яку вже вміє малювати застосунок.

function firstArray(obj, keys) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k];
  return [];
}

function markValue(entry) {
  const raw = entry.mark !== undefined ? entry.mark : entry.mark_value;
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    const v = raw.value !== undefined ? raw.value : raw.mark;
    return v === null || v === undefined || v === '' ? null : { value: String(v), comment: raw.comment || '' };
  }
  const v = raw !== undefined && raw !== null ? raw
    : entry.value !== undefined ? entry.value
    : entry.grade !== undefined ? entry.grade : null;
  return v === null || v === undefined || v === '' ? null : { value: String(v), comment: '' };
}

function normalizeJournal(data) {
  const disciplines = firstArray(data, ['journal', 'disciplines', 'subjects', 'items']);
  return {
    journal: disciplines.map((d) => {
      let sessions = firstArray(d, ['sessions', 'lessons', 'classes']);
      // Плоска структура: предмет одразу містить записи без обгортки «заняття».
      if (!sessions.length) {
        const flat = firstArray(d, ['entries', 'marks', 'records']);
        if (flat.length) sessions = [{ date: d.date || '', entries: flat }];
      }
      return {
        discipline_id: d.discipline_id !== undefined ? d.discipline_id : (d.id !== undefined ? d.id : null),
        discipline: d.discipline || d.discipline_name || d.name || d.title || 'Предмет',
        teacher: d.teacher || d.teacher_name || d.teacher_full_name || '',
        sessions: sessions.map((s) => ({
          date: s.date || s.date_str || s.lesson_date || '',
          pair_number: s.pair_number !== undefined ? s.pair_number : (s.pair !== undefined ? s.pair : (s.number !== undefined ? s.number : null)),
          entries: firstArray(s, ['entries', 'marks', 'records']).map((e) => ({
            number: e.number !== undefined ? e.number : null,
            kind: e.kind || e.kind_of || 'lesson',
            type: e.type || e.type_of || e.assessment_type || '',
            mark: markValue(e),
            topic: e.topic || '',
            homework: e.homework || '',
            self_study: e.self_study || '',
          })),
        })),
      };
    }),
  };
}

// Свой журнал за токеном користувача.
async function fetchMyJournal(env, token) {
  try {
    const res = await fetch(ttApiBase(env) + '/journal/me', {
      headers: { authorization: 'Bearer ' + token, 'user-agent': 'okhttp/4.12.0' },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data ? normalizeJournal(data) : null;
  } catch (e) {
    return null;
  }
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

// Сесія підписника: id-токен протухає за годину, тож тримаємо в KV і refresh-токен,
// і оновлений id-токен.
async function sessionFor(env, sub) {
  if (sub.idToken && sub.idTokenExpires && sub.idTokenExpires > Date.now() + 60000) {
    return { token: sub.idToken, refreshToken: sub.refreshToken, changed: false };
  }
  if (!sub.refreshToken) return null;
  const res = await firebaseRefresh(env, sub.refreshToken).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.id_token) return null;
  sub.idToken = data.id_token;
  sub.idTokenExpires = Date.now() + (Number(data.expires_in || 3600) - 60) * 1000;
  if (data.refresh_token) sub.refreshToken = data.refresh_token;
  return { token: sub.idToken, refreshToken: sub.refreshToken, changed: true };
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


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const origin = url.origin;

    if (pathname.startsWith('/api/')) {
      const q = url.searchParams.toString();

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
        const refreshToken = String(body.refreshToken || '').trim();
        if (!refreshToken) return json({ error: 'Sign in required' }, 401);
        const id = await sha256Hex(sub.endpoint);
        const record = {
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          email: String(body.email || '').trim(),
          refreshToken,
          idToken: null,
          idTokenExpires: 0,
          createdAt: Date.now(),
          marks: {},
        };
        // Базовий знімок журналу: щоб перша перевірка не повідомила про всю історію.
        const session = await sessionFor(env, record);
        if (session) {
          const journal = await fetchMyJournal(env, session.token);
          if (journal) record.marks = pruneMarks(collectMarks(journal).marks);
        }
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
        return passThrough(ttPhpBase(env), '/student/getGroups.php');
      }
      if (pathname === '/api/dates') {
        return passThrough(ttPhpBase(env), '/getScheduleDates.php');
      }
      if (pathname === '/api/schedule') {
        const p = new URLSearchParams(q);
        if (p.get('date')) p.set('date', toApiDate(p.get('date')));
        return passThrough(ttPhpBase(env), '/student/GetStudent.php' + (p.toString() ? '?' + p.toString() : ''));
      }
      if (pathname === '/api/teachers') {
        return passThrough(ttPhpBase(env), '/teacher/getTeacherList.php');
      }
      if (pathname === '/api/teacher-schedule') {
        const p = new URLSearchParams(q);
        if (p.get('date')) p.set('date', toApiDate(p.get('date')));
        return passThrough(ttPhpBase(env), '/teacher/GetTeacher.php' + (p.toString() ? '?' + p.toString() : ''));
      }
      if (pathname === '/api/contacts') {
        return passThrough(ttPhpBase(env), '/others/contacts.json');
      }
      if (pathname === '/api/payments') {
        return passThrough(ttPhpBase(env), '/others/payments.json');
      }
      if (pathname === '/api/config') {
        const cfg = await getAuthConfig(env);
        return json({
          firebase: {
            apiKey: FIREBASE_API_KEY,
            authDomain: FIREBASE_AUTH_DOMAIN,
            projectId: FIREBASE_PROJECT_ID,
          },
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
        // Токен випустив Firebase-проєкт коледжу — той самий, що й в офіційному
        // застосунку. Кабінет приймає саме такі токени, а кого саме показувати —
        // вирішує вже сам кабінет (він знає, чи це студент, чи батько).
        const user = await firebaseLookup(env, body.idToken);
        if (!user) return json({ error: 'Auth failed', details: 'Невірний токен' }, 401);
        const claims = jwtClaims(body.idToken);
        if (claims && claims.aud && claims.aud !== FIREBASE_PROJECT_ID) {
          return json({ error: 'Auth failed', details: 'Токен не від цього проєкту' }, 401);
        }
        const email = (user.email || '').toLowerCase();
        if (!email) return json({ error: 'Auth failed', details: 'Акаунт без пошти' }, 401);
        const expiresIn = claims && claims.exp
          ? Math.max(60, claims.exp - Math.floor(Date.now() / 1000))
          : 3600;
        return json({
          idToken: body.idToken,
          refreshToken: body.refreshToken || null,
          expiresIn,
          email: user.email || null,
          displayName: user.displayName || null,
          photoUrl: user.photoUrl || null,
          localId: user.localId || null,
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
        const res = await firebaseRefresh(env, body.refreshToken);
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) return json({ error: 'Refresh failed' }, res.status || 500);
        return json({
          idToken: data.id_token,
          refreshToken: data.refresh_token,
          expiresIn: data.expires_in,
          userId: data.user_id,
        });
      }
      if (pathname === '/api/journal') {
        const auth = request.headers.get('authorization') || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        if (!token) return json({ error: 'Sign in required' }, 401);
        const res = await fetch(ttApiBase(env) + '/journal/me', {
          headers: { authorization: 'Bearer ' + token, 'user-agent': 'okhttp/4.12.0' },
        });
        if (res.status === 401) return json({ error: 'Sign in required' }, 401);
        if (res.status === 403) return json({ error: 'Journal not allowed', details: 'Цей акаунт не має доступу до журналу' }, 403);
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) return json({ error: 'Journal unavailable' }, 502);
        return json(normalizeJournal(data));
      }
      if (pathname === '/api/news') {
        return passThrough(WP, '/posts' + (q ? '?' + q : ''));
      }
      if (pathname.startsWith('/api/news/')) {
        const id = pathname.split('/')[3];
        return passThrough(WP, `/posts/${encodeURIComponent(id)}` + (q ? '?' + q : ''));
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
        const session = await sessionFor(env, sub);
        if (!session) continue;
        const journal = await fetchMyJournal(env, session.token);
        if (!journal) continue;
        const res = await checkSubscription(env, sub, keyPair, journal);
        if (res.dead) {
          await env.PUSH_SUBS.delete(name);
          continue;
        }
        // Пишемо в KV лише коли знімок справді змінився: безкоштовний
        // тариф дає 1000 записів на добу, а хронологія бігає двічі на годину.
        if (res.changed || session.changed) await env.PUSH_SUBS.put(name, JSON.stringify(sub));
      } catch (e) { }
    }
  },
};
