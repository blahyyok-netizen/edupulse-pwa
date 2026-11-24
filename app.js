const $ = (id) => document.getElementById(id);
const LS = {
  group: 'ep_group', theme: 'ep_theme',
  mode: 'ep_mode', teacher: 'ep_teacher',
  lastName: 'ep_lastname', firstName: 'ep_firstname',
  token: 'ep_token', refresh: 'ep_refresh', expires: 'ep_expires', email: 'ep_email',
  parentToken: 'ep_parent_token', parentExpires: 'ep_parent_expires',
  parentTtl: 'ep_parent_ttl', parentLabel: 'ep_parent_label', parentSeen: 'ep_parent_seen',
  journalMode: 'ep_journal_mode',
  pushKind: 'ep_push_kind', pushEndpoint: 'ep_push_endpoint',
  sched: (k, d) => 'ep_sched_' + k + '_' + d,
  journal: 'ep_journal',
  journalParent: 'ep_journal_parent',
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
  parentToken: localStorage.getItem(LS.parentToken) || null,
  parentExpiresAt: Number(localStorage.getItem(LS.parentExpires) || 0),
  parentTtl: Number(localStorage.getItem(LS.parentTtl) || 0),
  parentLabel: localStorage.getItem(LS.parentLabel) || '',
  parentSeenAt: Number(localStorage.getItem(LS.parentSeen) || 0),
  journalMode: localStorage.getItem(LS.journalMode) || '',
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
  const prevEmail = state.email;
  state.token = data.idToken;
  state.refreshToken = data.refreshToken || state.refreshToken;
  state.expiresAt = Date.now() + (Number(data.expiresIn || 3600) - 60) * 1000;
  state.email = data.email || state.email;
  localStorage.setItem(LS.token, state.token);
  localStorage.setItem(LS.refresh, state.refreshToken || '');
  localStorage.setItem(LS.expires, String(state.expiresAt));
  if (data.email) localStorage.setItem(LS.email, data.email);
  // Зайшли іншим акаунтом — сповіщення мають перевіряти його журнал, не попередній.
  if (data.email && prevEmail && data.email !== prevEmail) resyncPush('student');
}

async function logout() {
  // Підписка на цьому телефоні належить або студентові, або батькові. Вихід
  // студента не має забирати сповіщення батьківського журналу.
  if (pushKind() === 'student') await unregisterPush();
  // Спершу виходимо з Firebase, інакше спостерігач за авторизацією одразу
  // підлогінить користувача назад.
  signInBusy = true;
  try {
    if (typeof firebase !== 'undefined' && firebase.auth) {
      await firebase.auth().signOut();
    }
  } catch (e) { }
  [LS.token, LS.refresh, LS.expires, LS.email, LS.journal, LS.journalMode].forEach((k) => localStorage.removeItem(k));
  state.token = null;
  state.refreshToken = null;
  state.expiresAt = 0;
  state.email = '';
  state.journalMode = '';
  signInBusy = false;
}

// --- Батьківський доступ ---
//
// Студент генерує QR у застосунку коледжу, батько сканує його тут. Активація
// не потребує входу Google, тому працює з будь-якого домену і на будь-якому
// телефоні — зокрема на iPhone, офіційного застосунку для якого немає.

function saveParent(data) {
  const prevToken = state.parentToken;
  state.parentToken = data.token;
  const ttl = Number(data.expiresIn || 0);
  state.parentTtl = ttl;
  // Запас проти годинника пристрою, але не більший за десяту частину строку:
  // для короткого доступа фіксована хвилина зробила б токен мертвим одразу.
  const margin = Math.min(60, Math.floor(ttl * 0.1));
  state.parentExpiresAt = ttl > 0 ? Date.now() + (ttl - margin) * 1000 : 0;
  localStorage.setItem(LS.parentToken, state.parentToken);
  localStorage.setItem(LS.parentExpires, String(state.parentExpiresAt));
  localStorage.setItem(LS.parentTtl, String(ttl));
  if (data.label) setParentLabel(data.label);
  // Кеш попереднього доступу не повинен показатися новому.
  if (prevToken && prevToken !== data.token) localStorage.removeItem(LS.journalParent);
  // Новий QR — новий токен. Без цього сервер і далі перевіряв би старий доступ,
  // отримав би 401 і видалив підписку, а інтерфейс показував би «увімкнено».
  if (prevToken !== data.token) resyncPush('parent');
}

function setParentLabel(label) {
  const text = String(label || '').trim().slice(0, 80);
  if (!text) return;
  state.parentLabel = text;
  localStorage.setItem(LS.parentLabel, text);
}

// Доступ минув, але журнал лишається: людина вже одного разу показала QR, тож
// останні відомі оцінки мають бути на екрані, а не зникати разом із токеном.
function expireParent() {
  state.parentToken = null;
  state.parentExpiresAt = 0;
  state.parentTtl = 0;
  [LS.parentToken, LS.parentExpires, LS.parentTtl].forEach((k) => localStorage.removeItem(k));
  if (pushKind() === 'parent') {
    unregisterPush();
    setPushKind('');
  }
}

async function unlinkParent() {
  const token = state.parentToken;
  if (token) {
    await fetch('/api/parent/revoke', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
    }).catch(() => null);
  }
  if (pushKind() === 'parent') {
    await unregisterPush();
    setPushKind('');
  }
  [LS.parentToken, LS.parentExpires, LS.parentTtl, LS.parentLabel, LS.parentSeen, LS.journalParent]
    .forEach((k) => localStorage.removeItem(k));
  state.parentToken = null;
  state.parentExpiresAt = 0;
  state.parentTtl = 0;
  state.parentLabel = '';
  state.parentSeenAt = 0;
}

async function unregisterPush() {
  const endpoint = push.subscription && push.subscription.endpoint;
  if (!endpoint) return;
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => null);
  // Запису на сервері вже немає — інтерфейс не має й далі показувати «Вимкнути».
  push.subscription = null;
  setPushKind('');
  localStorage.removeItem(LS.pushEndpoint);
}

async function api(path, opts = {}) {
  // Токен потрібен лише журналу. Чіпляти його до публічних запитів не можна:
  // service worker не кешує відповіді на запити з authorization, тож офлайн
  // ламався б саме в увійденого користувача — розклад без груп і без кешу.
  const doFetch = () => fetch(path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(path.startsWith('/api/journal') && state.token ? { authorization: 'Bearer ' + state.token } : {}),
    },
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
  // Батьківський екран відкривається з «Ще» — окремої вкладки в нього немає,
  // тож підсвічуємо «Ще», інакше внизу не світилося б нічого.
  const tab = name === 'parent' ? 'more' : name;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
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
  return state.groups.length > 0;
}

async function loadTeachers(select) {
  if (!state.teachers.length) {
    const data = await apiJson('/api/teachers');
    if (data && Array.isArray(data.teachers)) state.teachers = data.teachers;
  }
  fillWho(select, false);
  return state.teachers.length > 0;
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

// Читання кешу без видалення: прострочений запис ще знадобиться як запасний,
// коли сервер не відповідає. cacheGet() натомість одразу його стирає.
function cachePeek(key) {
  try {
    const box = JSON.parse(localStorage.getItem(key) || 'null');
    return box && box.d !== undefined ? box.d : null;
  } catch (e) {
    return null;
  }
}

async function fetchDates() {
  // Запасний список читаємо ДО cacheGet: той стирає прострочений запис.
  const stale = cachePeek('ep_dates');
  const cached = cacheGet('ep_dates', TTL.dates);
  if (cached) return cached;
  const data = await apiJson('/api/dates');
  const list = data && Array.isArray(data.dates) ? data.dates.slice().sort() : [];
  if (!list.length) {
    // Сервер не віддав дат — беремо останні відомі, хай і старіші за 15 хвилин.
    return (Array.isArray(stale) && stale.length) ? stale : list;
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
  const isTeacher = state.mode === 'teacher';
  const loaded = isTeacher ? await loadTeachers(select) : await loadGroups(select);
  // Порожній список — це не «обери групу», це сервер не відповів. Так і кажемо.
  if (!loaded) {
    clear($('tProgress'));
    empty($('scheduleList'), isTeacher
      ? 'Не вдалося завантажити викладачів — сервер коледжу недоступний'
      : 'Не вдалося завантажити групи — сервер коледжу недоступний');
    return;
  }

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
// проєкту (edupulse-main.firebaseapp.com).
//
// Подію входу Firebase приймає лише тоді, коли домен сторінки, що відкрила його
// iframe авторизації, є в переліку «Authorized domains» проєкту. Перелік бере
// сам Firebase (/v1/projects) — підмінити його з нашого домену неможливо: він
// живе в консолі проєкту, а змінює його лише адміністратор коледжу. Тому перед
// входом питаємо воркер, чи дозволено наш домен, і якщо ні — одразу кажемо, що
// саме треба додати в консолі, замість хвилин очікування й «вхід скасовано».
//
// redirectUrl обробника лишається доменом проєкту: обробник читає його як
// «домен застосунку» і передає Google як context_uri, а в OAuth-клієнті
// коледжу авторизований лише edupulse-main.firebaseapp.com — з іншим доменом
// Google відповідає «origin_mismatch».

const FB_SDK = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
];
const FB_APP_DOMAIN = 'https://edupulse-main.firebaseapp.com';

let fbPromise = null;
let fbConfig = null;

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

// Обробник Firebase має відкритися саме на домені проєкту: цей домен Google
// звіряє з авторизованими origin OAuth-клієнта коледжу.
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
}

function firebaseApp() {
  if (fbPromise) return fbPromise;
  fbPromise = (async () => {
    const cfg = await apiJson('/api/config');
    const fb = cfg.firebase;
    if (!fb || !fb.apiKey) throw new Error('config');
    fbConfig = fb;
    patchFirebaseAuth();
    for (const src of FB_SDK) await loadScript(src);
    const app = firebase.initializeApp({ apiKey: fb.apiKey, authDomain: fb.authDomain, projectId: fb.projectId });
    watchFirebaseAuth();
    return app;
  })();
  fbPromise.catch(() => { fbPromise = null; });
  return fbPromise;
}

// Перевіряємо перелік доменів ще раз — щоб «Спробувати ще раз» бачив зміни,
// які коледж щойно вніс у консоль Firebase.
async function refreshFirebaseConfig() {
  const cfg = await apiJson('/api/config');
  if (cfg && cfg.firebase && cfg.firebase.apiKey) fbConfig = cfg.firebase;
  return fbConfig;
}

// Firebase віддасть подію входу лише сторінці з дозволеним доменом. Якщо
// нашого домену в переліку проєкту немає, popup відкривати безглуздо: вхід
// завершиться помилкою за кілька хвилин. Краще одразу сказати, що треба
// додати домен у консолі коледжу.
function signInDomainError() {
  if (!fbConfig || fbConfig.originAllowed !== false) return null;
  const err = new Error('domain not allowed');
  err.code = 'ep-domain-not-allowed';
  err.domain = location.hostname;
  return err;
}

// Firebase звіряє hostname сторінки з переліком «Authorized domains», тож
// 127.0.0.1 він не вважає за localhost — локально треба відкривати саме
// http://localhost:8799.
function domainBlockedText(host) {
  const h = host || location.hostname;
  if (h === '127.0.0.1' || h === '::1' || h === '[::1]') {
    return 'Локально Firebase дозволяє вхід лише з домену localhost — відкрийте застосунок за http://localhost:8799';
  }
  return 'Домен ' + h + ' не дозволений у Firebase-проєкті коледжу, тож Firebase не віддасть подію входу. Додайте цей домен у Firebase Console → Authentication → Settings → Authorized domains — після цього вхід працюватиме без змін у коді';
}

function firebaseErrorText(e) {
  const code = e && e.code ? String(e.code) : '';
  if (code === 'ep-popup-blocked') return 'Браузер заблокував вікно входу — дозвольте спливаючі вікна для цього сайту';
  if (code === 'auth/popup-blocked') return 'Браузер заблокував вікно входу — дозвольте спливаючі вікна';
  if (code === 'ep-domain-not-allowed') return domainBlockedText(e.domain || location.hostname);
  if (code === 'auth/popup-closed-by-user') return 'Вхід не завершено — спробуйте ще раз';
  if (code === 'auth/unauthorized-domain') return domainBlockedText(location.hostname);
  if (code === 'auth/network-request-failed') return 'Немає звʼязку з сервером авторизації';
  if (e && e.details) return e.details;
  return 'Не вдалося увійти через Google';
}

// Firebase доставляє подію входу кількома каналами: popup-вікно, сховище на
// домені проєкту, і стан авторизації. Обіцянка signInWithPopup може бути
// відхилена, поки сесія вже створилася — тож чекаємо на currentUser.
function firebaseUser(timeoutMs) {
  const auth = firebase.auth();
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve) => {
    let done = false;
    let unsub = () => { };
    const finish = (u) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(u);
    };
    unsub = auth.onAuthStateChanged((u) => { if (u) finish(u); });
    const timer = setTimeout(() => finish(auth.currentUser), timeoutMs);
  });
}

async function exchangeFirebaseUser(user) {
  const idToken = user ? await user.getIdToken() : null;
  const refreshToken = user && user.stsTokenManager ? user.stsTokenManager.refreshToken : null;
  if (!idToken) throw new Error('no token');
  const res = await fetch('/api/auth', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken, refreshToken: refreshToken || null }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'auth failed');
    err.details = data.details || '';
    throw err;
  }
  saveAuth(data);
  return data;
}

let authWatchBound = false;
let signInBusy = false;

// Сесія може з'явитися і після відхилення popup-обіцянки: тоді треба
// обміняти її на сесію воркера, щоб журнал відкрився.
function watchFirebaseAuth() {
  if (authWatchBound) return;
  authWatchBound = true;
  firebase.auth().onAuthStateChanged(async (user) => {
    if (!user || state.token || signInBusy) return;
    try {
      await exchangeFirebaseUser(user);
      toast('Вхід виконано');
      renderJournal();
    } catch (e) { }
  });
}

async function signInWithGoogle() {
  const btn = $('fbSignIn');
  if (btn) { btn.disabled = true; btn.textContent = 'Вхід…'; }
  signInBusy = true;
  try {
    // Перевірка домену — до завантаження SDK: вона потребує лише конфігурації.
    await refreshFirebaseConfig().catch(() => { });
    const domainErr = signInDomainError();
    if (domainErr) throw domainErr;
    await firebaseApp();
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    let user = null;
    try {
      const cred = await firebase.auth().signInWithPopup(provider);
      // Вхід через IdP повертає credential без idToken: токен Firebase лежить
      // у користувачі. Саме його чекає кабінет коледжу.
      user = (cred && cred.user) || firebase.auth().currentUser;
    } catch (e) {
      user = await firebaseUser(15000);
      if (!user) throw e;
    }
    if (!user) user = await firebaseUser(3000);
    if (!user) throw new Error('no user');
    await exchangeFirebaseUser(user);
    toast('Вхід виконано');
    renderJournal();
  } catch (e) {
    toast(firebaseErrorText(e), 'err');
    if (e && e.code === 'auth/unauthorized-domain') {
      // Firebase сам відповів, що домен не дозволений — показуємо це в картці
      // журналу, щоб пояснення лишилося на екрані, а не зникло зі сповіщенням.
      fbConfig = Object.assign({}, fbConfig, { originAllowed: false });
      const head = $('journalHead');
      if (head) head.dataset.mode = '';
      renderJournal();
    }
  } finally {
    signInBusy = false;
    const cur = $('fbSignIn');
    if (cur) {
      cur.disabled = false;
      cur.textContent = signInDomainError() ? 'Спробувати ще раз' : 'Увійти через Google';
    }
  }
}

function journalHead() {
  if (!state.token) {
    const blocked = !!(fbConfig && fbConfig.originAllowed === false);
    const note = blocked
      ? '<div class="muted small" style="margin-top:6px;line-height:1.5">' + esc(domainBlockedText(location.hostname)) + '.</div>'
      : '<div class="muted small" style="margin-top:6px">Журнал лежить у кабінеті коледжу й віддається лише після входу. Увійдіть своїм акаунтом Google — журнал і сповіщення про нові оцінки запрацюють.</div>';
    return '<div class="card"><b>Журнал потребує входу</b>' + note +
      '<div id="gSignIn" style="display:flex;justify-content:center;margin-top:14px">' +
      '<button id="fbSignIn" class="btn">' + (blocked ? 'Спробувати ще раз' : 'Увійти через Google') + '</button></div>' +
      (hasRememberedJournal() || state.parentToken
        ? '<button id="journalQrSwitch" class="access-switch">← Журнал за QR, запам’ятаний на цьому пристрої</button>'
        : '<a class="access-switch" href="#/parent">Немає Google? Журнал за QR від студента →</a>') +
      '</div>';
  }
  return '<div class="row" style="align-items:center;margin-bottom:0">' +
    '<span class="muted small" id="whoami">' + esc(state.email || 'Ви увійшли') + '</span>' +
    '<button id="logoutBtn" class="btn ghost small-btn" style="margin-left:auto">Вийти</button></div>' +
    '<div class="row" style="margin-top:16px;margin-bottom:0"><button id="pushBtn" class="btn ghost block">🔔 Увімкнути сповіщення</button></div>' +
    '<div class="muted small" id="pushHint" style="margin-top:6px"></div>';
}

function wireJournalOut() {
  if ($('fbSignIn')) $('fbSignIn').onclick = signInWithGoogle;
  const back = $('journalQrSwitch');
  if (back) back.onclick = () => {
    state.journalMode = '';
    localStorage.removeItem(LS.journalMode);
    renderJournal();
  };
}

// Запам'ятаний QR перемагає стіну входу Google: людина вже одного разу показала
// код, тож «Журнал» має відкрити її оцінки, а не знову просити акаунт.
function journalUsesParent() {
  return !state.token && state.journalMode !== 'student' &&
    (!!state.parentToken || hasRememberedJournal());
}

async function renderJournal() {
  const el = $('journalList');
  const head = $('journalHead');
  updateJournalDot();
  if (journalUsesParent()) {
    paintAccessHead(head, { studentSwitch: true });
    await loadParentJournal(el);
    return;
  }
  unmountScanner();
  stopAccessTimer();
  // Картка QR лишається лише на одному екрані: прихований заголовок інакше
  // тримав би старі ID, і відлік знаходив би картку, якої на екрані немає.
  const other = $('parentHead');
  if (other) { other.innerHTML = ''; other.dataset.mode = ''; }
  const mode = state.token ? 'in' : 'out';
  if (head.dataset.mode !== mode) {
    head.innerHTML = journalHead();
    head.dataset.mode = mode;
    if (state.token) {
      $('logoutBtn').onclick = async () => { await logout(); renderJournal(); };
      $('pushBtn').onclick = () => (pushOn('student') ? disablePush() : enablePush('student'));
    } else {
      wireJournalOut();
      // Стіна входу має з'явитися одразу, навіть якщо мережа повільна: пояснення
      // про домен Firebase дожене її окремо, а не тримати екран у старому стані.
      refreshFirebaseConfig().then(() => {
        if (signInBusy || state.token || head.dataset.mode !== 'out') return;
        head.innerHTML = journalHead();
        wireJournalOut();
      }).catch(() => { });
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

function drawJournal(data, fromCache, el) {
  el = el || $('journalList');
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
        const raw = en.mark && en.mark.value ? String(en.mark.value) : '';
        // «нб» і «нбп» — відсутність, а не оцінка: їх не можна ні фарбувати в
        // червоне, ні тягнути в середній бал (так їх пояснює застосунок коледжу).
        const absent = /^(нб|нбп)$/i.test(raw);
        const why = raw.toLowerCase() === 'нбп' ? 'Не був з поважної причини' : 'Не був на занятті';
        const mk = raw
          ? '<span class="mark' + (absent ? ' absent' : (Number(raw) < 3 ? ' bad' : '')) + '"' +
            (absent ? ' title="' + why + '"' : '') + '>' + esc(raw) + '</span>'
          : '';
        const comment = en.mark && en.mark.comment ? String(en.mark.comment) : '';
        const kind = en.kind === 'assessment' ? 'оцінка' : (en.type || '');
        return '<div class="lesson"><div class="lesson-top"><span class="lesson-date">' + esc(date) + (kind ? ' · ' + esc(kind) : '') + '</span>' + mk + '</div>' +
          (en.topic ? '<div class="lesson-topic">' + esc(en.topic) + '</div>' : '') +
          (comment ? '<div class="lesson-hw muted">Викладач: ' + esc(comment) + '</div>' : '') +
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

// --- Журнал для батьків ---

const JSQR_CDN = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

const scan = {
  stream: null,
  timer: null,
  video: null,
  canvas: null,
  ctx: null,
  detector: null,
  busy: false,
  // Лічильник запусків: камера йде через кілька await, і за цей час користувач
  // може піти з екрана. Без нього інтервал заводився після stopScan() і жив вічно.
  seq: 0,
};

let activateBusy = false;

// Коледж кладу у QR токен, але як саме — невідомо: це може бути голий рядок,
// JSON або посилання. Розбираємо всі три, щоб батькові не довелося гадати.
function qrTokenFrom(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // decodeURIComponent кидає URIError на «%» без двох шістнадцяткових цифр після
  // нього. У скопійованому посиланні таке буває — і кнопка просто мовчала б.
  const dec = (v) => { try { return decodeURIComponent(v); } catch (e) { return v; } };
  if (s[0] === '{') {
    try {
      const o = JSON.parse(s);
      return String(o.qr_token || o.qrToken || o.token || o.code || '').trim();
    } catch (e) { }
  }
  const q = /[?&](?:qr_token|qrToken|token|code)=([^&#\s]+)/.exec(s);
  if (q) return dec(q[1]);
  if (/^https?:\/\//i.test(s)) {
    const parts = s.split('#')[0].split('?')[0].split('/').filter(Boolean);
    return dec(parts[parts.length - 1] || '');
  }
  return s;
}

// --- Запам'ятаний доступ за QR ---
// Один скан — і журнал лишається на пристрої: вкладка «Журнал» відкриває його
// без Google, доки діє токен. Коли токен минає, оцінки не зникають — вони
// показані з кешу, а згори одразу лежить сканер для нового QR.

const ACCESS_SOON_MS = 5 * 60 * 1000;

function hasRememberedJournal() {
  return !!state.parentLabel || !!cachePeek(LS.journalParent);
}

function parentSession() {
  if (!state.parentToken) return { status: 'none', left: 0, pct: 0, known: false };
  if (!state.parentExpiresAt) return { status: 'ok', left: 0, pct: 100, known: false };
  const left = state.parentExpiresAt - Date.now();
  if (left <= 0) return { status: 'expired', left: 0, pct: 0, known: true };
  const total = state.parentTtl > 0 ? state.parentTtl * 1000 : left;
  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  const soonAt = Math.min(ACCESS_SOON_MS, total * 0.25);
  return { status: left <= soonAt ? 'soon' : 'ok', left, pct, known: true };
}

function leftText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  if (d) return d + ' дн ' + h + ' год';
  if (h) return h + ' год ' + p2(m) + ' хв';
  if (m) return m + ' хв ' + p2(sec) + ' с';
  return sec + ' с';
}

function seenText() {
  if (!state.parentSeenAt) return '';
  return new Date(state.parentSeenAt).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function accessCardHtml(opts) {
  const s = parentSession();
  const name = state.parentLabel || 'Журнал студента';
  const seen = seenText();
  // Картка — статус-смуга, а не герой екрана: оцінки мають бути видно одразу,
  // тому відлік стоїть біля шкали, а дії — в один рядок.
  return '<div class="access-card" id="accessCard" data-state="' + s.status + '">' +
    '<div class="access-top">' +
      '<div class="access-avatar" aria-hidden="true">' + (state.parentLabel ? '🎓' : '👪') + '</div>' +
      '<div class="access-id">' +
        '<div class="access-name" id="accessName">' + esc(name) + '</div>' +
        '<div class="access-sub" id="accessSub">' + (seen ? 'Оновлено ' + esc(seen) : 'Запам’ятано на цьому пристрої') + '</div>' +
      '</div>' +
      '<span class="access-pill" id="accessPill">' + (s.status === 'soon' ? 'Завершується' : 'Активний') + '</span>' +
    '</div>' +
    '<div class="access-line">' +
      '<div class="access-meter" id="accessMeterWrap" role="progressbar" aria-label="Залишок часу доступу" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(s.pct) + '"><i id="accessMeter" style="width:' + s.pct.toFixed(2) + '%"></i></div>' +
      '<span class="access-count" id="accessCount"></span>' +
    '</div>' +
    '<div class="access-foot">' +
      '<button id="accessRenew" class="btn tonal small-btn">Оновити доступ</button>' +
      '<button id="pPushBtn" class="btn ghost small-btn access-push-btn" data-icon="1" aria-label="Сповіщення про нові оцінки">🔔</button>' +
      '<button id="parentUnlink" class="btn ghost small-btn">Відв’язати</button>' +
    '</div>' +
    '<div class="muted small access-push-hint" id="pPushHint" hidden></div>' +
    '<div class="access-renew" id="accessRenewBox" hidden></div>' +
    (opts.studentSwitch ? '<button id="journalGoogleSwitch" class="access-switch">Ви студент? Увійти через Google →</button>' : '') +
    '</div>';
}

function accessOutHtml(expired, opts) {
  return '<div class="card access-out" id="accessOut">' +
    '<div class="access-out-head">' +
      '<span class="access-out-icon" aria-hidden="true">' + (expired ? '⌛' : '👪') + '</span>' +
      '<div><b>' + (expired ? 'Доступ завершився' : 'Журнал без Google') + '</b>' +
      '<div class="muted small">' + (expired
        ? 'Збережені оцінки лишилися нижче. Відскануйте новий QR — журнал оновиться сам.'
        : 'Відскануйте QR один раз — журнал запам’ятається на цьому пристрої й відкриватиметься сам, без входу Google.') + '</div></div>' +
    '</div>' +
    '<div class="access-out-note muted small">Студент відкриває застосунок коледжу на Android → «Для батьків» → показує QR. Код діє кілька хвилин, тому скануйте одразу, як його побачили.</div>' +
    '<div class="scanner-slot"></div>' +
    (expired && state.parentLabel ? '<div class="access-out-who muted small">Останній журнал: <b>' + esc(state.parentLabel) + '</b></div>' : '') +
    (opts && opts.studentSwitch ? '<button id="journalGoogleSwitch" class="access-switch">Ви студент? Увійти через Google →</button>' : '') +
    '</div>';
}

function scanCard() {
  return '<div class="row" style="margin:14px 0 0"><button id="scanBtn" class="btn block">📷 Сканувати камерою</button></div>' +
    '<video id="scanVideo" class="scan-video" playsinline muted></video>' +
    '<div class="muted small" id="scanHint" style="margin-top:6px"></div>' +
    '<div class="row" style="margin:14px 0 0"><input id="codeInput" class="input" placeholder="…або вставте код із QR" aria-label="Код із QR" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
    '<div class="row" style="margin-top:10px;margin-bottom:0"><button id="codeBtn" class="btn ghost block">Відкрити журнал</button></div>';
}

// Сканер у документі один: його вузол переїжджає між екранами, тож ID камери,
// поля коду й кнопки ніколи не дублюються — інакше getElementById брав би чужий.
let scannerEl = null;

function scannerNode() {
  if (scannerEl) return scannerEl;
  const wrap = document.createElement('div');
  wrap.className = 'scanner';
  wrap.innerHTML = scanCard();
  scannerEl = wrap;
  wrap.querySelector('#scanBtn').onclick = () => (scan.stream ? stopScan() : startScan());
  wrap.querySelector('#codeBtn').onclick = () => {
    const input = wrap.querySelector('#codeInput');
    const code = qrTokenFrom(input.value);
    if (!code) { toast('Немає кода', 'err'); return; }
    input.value = '';
    activateParentCode(code);
  };
  return wrap;
}

function mountScanner(target, hint) {
  if (!target) return;
  const node = scannerNode();
  if (node.parentNode !== target) target.appendChild(node);
  // Вузол сканера один і живе між екранами: після успішної активації маршрут
  // перебудував екран раніше, ніж finally повернув кнопку, тож без цього
  // наступне відкриття сканера показало б «Перевіряємо код…» назавжди.
  const btn = node.querySelector('#codeBtn');
  btn.disabled = false;
  btn.textContent = 'Відкрити журнал';
  node.querySelector('#codeInput').value = '';
  scanHint(hint || '');
}

function unmountScanner() {
  stopScan();
  if (scannerEl && scannerEl.parentNode) scannerEl.remove();
}

let accessTimer = null;

function stopAccessTimer() {
  if (accessTimer) { clearInterval(accessTimer); accessTimer = null; }
}

function startAccessTimer() {
  stopAccessTimer();
  tickAccess();
  if (state.parentToken && state.parentExpiresAt) accessTimer = setInterval(tickAccess, 1000);
}

function tickAccess() {
  const card = $('accessCard');
  if (!card) { stopAccessTimer(); return; }
  const s = parentSession();
  if (s.status === 'expired') {
    stopAccessTimer();
    expireParent();
    updateJournalDot();
    toast('Доступ завершився — потрібен новий QR', 'err');
    route();
    return;
  }
  card.dataset.state = s.status;
  updateJournalDot();
  const pill = $('accessPill');
  if (pill) pill.textContent = s.status === 'soon' ? 'Завершується' : 'Активний';
  const count = $('accessCount');
  if (count) count.textContent = s.known ? 'Залишилось ' + leftText(s.left) : 'Термін доступу невідомий';
  const meter = $('accessMeter');
  if (meter) meter.style.width = s.pct.toFixed(2) + '%';
  const wrap = $('accessMeterWrap');
  if (wrap) {
    wrap.setAttribute('aria-valuenow', String(Math.round(s.pct)));
    wrap.hidden = !s.known;
  }
}

// Малює картку доступу в заданий заголовок. Одночасно вона лише одна: картка
// іншого екрана прибирається, щоб у документі не з'явилися однакові ID.
function paintAccessHead(head, opts) {
  // Прострочений токен прибираємо до малювання: інакше картка з'явиться на
  // мить і одразу перебудується відліком, а маршрут викличе сам себе.
  if (state.parentToken && parentSession().status === 'expired') expireParent();
  ['journalHead', 'parentHead'].forEach((id) => {
    const h = $(id);
    if (h && h !== head) { h.innerHTML = ''; h.dataset.mode = ''; }
  });
  const box = $('scanBox');
  if (box) box.innerHTML = '';
  unmountScanner();
  stopAccessTimer();

  if (state.parentToken) {
    head.dataset.mode = 'qr-in';
    head.innerHTML = accessCardHtml(opts);
    $('parentUnlink').onclick = async () => {
      const btn = $('parentUnlink');
      btn.disabled = true;
      await unlinkParent();
      updateJournalDot();
      toast('Доступ відв’язано');
      route();
    };
    $('pPushBtn').onclick = () => (pushOn('parent') ? disablePush() : enablePush('parent'));
    $('accessRenew').onclick = () => {
      const renew = $('accessRenewBox');
      const open = renew.hidden;
      renew.hidden = !open;
      $('accessRenew').textContent = open ? 'Сховати сканер' : 'Оновити доступ';
      if (open) mountScanner(renew, 'Наведіть на новий QR або вставте код — журнал оновиться сам.');
      else unmountScanner();
    };
    startAccessTimer();
  } else {
    head.dataset.mode = 'qr-out';
    head.innerHTML = accessOutHtml(hasRememberedJournal(), opts);
    mountScanner(head.querySelector('.scanner-slot'), '');
  }

  const sw = $('journalGoogleSwitch');
  if (sw) sw.onclick = () => {
    state.journalMode = 'student';
    localStorage.setItem(LS.journalMode, 'student');
    renderJournal();
  };
}

function updateJournalDot() {
  const dot = $('journalDot');
  if (!dot) return;
  const s = parentSession();
  dot.hidden = !(state.parentToken || hasRememberedJournal());
  dot.dataset.state = s.status === 'none' ? 'expired' : s.status;
}

async function renderParent() {
  paintAccessHead($('parentHead'), { studentSwitch: false });
  updateJournalDot();
  await loadParentJournal($('parentList'));
}

// Спільний шлях для «Журналу» і «Журналу для батьків»: той самий запам'ятаний
// доступ, та сама картка, той самий кеш оцінок.
async function loadParentJournal(el) {
  if (state.parentToken) {
    refreshPushState();
    await fetchParentJournal(el);
    return;
  }
  refreshPushState();
  const stale = cachePeek(LS.journalParent);
  if (stale) drawJournal(stale, true, el);
  else clear(el);
}

function scanHint(text) {
  const el = $('scanHint');
  if (el) el.textContent = text;
}

async function startScan() {
  const btn = $('scanBtn');
  const video = $('scanVideo');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    scanHint('Камера доступна лише за https або на localhost. Вставте код у поле нижче.');
    return;
  }
  const seq = ++scan.seq;
  btn.disabled = true;
  btn.textContent = 'Готую камеру…';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '📷 Сканувати камерою';
    scanHint('Камера недоступна (' + ((e && e.name) || 'помилка') + '). Дозвольте доступ у браузері або вставте код у поле нижче.');
    return;
  }
  // Поки питали дозвіл, користувач пішов на іншу вкладку — камеру не вмикаємо.
  if (seq !== scan.seq) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  scan.stream = stream;
  scan.video = video;
  if (!scan.canvas) {
    scan.canvas = document.createElement('canvas');
    scan.ctx = scan.canvas.getContext('2d', { willReadFrequently: true });
  }
  video.srcObject = scan.stream;
  video.classList.add('on');
  await video.play().catch(() => { });
  btn.textContent = '⏹ Припинити';
  btn.disabled = false;
  scanHint('Наведіть на QR — журнал відкриється сам.');
  await startScanLoop(seq);
}

function stopScan() {
  scan.seq++;
  if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
  if (scan.stream) {
    scan.stream.getTracks().forEach((t) => t.stop());
    scan.stream = null;
  }
  if (scan.video) {
    scan.video.srcObject = null;
    scan.video.classList.remove('on');
  }
  const btn = $('scanBtn');
  if (btn) { btn.disabled = false; btn.textContent = '📷 Сканувати камерою'; }
}

// Chrome/Android розпізнає QR сам; iOS Safari — ні, тому для нього тягаємо jsQR.
async function pickDecoder() {
  if (scan.detector) return 'detector';
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        scan.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return 'detector';
      }
    } catch (e) { }
  }
  if (window.jsQR) return 'jsqr';
  try {
    await loadScript(JSQR_CDN);
    return window.jsQR ? 'jsqr' : null;
  } catch (e) {
    return null;
  }
}

async function startScanLoop(seq) {
  const kind = await pickDecoder();
  // Розпізнавач міг вантажитися з CDN кілька секунд — екрана вже може не бути.
  if (seq !== scan.seq) return;
  if (!kind) {
    stopScan();
    scanHint('Не вдалося запустити розпізнавання QR. Вставте код у поле нижче.');
    return;
  }
  scan.timer = setInterval(() => {
    if (scan.busy || !scan.stream) return;
    scan.busy = true;
    readQrFrame(kind)
      .then((text) => {
        if (!text) return;
        stopScan();
        activateParentCode(qrTokenFrom(text));
      })
      .catch(() => { })
      .finally(() => { scan.busy = false; });
  }, 300);
}

async function readQrFrame(kind) {
  const video = scan.video;
  if (!video || video.readyState < 2 || !video.videoWidth) return '';
  if (kind === 'detector') {
    const found = await scan.detector.detect(video);
    return found && found.length ? found[0].rawValue : '';
  }
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (scan.canvas.width !== w) scan.canvas.width = w;
  if (scan.canvas.height !== h) scan.canvas.height = h;
  scan.ctx.drawImage(video, 0, 0, w, h);
  const img = scan.ctx.getImageData(0, 0, w, h);
  const res = window.jsQR(img.data, w, h);
  return res ? res.data : '';
}

// Активувати QR можна і з «Журналу», і з «Журналу для батьків» — оцінки мають
// лишитися на екрані, тому помилка йде в підказку сканера, а не стирає список.
function activeParentList() {
  const jv = $('view-journal');
  return jv && jv.classList.contains('active') ? $('journalList') : $('parentList');
}

// Код нікуди не пишеться: ні в URL, ні в консоль — він і є згода студента.
async function activateParentCode(code) {
  if (activateBusy) return;
  if (!code) { toast('Немає кода', 'err'); return; }
  activateBusy = true;
  const btn = $('codeBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Перевіряємо код…'; }
  scanHint('Перевіряємо код…');
  try {
    const res = await fetch('/api/parent/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.token) {
      const msg = d.details || d.error || 'Не вдалося активувати код';
      scanHint(msg);
      toast(msg, 'err');
      return;
    }
    saveParent(d);
    updateJournalDot();
    toast('Доступ відкрито — журнал запам’ятано');
    route();
  } catch (e) {
    scanHint('Сервер недоступний — спробуйте ще раз');
    toast('Сервер недоступний', 'err');
  } finally {
    activateBusy = false;
    const b = $('codeBtn');
    if (b) { b.disabled = false; b.textContent = 'Відкрити журнал'; }
  }
}

// Форма відповіді /parent/journal у схемі коледжу не описана, тож ім'я беремо
// лише якщо воно справді є — інакше картка лишається «Журнал студента».
function labelFromJournal(data) {
  if (!data || typeof data !== 'object') return '';
  const s = data.student && typeof data.student === 'object' ? data.student : data;
  const name = s.full_name || s.student_name ||
    [s.first_name, s.last_name].filter(Boolean).join(' ');
  const group = s.group || s.group_name || '';
  return [name, group].filter(Boolean).join(' · ');
}

async function fetchParentJournal(el) {
  el = el || $('parentList');
  // Запам'ятаний журнал показуємо одразу, ще до відповіді сервера: людина
  // повернулася в застосунок і має побачити оцінки, а не порожній екран.
  const stale = cachePeek(LS.journalParent);
  if (stale) drawJournal(stale, true, el);
  else if (!navigator.onLine) { empty(el, 'Немає мережі — журнал ще не зберігається на пристрої'); return; }
  if (!navigator.onLine) return;
  if (!stale) loader(el);
  let data = null;
  try {
    const res = await fetch('/api/parent/journal', {
      headers: { authorization: 'Bearer ' + state.parentToken },
    });
    if (res.ok) {
      data = await res.json();
      cacheSet(LS.journalParent, data, TTL.journal);
      state.parentSeenAt = Date.now();
      localStorage.setItem(LS.parentSeen, String(state.parentSeenAt));
      const label = labelFromJournal(data);
      if (label) setParentLabel(label);
    } else if (res.status === 401 || res.status === 403) {
      // Доступ минув — токен прибираємо, але збережені оцінки лишаємо на екрані.
      expireParent();
      updateJournalDot();
      paintAccessHead(el === $('journalList') ? $('journalHead') : $('parentHead'),
        { studentSwitch: el === $('journalList') });
      const kept = cachePeek(LS.journalParent);
      if (kept) drawJournal(kept, true, el);
      else clear(el);
      toast('Доступ завершився — потрібен новий QR', 'err');
      return;
    } else {
      const d = await res.json().catch(() => ({}));
      if (stale) { drawJournal(stale, true, el); toast(d.details || 'Сервер журналу недоступний', 'err'); }
      else empty(el, d.details || 'Не вдалося завантажити журнал');
      return;
    }
  } catch (e) {
    if (stale) { drawJournal(stale, true, el); return; }
    empty(el, 'Сервер недоступний — спробуйте ще раз');
    return;
  }
  if (!data) { empty(el, 'Журнал порожній'); return; }
  drawJournal(data, false, el);
  const name = $('accessName');
  if (name) name.textContent = state.parentLabel || 'Журнал студента';
  const sub = $('accessSub');
  if (sub) sub.textContent = 'Оновлено ' + seenText();
  const avatar = document.querySelector('.access-avatar');
  if (avatar && state.parentLabel) avatar.textContent = '🎓';
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

// Один браузер має одну push-підписку, тож вона завжди належить лише одному
// журналу — студентському чи батьківському. За яким саме — тримаємо в localStorage.
const pushUi = {
  student: { btn: 'pushBtn', hint: 'pushHint' },
  parent: { btn: 'pPushBtn', hint: 'pPushHint' },
};

function pushKind() { return localStorage.getItem(LS.pushKind) || ''; }
// Браузер може видати нову підписку (ротація FCM, очищення даних сайту) — тоді
// запис на сервері стосується старої адреси, і «увімкнено» було б брехнею.
function pushOn(kind) {
  return !!push.subscription && pushKind() === kind &&
    push.subscription.endpoint === localStorage.getItem(LS.pushEndpoint);
}
function setPushKind(kind) {
  if (kind) localStorage.setItem(LS.pushKind, kind);
  else localStorage.removeItem(LS.pushKind);
}

function pushReady(kind) {
  return kind === 'parent' ? !!state.parentToken : !!(state.token && state.refreshToken);
}

function pushCreds(kind) {
  return kind === 'parent'
    ? { parentToken: state.parentToken, parentExpires: state.parentExpiresAt }
    : { refreshToken: state.refreshToken, email: state.email };
}

function pushHint(text, kind) {
  const el = $(pushUi[kind].hint);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function drawPushRow(kind) {
  const btn = $(pushUi[kind].btn);
  if (!btn) return;
  const on = pushOn(kind);
  let label;
  let hint = '';
  if (!push.supported) {
    btn.disabled = true;
    label = '🔕 Сповіщення недоступні';
    hint = 'Браузер не підтримує push. На iPhone додайте сайт на головний екран (Safari → «Поділитися» → «На екран “Домів”») і відкривайте звідти.';
  } else if (isIos() && !isStandalone()) {
    btn.disabled = true;
    label = '🔕 Сповіщення недоступні';
    hint = 'На iPhone сповіщення працюють лише у встановленому застосунку: «Поділитися» → «На екран “Домів”», далі відкривайте застосунок звідти.';
  } else if (Notification.permission === 'denied') {
    btn.disabled = true;
    label = '🔕 Сповіщення заборонені';
    hint = 'Дозвіл на сповіщення можна повернути в налаштуваннях сайту в браузері.';
  } else {
    const ready = pushReady(kind);
    btn.disabled = !ready && !on;
    label = on ? '🔕 Вимкнути сповіщення' : '🔔 Увімкнути сповіщення';
    if (!ready) {
      hint = kind === 'parent'
        ? 'Спершу відскануйте QR — інакше немає чий журнал перевіряти.'
        : 'Спершу увійдіть — інакше немає кого перевіряти в журналі.';
    } else if (push.subscription && !on) {
      hint = 'Сповіщення зараз налаштовані на інший журнал. Увімкнення тут переве їх на цей.';
    } else if (kind !== 'parent') {
      hint = 'Сповіщення приходять, коли в журналі з’явиться нова оцінка. Журнал перевіряється двічі на годину.';
    }
  }
  // У компактній картці кнопка push — іконка: повний текст лишається в title
  // та aria-label, щоб смуга не роздувалася на цілий рядок.
  if (btn.dataset.icon) {
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.textContent = label.slice(0, 2);
    btn.classList.toggle('is-on', on && !btn.disabled);
  } else {
    btn.textContent = label;
  }
  pushHint(hint, kind);
}

async function pushRegistration() {
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
  return Promise.race([ready, timeout]);
}

async function refreshPushState() {
  if (!push.supported) { drawPushRow('student'); drawPushRow('parent'); return; }
  try {
    const reg = await pushRegistration();
    push.subscription = await reg.pushManager.getSubscription();
  } catch (e) {
    push.subscription = null;
  }
  drawPushRow('student');
  drawPushRow('parent');
}

async function sendPushSubscription(sub, kind) {
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign(
      { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } },
      pushCreds(kind)
    )),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.details || data.error || ('HTTP ' + res.status));
  }
}

// Перереєструвати наявну підписку під нові реквізити (новий QR або інший акаунт).
// Якщо не вийшло — знімаємо позначку «увімкнено», щоб інтерфейс не брехав.
async function resyncPush(kind) {
  if (pushKind() !== kind) return;
  try {
    const reg = await pushRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) throw new Error('немає підписки');
    push.subscription = sub;
    await sendPushSubscription(sub, kind);
    localStorage.setItem(LS.pushEndpoint, sub.endpoint);
  } catch (e) {
    push.subscription = null;
    setPushKind('');
    localStorage.removeItem(LS.pushEndpoint);
  }
}

async function enablePush(kind) {
  if (!pushReady(kind)) {
    toast(kind === 'parent' ? 'Спершу відскануйте QR' : 'Спершу увійдіть', 'err');
    return;
  }
  const btn = $(pushUi[kind].btn);
  if (btn) btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('Сповіщення не дозволено', 'err');
      drawPushRow(kind);
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
    await sendPushSubscription(sub, kind);
    setPushKind(kind);
    localStorage.setItem(LS.pushEndpoint, sub.endpoint);
    toast('Сповіщення увімкнено');
  } catch (e) {
    toast('Не вдалося увімкнути сповіщення: ' + (e.message || e), 'err');
  }
  drawPushRow('student');
  drawPushRow('parent');
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
    setPushKind('');
    localStorage.removeItem(LS.pushEndpoint);
    toast('Сповіщення вимкнено');
  } catch (e) {
    toast('Не вдалося вимкнути сповіщення', 'err');
  }
  drawPushRow('student');
  drawPushRow('parent');
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
  el.querySelectorAll('.copy-btn').forEach((b) => b.onclick = async () => {
    const v = b.dataset.copy;
    let ok = false;
    try {
      if (navigator.clipboard) { await navigator.clipboard.writeText(v); ok = true; }
    } catch (e) { }
    // «готово ✓» без перевірки — це брехня: буфер може бути заборонений.
    if (!ok) { toast('Не вдалося скопіювати — видіть текст вручну', 'err'); return; }
    b.textContent = 'готово ✓';
    setTimeout(() => { b.textContent = 'копія'; }, 1200);
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

const VIEWS = ['schedule', 'journal', 'news', 'parent', 'more'];

async function route() {
  const hash = location.hash || '#/schedule';
  const raw = hash.replace('#/', '').split('/')[0];
  // Невідома адреса має показати розклад, а не порожній екран без жодного рендера.
  const name = VIEWS.includes(raw) ? raw : 'schedule';
  // Камера не повинна світитися, коли екрана зі сканером уже немає. Сканер
  // живе і в «Журналі» (поновлення доступу), тож перевіряємо обидва.
  if (name !== 'parent' && name !== 'journal') unmountScanner();
  setView(name);
  updateJournalDot();
  if (name === 'schedule') renderSchedule();
  else if (name === 'journal') renderJournal();
  else if (name === 'news') renderNews();
  else if (name === 'parent') renderParent();
  else if (name === 'more') renderMore();
}

document.querySelectorAll('.seg').forEach((b) => b.onclick = () => {
  state.mode = b.dataset.mode;
  localStorage.setItem(LS.mode, state.mode);
  state.selectedDate = null;
  renderSchedule();
});
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { unmountScanner(); stopAccessTimer(); });
// З фонової вкладки інтервал міг не тікати рівно — відлік рахується від Date.now(),
// тож після повернення одразу показує справжній залишок, а не завмерлий.
document.addEventListener('visibilitychange', () => { if (!document.hidden) tickAccess(); });
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
