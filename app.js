const $ = (id) => document.getElementById(id);
const LS = {
  group: 'ep_group', theme: 'ep_theme',
  mode: 'ep_mode', teacher: 'ep_teacher',
  lastName: 'ep_lastname', firstName: 'ep_firstname',
  token: 'ep_token', refresh: 'ep_refresh', expires: 'ep_expires', email: 'ep_email',
  sched: (k, d) => 'ep_sched_' + k + '_' + d,
  journal: 'ep_journal',
};

const TTL = {
  dates: 15 * 60 * 1000,
  sched: 6 * 60 * 60 * 1000,
  journal: 24 * 60 * 60 * 1000,
  news: 30 * 60 * 1000,
  contacts: 24 * 60 * 60 * 1000,
};

const state = {
  groups: [],
  teachers: [],
  contacts: null,
  payments: null,
  mode: localStorage.getItem(LS.mode) || 'student',
  selectedDate: null,
  availableDates: [],
  calY: null,
  calM: null,
  token: localStorage.getItem(LS.token) || null,
  refreshToken: localStorage.getItem(LS.refresh) || null,
  expiresAt: Number(localStorage.getItem(LS.expires) || 0),
  email: localStorage.getItem(LS.email) || '',
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function cacheSet(key, data, ttl) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data }));
  } catch (e) { }
  return data;
}

function cacheGet(key, ttl) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const box = JSON.parse(raw);
    if (!box || typeof box.t !== 'number' || box.d === undefined) return null;
    if (Date.now() - box.t > ttl) { localStorage.removeItem(key); return null; }
    return box.d;
  } catch (e) {
    return null;
  }
}

function saveAuth(data) {
  state.token = data.idToken;
  state.refreshToken = data.refreshToken || state.refreshToken;
  state.expiresAt = Date.now() + (Number(data.expiresIn || 3600) - 60) * 1000;
  state.email = data.email || state.email;
  localStorage.setItem(LS.token, state.token);
  localStorage.setItem(LS.refresh, state.refreshToken || '');
  localStorage.setItem(LS.expires, String(state.expiresAt));
  if (data.email) localStorage.setItem(LS.email, data.email);
}

async function logout() {
  const endpoint = push.subscription && push.subscription.endpoint;
  if (endpoint) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => null);
  }
  [LS.token, LS.refresh, LS.expires, LS.email, LS.journal].forEach((k) => localStorage.removeItem(k));
  state.token = null;
  state.refreshToken = null;
  state.expiresAt = 0;
  state.email = '';
}

async function api(path, opts = {}) {
  const doFetch = () => fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
  });
  let res = await doFetch();
  if (res.status === 401 && state.refreshToken) {
    try {
      const r = await fetch('/api/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      });
      if (r.ok) {
        const d = await r.json();
        saveAuth(d);
        res = await doFetch();
      } else if (r.status === 400) {
        await logout();
      }
    } catch (e) { }
  }
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
}

const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
// Локальна дата: toISOString() кидає на UTC і вночі зміщує день.
const todayISO = () => isoOf(new Date());

function prettyDate(value) {
  const s = String(value || '');
  const months = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
  let d = null, m = null;
  let iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) { d = Number(iso[3]); m = Number(iso[2]); }
  else {
    iso = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
    if (iso) { d = Number(iso[1]); m = Number(iso[2]); }
  }
  if (!d || !m || m < 1 || m > 12) return s;
  return d + ' ' + months[m - 1];
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(LS.theme, t);
  $('themeBtn').textContent = t === 'dark' ? '🌙' : '☀️';
}

function setView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const target = $('view-' + name);
  if (target) target.classList.add('active');
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  window.scrollTo(0, 0);
}

function loader(el) { el.innerHTML = '<div class="loader"><span></span></div>'; }
function clear(el) { el.innerHTML = ''; }
function empty(el, text) { el.innerHTML = '<div class="empty">' + esc(text) + '</div>'; }

async function loadGroups(select, withFaculties) {
  if (!state.groups.length) {
    const data = await apiJson('/api/groups');
    if (data && Array.isArray(data.groups)) {
      state.groups = data.groups.flatMap((d) => (d.groups || []).map((g) => ({ group: g, faculty: d.faculty })));
    }
  }
  fillWho(select, withFaculties);
}

async function loadTeachers(select) {
  if (!state.teachers.length) {
    const data = await apiJson('/api/teachers');
    if (data && Array.isArray(data.teachers)) state.teachers = data.teachers;
  }
  fillWho(select, false);
}

function fillWho(select, withFaculties) {
  const isTeacher = state.mode === 'teacher';
  const cur = isTeacher ? localStorage.getItem(LS.teacher) : localStorage.getItem(LS.group);
  const items = isTeacher
    ? state.teachers.map((t) => ({ value: t, label: t }))
    : state.groups.map((g) => ({ value: g.group, label: g.group }));
  select.innerHTML = items.map((it) =>
    '<option value="' + esc(it.value) + '"' + (it.value === cur ? ' selected' : '') + '>' + esc(it.label) + '</option>'
  ).join('');
  if (isTeacher) {
    select.onchange = () => { localStorage.setItem(LS.teacher, select.value); state.selectedDate = null; renderSchedule(); };
  } else {
    select.onchange = () => { localStorage.setItem(LS.group, select.value); state.selectedDate = null; renderSchedule(); };
    if (select.value) localStorage.setItem(LS.group, select.value);
  }
}

const MONTHS = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
const WD = ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'];

function renderCalendar() {
  const box = $('calBox');
  if (!box) return;
  const avail = new Set(state.availableDates || []);
  const selected = state.selectedDate || todayISO();
  const todayStr = todayISO();

  if (state.calY == null) {
    const b = new Date(selected + 'T00:00:00');
    state.calY = b.getFullYear();
    state.calM = b.getMonth();
  }
  const y = state.calY, m = state.calM;
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(new Date(y, m, 1 - (offset - i)));
  for (let i = 1; i <= new Date(y, m + 1, 0).getDate(); i++) cells.push(new Date(y, m, i));
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1];
    cells.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
  }

  box.innerHTML =
    '<div class="cal-head"><button class="cal-nav" id="calPrev" aria-label="Назад">&#8249;</button>' +
    '<div class="cal-title" id="calTitle">' + MONTHS[m] + ' ' + y + '</div>' +
    '<button class="cal-today" id="calToday">Сьогодні</button>' +
    '<button class="cal-nav" id="calNext" aria-label="Вперед">&#8250;</button></div>' +
    '<div class="cal-wd">' + WD.map((w) => '<span>' + w + '</span>').join('') + '</div>' +
    '<div class="cal-grid">' + cells.map((d) => {
      const iso = isoOf(d);
      const cls = ['cal-cell'];
      if (d.getMonth() !== m) cls.push('dim');
      if (avail.has(iso)) cls.push('has');
      if (iso === todayStr) cls.push('today');
      if (iso === selected) cls.push('active');
      return '<div class="' + cls.join(' ') + '" data-d="' + iso + '">' + d.getDate() + '</div>';
    }).join('') + '</div>';

  $('calPrev').onclick = () => {
    if (state.calM === 0) { state.calM = 11; state.calY--; } else { state.calM--; }
    renderCalendar();
  };
  $('calNext').onclick = () => {
    if (state.calM === 11) { state.calM = 0; state.calY++; } else { state.calM++; }
    renderCalendar();
  };
  $('calTitle').onclick = () => {
    const b = new Date((state.selectedDate || todayISO()) + 'T00:00:00');
    state.calY = b.getFullYear();
    state.calM = b.getMonth();
    renderCalendar();
  };
  $('calToday').onclick = () => {
    const iso = todayISO();
    state.selectedDate = iso;
    const b = new Date(iso + 'T00:00:00');
    state.calY = b.getFullYear();
    state.calM = b.getMonth();
    renderSchedule();
  };
  box.querySelectorAll('.cal-cell').forEach((c) => c.onclick = () => {
    const iso = c.dataset.d;
    if (iso === state.selectedDate) return;
    state.selectedDate = iso;
    const b = new Date(iso + 'T00:00:00');
    state.calY = b.getFullYear();
    state.calM = b.getMonth();
    renderSchedule();
  });
}

async function fetchDates() {
  const cached = cacheGet('ep_dates', TTL.dates);
  if (cached) return cached;
  const data = await apiJson('/api/dates');
  const list = data && Array.isArray(data.dates) ? data.dates.slice().sort() : [];
  if (!list.length) {
    const fallback = cacheGet('ep_dates', 7 * 24 * 60 * 60 * 1000);
    return fallback || list;
  }
  return cacheSet('ep_dates', list, TTL.dates);
}

// Найближча до сьогодні дата з доступних; якщо сьогодні немає — найближча майбутня, інакше остання минула.
function pickDate(list, today) {
  if (!list.length) return today;
  if (list.includes(today)) return today;
  const upcoming = list.filter((d) => d > today);
  if (upcoming.length) return upcoming[0];
  return list[list.length - 1];
}

async function renderSchedule() {
  const select = $('whoSel');
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  if (state.mode === 'student') await loadGroups(select);
  else await loadTeachers(select);

  const key = state.mode === 'teacher' ? 't:' + (select.value || '') : 'g:' + (select.value || '') ;
  if (!select.value) {
    empty($('scheduleList'), state.mode === 'teacher' ? 'Обери викладача' : 'Обери групу');
    clear($('tProgress'));
    return;
  }

  const list = await fetchDates();
  const today = todayISO();
  const sel = state.selectedDate || pickDate(list, today);
  state.selectedDate = sel;
  state.availableDates = list;
  renderCalendar();

  const cacheKey = LS.sched(key, sel);
  const cached = cacheGet(cacheKey, TTL.sched);
  if (!navigator.onLine && cached) { drawSchedule(cached, true); return; }
  loader($('scheduleList'));
  clear($('tProgress'));

  const path = state.mode === 'teacher'
    ? '/api/teacher-schedule?teacher=' + encodeURIComponent(select.value) + '&date=' + sel
    : '/api/schedule?group=' + encodeURIComponent(select.value) + '&date=' + sel;

  let data = null;
  try {
    const res = await api(path);
    if (res.ok) { data = cacheSet(cacheKey, await res.json(), TTL.sched); }
    else if (cached) data = cached;
  } catch (e) { if (cached) data = cached; }
  if (!data) { empty($('scheduleList'), 'Немає зв\'язку з сервером'); return; }
  drawSchedule(data, false);
}

function pairMinutes(time) {
  const m = /(\d{1,2}):(\d{2})/.exec(time || '');
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const m2 = /(\d{1,2}):(\d{2})/.exec((String(time).split('-')[1] || ''));
  const end = m2 ? Number(m2[1]) * 60 + Number(m2[2]) : start + 50;
  return { start, end };
}

function drawSchedule(data, fromCache) {
  const el = $('scheduleList');
  const prog = $('tProgress');
  clear(prog);
  if (!data || data.status !== true || !Array.isArray(data.schedule) || !data.schedule.length) {
    empty(el, (data && data.message) || ('На цю дату занять немає' + (fromCache ? ' (кеш)' : '')));
    return;
  }
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isToday = state.selectedDate === todayISO();

  el.innerHTML = data.schedule
    .slice()
    .sort((a, b) => (a.pairNumber || 0) - (b.pairNumber || 0))
    .map((p) => {
      const t = pairMinutes(p.time);
      const isNow = isToday && t && nowMin >= t.start && nowMin < t.end;
      const isNext = isToday && t && !isNow && t.start > nowMin;
      return '<div class="card pair' + (isNow ? ' now' : '') + (isNext ? ' next' : '') + '">' +
        '<div class="pair-num">' + esc(p.pairNumber || '?') + '<small>' + esc(p.time || '') + '</small></div>' +
        '<div class="pair-body"><div class="pair-subject">' + esc(p.subject || '—') + '</div>' +
        '<div class="pair-meta">' + esc(p.teacher || '') + (p.room ? ' · ауд. ' + esc(p.room) : '') + (p.group ? ' · ' + esc(p.group) : '') + '</div>' +
        (p.isReplacement ? '<span class="tag rep">заміна</span>' : '') +
        (isNow ? '<span class="tag live">зараз</span>' : '') + '</div></div>';
    }).join('');

  if (data.progress && Array.isArray(data.progress.subjects) && data.progress.subjects.length) {
    const pr = data.progress;
    const bar = (pct, color) => '<div style="height:6px;border-radius:99px;background:var(--surface-variant);margin-top:8px"><div style="height:6px;border-radius:99px;background:' + color + ';width:' + Math.min(100, Math.max(0, pct)) + '%"></div></div>';
    prog.innerHTML = '<div class="section-title">Прогрес предметів</div>' + pr.subjects.map((s) => {
      const pct = s.totalPairs ? Math.round(100 * (s.completedPairs || 0) / s.totalPairs) : 0;
      return '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px;font-size:13.5px"><b>' + esc(s.name || s.discipline || '—') + '</b><span style="white-space:nowrap">' + (s.completedPairs || 0) + '/' + (s.totalPairs || 0) + '</span></div>' +
        (s.teacher || s.group ? '<div class="muted small" style="margin-top:2px">' + esc(s.teacher || s.group) + '</div>' : '') +
        bar(pct, 'var(--primary)') + '</div>';
    }).join('') + (typeof pr.overallProgress === 'number'
      ? '<div class="card"><div style="display:flex;justify-content:space-between;font-size:13.5px"><b>Загалом</b><span>' + pr.overallProgress + '%</span></div>' +
      (typeof pr.readPairs === 'number' ? '<div class="muted small" style="margin-top:2px">Прочитано пар: ' + pr.readPairs + ' з ' + (pr.totalPairs || '?') + '</div>' : '') +
      bar(pr.overallProgress, 'var(--icon-bg)') + '</div>'
      : '');
  }
}

// --- Вхід через Firebase ---
//
// Кабінет коледжу приймає токен того самого Firebase-проєкту, що й офіційний
// застосунок EduPulse, тож входимо так само: popup Firebase-обробника на домені
// проєкту. Проєкт дозволяє вхід лише зі свого переліку доменів, а нашого там
// немає, тому підміняємо дві речі: список авторизованих доменів (/v1/projects)
// і redirectUrl обробника.
//
// redirectUrl обробник читає як «домен застосунку» і передає його Google як
// context_uri — а Google звіряє його з авторизованими JS-origin цього клієнта.
// У «Authorized origins» клієнта коледжу є лише edupulse-main.firebaseapp.com,
// тому підставляємо саме його: інакше Google відповідає «origin_mismatch».
// edupulse-main.web.app у переліку авторизованих доменів проєкту є, але в
// авторизованих origin Google — ні, тому з web.app вхід не проходить.

const FB_SDK = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
];
const FB_APP_DOMAIN = 'https://edupulse-main.firebaseapp.com';

let fbPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('script'));
    document.head.appendChild(s);
  });
}

function patchFirebaseAuth() {
  if (window.__epFbPatched) return;
  window.__epFbPatched = true;

  const open = window.open.bind(window);
  window.open = function (url, ...rest) {
    if (typeof url === 'string' && url.indexOf('/__/auth/handler') !== -1) {
      try {
        const u = new URL(url, location.href);
        u.searchParams.set('redirectUrl', FB_APP_DOMAIN);
        url = u.toString();
      } catch (e) { }
      const w = open(url, ...rest);
      // Якщо вікно не відкрилося, Firebase переводить на «редирект» — користувач
      // опиняється на сторонньому сайті без сесії. Краще одразу сказати про блокування.
      if (!w) {
        const err = new Error('popup blocked');
        err.code = 'ep-popup-blocked';
        throw err;
      }
      return w;
    }
    return open(url, ...rest);
  };

  const doFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const raw = typeof input === 'string' ? input : ((input && input.url) || '');
    if (raw.indexOf('/v1/projects') !== -1) {
      return doFetch(input, init).then(async (res) => {
        const data = await res.clone().json().catch(() => null);
        if (!data || !Array.isArray(data.authorizedDomains)) return res;
        if (data.authorizedDomains.indexOf(location.hostname) === -1) {
          data.authorizedDomains.push(location.hostname);
          return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return res;
      });
    }
    return doFetch(input, init);
  };
}

function firebaseApp() {
  if (fbPromise) return fbPromise;
  fbPromise = (async () => {
    const cfg = await apiJson('/api/config');
    const fb = cfg.firebase;
    if (!fb || !fb.apiKey) throw new Error('config');
    patchFirebaseAuth();
    for (const src of FB_SDK) await loadScript(src);
    return firebase.initializeApp({ apiKey: fb.apiKey, authDomain: fb.authDomain, projectId: fb.projectId });
  })();
  fbPromise.catch(() => { fbPromise = null; });
  return fbPromise;
}

function firebaseErrorText(e) {
  const code = e && e.code ? String(e.code) : '';
  if (code === 'ep-popup-blocked') return 'Браузер заблокував вікно входу — дозвольте спливаючі вікна для цього сайту';
  if (code === 'auth/popup-blocked') return 'Браузер заблокував вікно входу — дозвольте спливаючі вікна';
  if (code === 'auth/popup-closed-by-user') return 'Вхід скасовано';
  if (code === 'auth/unauthorized-domain') return 'Домен не авторизований у Firebase-проєкті коледжу';
  if (code === 'auth/network-request-failed') return 'Немає звʼязку з сервером авторизації';
  return 'Не вдалося увійти через Google';
}

async function signInWithGoogle() {
  const btn = $('fbSignIn');
  if (btn) { btn.disabled = true; btn.textContent = 'Вхід…'; }
  try {
    await firebaseApp();
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await firebase.auth().signInWithPopup(provider);
    const idToken = cred && cred.credential ? cred.credential.idToken : null;
    const user = firebase.auth().currentUser;
    if (!idToken) throw new Error('no token');
    const res = await fetch('/api/auth', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken, refreshToken: user ? user.refreshToken : null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.details || data.error || 'Не вдалося увійти', 'err');
      return;
    }
    saveAuth(data);
    toast('Вхід виконано');
    renderJournal();
  } catch (e) {
    toast(firebaseErrorText(e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Увійти через Google'; }
  }
}

function journalHead() {
  if (!state.token) {
    return '<div class="card"><b>Журнал потребує входу</b>' +
      '<div class="muted small" style="margin-top:6px">Журнал лежить у кабінеті коледжу й віддається лише після входу. Увійдіть своїм акаунтом Google — журнал і сповіщення про нові оцінки запрацюють.</div>' +
      '<div id="gSignIn" style="display:flex;justify-content:center;margin-top:14px">' +
      '<button id="fbSignIn" class="btn">Увійти через Google</button></div></div>';
  }
  return '<div class="row" style="align-items:center;margin-bottom:0">' +
    '<span class="muted small" id="whoami">' + esc(state.email || 'Ви увійшли') + '</span>' +
    '<button id="logoutBtn" class="btn ghost small-btn" style="margin-left:auto">Вийти</button></div>' +
    '<div class="row" style="margin-top:16px;margin-bottom:0"><button id="pushBtn" class="btn ghost block">🔔 Увімкнути сповіщення</button></div>' +
    '<div class="muted small" id="pushHint" style="margin-top:6px"></div>';
}

async function renderJournal() {
  const el = $('journalList');
  const head = $('journalHead');
  const mode = state.token ? 'in' : 'out';
  if (head.dataset.mode !== mode) {
    head.innerHTML = journalHead();
    head.dataset.mode = mode;
    if (state.token) {
      $('logoutBtn').onclick = async () => { await logout(); renderJournal(); };
    } else {
      $('fbSignIn').onclick = signInWithGoogle;
      firebaseApp().catch(() => { });
    }
  }
  if (!state.token) {
    empty(el, 'Увійдіть, щоб побачити свій журнал');
    return;
  }
  refreshPushState();
  fetchJournal();
}

async function fetchJournal() {
  const el = $('journalList');
  const key = LS.journal;
  const cached = cacheGet(key, TTL.journal);
  if (!navigator.onLine && cached) { drawJournal(cached, true); return; }
  loader(el);
  let data = null;
  try {
    const res = await api('/api/journal');
    if (res.ok) {
      data = cacheSet(key, await res.json(), TTL.journal);
    } else if (res.status === 401) {
      await logout();
      empty(el, 'Сесія завершилась. Увійдіть знову.');
      renderJournal();
      return;
    } else if (res.status === 403) {
      const d = await res.json().catch(() => ({}));
      empty(el, d.details || 'Цей акаунт не має доступу до журналу');
      return;
    }
  } catch (e) { }
  if (!data && cached) data = cached;
  if (!data) { empty(el, 'Не вдалося завантажити журнал'); return; }
  drawJournal(data, false);
}

function drawJournal(data, fromCache) {
  const el = $('journalList');
  const subjects = (data && Array.isArray(data.journal)) ? data.journal : [];
  if (!subjects.length) { empty(el, 'Журнал порожній'); return; }
  el.innerHTML = subjects.map((s, i) => {
    const sessions = Array.isArray(s.sessions) ? s.sessions : [];
    const marks = [];
    sessions.forEach((ses) => (ses.entries || []).forEach((en) => { if (en.mark && en.mark.value) marks.push(en.mark.value); }));
    const nums = marks.map(Number).filter((n) => !isNaN(n) && n > 0);
    const avg = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : '—';
    const lessons = sessions.map((ses) => {
      const date = prettyDate(ses.date || '') + (ses.pair_number ? ', ' + ses.pair_number + ' пара' : '');
      return (ses.entries || []).map((en) => {
        const mk = en.mark && en.mark.value ? '<span class="mark' + (Number(en.mark.value) < 3 ? ' bad' : '') + '">' + esc(en.mark.value) + '</span>' : '';
        const kind = en.kind === 'assessment' ? 'оцінка' : (en.type || '');
        return '<div class="lesson"><div class="lesson-top"><span class="lesson-date">' + esc(date) + (kind ? ' · ' + esc(kind) : '') + '</span>' + mk + '</div>' +
          (en.topic ? '<div class="lesson-topic">' + esc(en.topic) + '</div>' : '') +
          (en.homework ? '<div class="lesson-hw">ДЗ: ' + esc(en.homework) + '</div>' : '') +
          (en.self_study ? '<div class="lesson-hw muted">Самостійно: ' + esc(en.self_study) + '</div>' : '') + '</div>';
      }).join('');
    }).join('');
    return '<div class="subject' + (i === 0 ? ' open' : '') + '">' +
      '<div class="subject-head"><div><div class="name">' + esc(s.discipline || 'Предмет') + '</div><div class="t">' + esc(s.teacher || '') + '</div></div><div class="avg">' + avg + '</div></div>' +
      '<div class="subject-body">' + lessons + '</div></div>';
  }).join('') + (fromCache ? '<div class="empty small">показано з кешу</div>' : '');
  el.querySelectorAll('.subject-head').forEach((h) => h.onclick = () => h.parentElement.classList.toggle('open'));
}

// --- Сповіщення (Web Push) ---

const push = {
  supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  subscription: null,
};

function b64ToBytes(base64) {
  const s = String(base64).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function pushHint(text) {
  const el = $('pushHint');
  if (el) el.textContent = text;
}

function drawPushRow() {
  const btn = $('pushBtn');
  if (!btn) return;
  if (!push.supported) {
    btn.disabled = true;
    btn.textContent = '🔕 Сповіщення недоступні';
    pushHint('Браузер не підтримує push. На iPhone додайте сайт на головний екран (Safari → «Поділитися» → «На екран “Домів”») і відкривайте звідти.');
    return;
  }
  if (isIos() && !isStandalone()) {
    btn.disabled = true;
    btn.textContent = '🔕 Сповіщення недоступні';
    pushHint('На iPhone сповіщення працюють лише у встановленому застосунку: «Поділитися» → «На екран “Домів”», далі відкривайте застосунок звідти.');
    return;
  }
  if (Notification.permission === 'denied') {
    btn.disabled = true;
    btn.textContent = '🔕 Сповіщення заборонені';
    pushHint('Дозвіл на сповіщення можна повернути в налаштуваннях сайту в браузері.');
    return;
  }
  const ready = !!state.token;
  btn.disabled = !ready && !push.subscription;
  btn.textContent = push.subscription ? '🔕 Вимкнути сповіщення' : '🔔 Увімкнути сповіщення';
  if (!ready) {
    pushHint('Спершу увійдіть — інакше немає кого перевіряти в журналі.');
  } else {
    pushHint('Сповіщення приходять, коли в журналі з’явиться нова оцінка. Журнал перевіряється двічі на годину.');
  }
}

async function pushRegistration() {
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
  return Promise.race([ready, timeout]);
}

async function refreshPushState() {
  if (!push.supported) { drawPushRow(); return; }
  try {
    const reg = await pushRegistration();
    push.subscription = await reg.pushManager.getSubscription();
  } catch (e) {
    push.subscription = null;
  }
  drawPushRow();
}

async function sendPushSubscription(sub) {
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      refreshToken: state.refreshToken,
      email: state.email,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || ('HTTP ' + res.status));
  }
}

async function enablePush() {
  if (!state.token || !state.refreshToken) {
    toast('Спершу увійдіть', 'err');
    return;
  }
  const btn = $('pushBtn');
  if (btn) btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('Сповіщення не дозволено', 'err');
      drawPushRow();
      return;
    }
    const cfg = await apiJson('/api/push/key');
    if (!cfg.publicKey) throw new Error('сервер не віддав ключ сповіщень');
    const reg = await pushRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToBytes(cfg.publicKey),
      });
    }
    push.subscription = sub;
    await sendPushSubscription(sub);
    toast('Сповіщення увімкнено');
  } catch (e) {
    toast('Не вдалося увімкнути сповіщення: ' + (e.message || e), 'err');
  }
  drawPushRow();
}

async function disablePush() {
  const sub = push.subscription;
  try {
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => null);
      await sub.unsubscribe();
    }
    push.subscription = null;
    toast('Сповіщення вимкнено');
  } catch (e) {
    toast('Не вдалося вимкнути сповіщення', 'err');
  }
  drawPushRow();
}

async function renderNews() {
  const el = $('newsList');
  const key = 'ep_news';
  const cached = cacheGet(key, TTL.news);
  if (!navigator.onLine && cached) { drawNews(cached, true); return; }
  loader(el);
  let data = null;
  try {
    const res = await api('/api/news?per_page=10&page=1&_embed=true');
    if (res.ok) { data = cacheSet(key, await res.json(), TTL.news); }
  } catch (e) { }
  if (!data && cached) data = cached;
  if (!data) { empty(el, 'Не вдалося завантажити новини'); return; }
  drawNews(data, false);
}

function drawNews(posts, fromCache) {
  const el = $('newsList');
  if (!Array.isArray(posts) || !posts.length) { empty(el, 'Новин немає'); return; }
  el.innerHTML = posts.map((p) => {
    const img = p._embedded && p._embedded['wp:featuredmedia'] && p._embedded['wp:featuredmedia'][0]
      ? (p._embedded['wp:featuredmedia'][0].source_url || '') : '';
    const title = (p.title && p.title.rendered) || 'Без назви';
    const excerpt = (p.excerpt && p.excerpt.rendered || '').replace(/<[^>]+>/g, '').slice(0, 140);
    const d = p.date ? new Date(p.date).toLocaleDateString('uk-UA') : '';
    return '<div class="card news-item"><a href="' + esc(p.link || '#') + '" target="_blank" rel="noopener">' +
      (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '') +
      '<div class="news-title">' + esc(title) + '</div>' +
      (d ? '<div class="news-date">' + esc(d) + '</div>' : '') +
      (excerpt ? '<div class="muted small" style="margin-top:6px">' + esc(excerpt) + '…</div>' : '') + '</a></div>';
  }).join('') + (fromCache ? '<div class="empty small">показано з кешу</div>' : '');
}

async function renderContacts() {
  const el = $('contactsList');
  if (state.contacts) { drawContacts(state.contacts, false); return; }
  loader(el);
  let data = null;
  const cached = cacheGet('ep_contacts', TTL.contacts);
  try {
    const res = await api('/api/contacts');
    if (res.ok) { data = cacheSet('ep_contacts', await res.json(), TTL.contacts); }
  } catch (e) { }
  if (!data && cached) data = cached;
  if (!data) { empty(el, 'Контакти недоступні'); return; }
  state.contacts = data;
  drawContacts(data, false);
}

function drawContacts(data, fromCache) {
  const el = $('contactsList');
  const deps = (data && Array.isArray(data.departments)) ? data.departments : [];
  if (!deps.length) { empty(el, 'Контакти недоступні'); return; }
  el.innerHTML = deps.map((d) =>
    '<div class="dept"><div class="dept-head">' + esc(d.title || '') + '</div><div class="dept-body">' +
    (d.items || []).map((p) =>
      '<div class="person"><div class="n">' + esc(p.name) + '</div>' +
      (p.position ? '<div class="p">' + esc(p.position) + (p.room ? ' · каб. ' + esc(p.room) : '') + '</div>' : '') +
      (p.phone ? '<a href="tel:' + esc(p.phone) + '">📞 ' + esc(p.phone) + '</a>' : '') +
      (p.mobile ? '<a href="tel:' + esc(p.mobile) + '">📱 ' + esc(p.mobile) + '</a>' : '') +
      (p.email ? '<a href="mailto:' + esc(p.email.trim()) + '">✉️ ' + esc(p.email.trim()) + '</a>' : '') + '</div>'
    ).join('') + '</div></div>'
  ).join('') + (fromCache ? '<div class="empty small">показано з кешу</div>' : '');
  el.querySelectorAll('.dept-head').forEach((h) => h.onclick = () => h.parentElement.classList.toggle('open'));
}

async function renderPayments() {
  const el = $('paymentsList');
  if (state.payments) { drawPayments(state.payments); return; }
  loader(el);
  let data = null;
  const cached = cacheGet('ep_payments', TTL.contacts);
  try {
    const res = await api('/api/payments');
    if (res.ok) { data = cacheSet('ep_payments', await res.json(), TTL.contacts); }
  } catch (e) { }
  if (!data && cached) data = cached;
  if (!data) { empty(el, 'Реквізити недоступні'); return; }
  state.payments = data;
  drawPayments(data);
}

function drawPayments(data) {
  const el = $('paymentsList');
  const list = (data && Array.isArray(data.payments)) ? data.payments : [];
  if (!list.length) { empty(el, 'Реквізити недоступні'); return; }
  el.innerHTML = list.map((p) => {
    const group = localStorage.getItem(LS.group) || '___';
    const last = localStorage.getItem(LS.lastName) || '___';
    const first = localStorage.getItem(LS.firstName) || '___';
    const purpose = String(p.purpose || '').replace(/%lastname%/g, last).replace(/%firstname%/g, first).replace(/%group%/g, group);
    return '<div class="card"><div class="pay-title">' + esc(p.title) + '</div>' +
      '<div class="pay-line">Одержувач: <b>' + esc(p.recipient) + '</b></div>' +
      '<div class="pay-line">ЄДРПОУ: <b>' + esc(p.EDRPOU) + '</b> <button class="copy-btn" data-copy="' + esc(p.EDRPOU) + '">копія</button></div>' +
      '<div class="pay-line">IBAN: <b>' + esc(p.IBAN) + '</b> <button class="copy-btn" data-copy="' + esc(p.IBAN) + '">копія</button></div>' +
      '<div class="pay-line">Призначення: <b>' + esc(purpose) + '</b> <button class="copy-btn" data-copy="' + esc(purpose) + '">копія</button></div></div>';
  }).join('');
  el.querySelectorAll('.copy-btn').forEach((b) => b.onclick = () => {
    const v = b.dataset.copy;
    if (navigator.clipboard) navigator.clipboard.writeText(v);
    b.textContent = 'готово ✓';
    setTimeout(() => b.textContent = 'копія', 1200);
  });
}

function renderPayWho() {
  const el = $('payWho');
  if (!el) return;
  const g = localStorage.getItem(LS.group) || '';
  const l = localStorage.getItem(LS.lastName) || '';
  const f = localStorage.getItem(LS.firstName) || '';
  el.innerHTML =
    '<div class="section-title" style="margin-top:0">Дані для призначення платежу</div>' +
    '<div class="row"><input id="pGroup" class="input" placeholder="Група" value="' + esc(g) + '"></div>' +
    '<div class="row"><input id="pLast" class="input" placeholder="Прізвище" value="' + esc(l) + '"><input id="pFirst" class="input" placeholder="Ім\'я" value="' + esc(f) + '"></div>';
  const save = () => {
    localStorage.setItem(LS.group, $('pGroup').value.trim());
    localStorage.setItem(LS.lastName, $('pLast').value.trim());
    localStorage.setItem(LS.firstName, $('pFirst').value.trim());
    if (state.payments) drawPayments(state.payments);
  };
  ['pGroup', 'pLast', 'pFirst'].forEach((id) => { $(id).oninput = save; });
}

function renderMore() {
  renderPayWho();
  renderContacts();
  renderPayments();
}

async function route() {
  const hash = location.hash || '#/schedule';
  const name = hash.replace('#/', '').split('/')[0] || 'schedule';
  setView(['schedule', 'journal', 'news', 'more'].includes(name) ? name : 'schedule');
  if (name === 'schedule') renderSchedule();
  else if (name === 'journal') renderJournal();
  else if (name === 'news') renderNews();
  else if (name === 'more') renderMore();
}

document.querySelectorAll('.seg').forEach((b) => b.onclick = () => {
  state.mode = b.dataset.mode;
  localStorage.setItem(LS.mode, state.mode);
  state.selectedDate = null;
  renderSchedule();
});
window.addEventListener('hashchange', route);
$('themeBtn').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}
applyTheme(localStorage.getItem(LS.theme) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
route();
