import indexHtml from './index.html';
import stylesCss from './styles.css';
import appJs from './app.js';
import manifestJson from './manifest.webmanifest';
import swJs from './sw.js';
import icon192 from './icon-192.png';
import icon512 from './icon-512.png';
import appleIcon from './apple-touch-icon.png';

const TT = 'https://tt.sclnau.com.ua';
const TT_API = 'https://tt-api.sclnau.com.ua';
const JOURNAL_API = 'https://journal-api.sclnau.com.ua/api/v1';
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
        return passThrough(JOURNAL_API, '/journal/' + (q ? '?' + q : ''), {
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
};
