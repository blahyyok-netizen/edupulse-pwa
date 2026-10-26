// Збір ростеру груп: імена з PDF «Рейтингу успішності студентів» коледжу
// (або з наказів про зарахування), підтверджені журнальним API.
//
// Імена — з PDF коледжу (єдине публічне джерело, де перелічені студенти).
// Група — з журнального API: запит «group + прізвище + ім'я» повертає 200 лише
// для справжнього студента цієї групи.
//
// Ключова деталь: журнал зберігає історію, тому в одній групі можуть лишатися
// студенти минулих років (вони вже перейшли в іншу групу, але мають там оцінки
// за лютий–червень). Поточна група визначається за датами занять: у поточному
// навчальному році (з 1 вересня)(group) має свіжі заняття.
//
// Сервер журналу коледжу лежить нестабільно (525, обриви), тому скан
// витриває перезапуски: незавершені перевірки зберігаються в кеші й
// продовжуються з того ж місця.
//
// Запуск: node scripts/build-roster.mjs [--pdf file.json] [--out file.json]
//        [--cache file.json] [--only regexp] [--write]

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const PDF_FILE = args.includes('--pdf') ? args[args.indexOf('--pdf') + 1] : '';
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : '';
const CACHE = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : '';
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const WRITE = args.includes('--write');
const CONC = Number(process.env.ROSTER_CONC || 8);
// Скільки разів повторювати запит і яка пауза між спробами. У тестах ставимо
// малі числа, щоб не чекати реальний збій сервера.
const ATTEMPTS = Number(process.env.ROSTER_ATTEMPTS || 4);
const BACKOFF_MAX = Number(process.env.ROSTER_BACKOFF_MS || 30000);
// На скільки всі воркери завмирають, коли сервер не відповів.
const BLOCK_MS = Number(process.env.ROSTER_BLOCK_MS || 45000);

const workerSrc = readFileSync(ROOT + 'worker.js', 'utf8');
const TOKEN = process.env.JOURNAL_API_TOKEN || workerSrc.match(/PUBLIC_JOURNAL_TOKEN = '([^']+)'/)[1];
const HEADERS = { 'X-Auth-Token': TOKEN, 'user-agent': 'okhttp/4.12.0' };
const API = (process.env.JOURNAL_API_URL || 'https://journal-api.sclnau.com.ua/api/v1') + '/journal/';

let reqs = 0;
let failures = 0;
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Пауза між спробами. Коли сервер починає віддавати 525, вона зростає —
// інакше ми просто вб'ємо його сотнями паралельних запитів.
let backoff = 0;
// Коли сервер лежить, стріляти по ньому не варто: усі воркери стають на
// паузу до одного моменту, щоб не перебирати всіх студентів підряд у марний час.
let blockedUntil = 0;

async function pauseIfDown() {
  const wait = blockedUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

// Результат запиту: {hit} — студент знайдено, {none:true} — точно немає
// (404), {unknown:true} — сервер не відповів, треба перевірити ще раз.
async function lookup(group, last, first) {
  const url = `${API}?group=${encodeURIComponent(group)}&last_name=${encodeURIComponent(last)}&first_name=${encodeURIComponent(first)}`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await sleep(backoff);
    await pauseIfDown();
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      reqs++;
      if (res.status === 404) { backoff = 0; return { none: true }; }
      if (!res.ok) {
        failures++;
        backoff = Math.min(BACKOFF_MAX, backoff ? backoff * 2 : 1500);
        continue;
      }
      const d = await res.json();
      backoff = 0;
      if (!d || !d.student_id) return { none: true };
      let maxDate = '';
      for (const j of d.journal || []) {
        for (const s of j.sessions || []) {
          if (s.date && s.date > maxDate) maxDate = s.date;
        }
      }
      return {
        hit: {
          group: d.group,
          id: d.student_id,
          last_name: d.last_name,
          first_name: d.first_name,
          max_date: maxDate,
        },
      };
    } catch (e) {
      reqs++;
      failures++;
      backoff = Math.min(BACKOFF_MAX, backoff ? backoff * 2 : 1500);
    }
  }
  blockedUntil = Date.now() + BLOCK_MS;
  return { unknown: true };
}

async function groups() {
  const url = process.env.TT_GROUPS_URL || 'https://tt.sclnau.com.ua/student/getGroups.php';
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  const list = [];
  for (const f of data.groups || []) for (const g of f.groups || []) list.push(g);
  return list;
}

async function pool(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, 64) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx], idx);
    }
  }));
}

const numOf = (g) => (g.match(/-(\d+)$/) || [])[1] || '';

const raw = PDF_FILE
  ? JSON.parse(readFileSync(PDF_FILE, 'utf8'))
  : await (async () => {
      const { execFileSync } = await import('node:child_process');
      const tmp = process.env.TEMP + '/roster-pdf.json';
      execFileSync(process.execPath, [ROOT + 'scripts/rating-pdf.mjs', '', tmp], { stdio: 'ignore' });
      return JSON.parse(readFileSync(tmp, 'utf8'));
    })();

const allGroups = await groups();
// --only звужує перебір груп (напр. "-1[12]$" — лише першокурсники).
const onlyRe = ONLY ? new RegExp(ONLY) : null;
const candidates = onlyRe ? allGroups.filter((g) => onlyRe.test(g)) : allGroups;
console.log('Груп у коледжі: ' + allGroups.length + ' | кандидатів: ' + candidates.length +
  ' | блоків у PDF: ' + raw.groups.length);

// --- Крок 1: шукаємо кожного студента у групах-кандидатах ---
const tasks = [];
for (const block of raw.groups) {
  const num = String(block.num);
  const near = candidates.filter((g) => num && numOf(g) === num);
  const rest = candidates.filter((g) => !near.includes(g));
  const base = [...near, ...rest];
  for (const s of block.students) {
    // Студент зі списку груп: спершу перевіряємо групи його спеціальності,
    // решта груп — лише якщо там нічого не знайшлося.
    const own = (s.groups || []).filter((g) => candidates.includes(g));
    const order = own.length ? [...own, ...base.filter((g) => !own.includes(g))] : base;
    tasks.push({ block, student: s, order });
  }
}
console.log('Крок 1: перевіряю ' + tasks.length + ' студ. у ' + candidates.length + ' групах');

const cacheKey = (t) => t.block.letter + '-' + t.block.num + '|' + t.student.last_name + '|' + t.student.first_name;

// --- Кеш незавершених перевірок: ключ -> {hits, todo} ---
let cache = new Map();
if (CACHE) {
  try {
    for (const c of JSON.parse(readFileSync(CACHE, 'utf8'))) cache.set(c.key, c);
  } catch (e) { }
}

for (const t of tasks) {
  const saved = cache.get(cacheKey(t));
  if (saved && Array.isArray(saved.hits) && Array.isArray(saved.todo)) {
    t.hits = saved.hits;
    t.todo = saved.todo;
    t.extraTried = !!saved.extraTried;
  } else {
    t.hits = [];
    t.todo = t.order.slice();
    t.extraTried = false;
  }
}
const pending = tasks.filter((t) => t.todo.length || (!t.hits.length && !t.extraTried));
console.log('  з кешу готово: ' + (tasks.length - pending.length) + ' | до перевірки: ' + pending.length);

function saveCache() {
  if (!CACHE) return;
  const rows = tasks.map((t) => ({
    key: cacheKey(t),
    hits: t.hits,
    todo: t.todo,
    extraTried: t.extraTried,
  }));
  writeFileSync(CACHE, JSON.stringify(rows));
}

async function scan() {
  let sinceSave = 0;
  // Кеш пишемо навіть тоді, коли скан ще не завершився: щоб збоєм або
  // перезапуском не втратити вже перевірених студентів.
  const timer = setInterval(saveCache, 20000);
  await pool(pending, CONC, async (t) => {
    while (t.todo.length) {
      const g = t.todo[0];
      const r = await lookup(g, t.student.last_name, t.student.first_name);
      if (r.unknown) return; // сервер не відповів — залишаємо групу в черзі
      t.todo.shift();
      if (r.hit) t.hits.push(r.hit);
    }
    // У PDF іноді зайвий токен (напр. «Пітула | Ярослав | - | Юліан | Юрійович»).
    if (!t.hits.length && !t.extraTried) {
      t.extraTried = true;
      for (const extra of t.student.extra || []) {
        if (!extra || extra === '-') continue;
        for (const g of t.order) {
          const r = await lookup(g, t.student.last_name, extra);
          if (r.unknown) { t.extraTried = false; return; }
          if (r.hit) { t.hits.push(r.hit); break; }
        }
        if (t.hits.length) break;
      }
    }
    if (++sinceSave >= 20) { sinceSave = 0; saveCache(); }
  });
  clearInterval(timer);
  saveCache();
}

if (pending.length) {
  await scan();
} else {
  console.log('  усе з кешу');
}

const unresolved = tasks.filter((t) => t.todo.length).length;
console.log('  знайдено: ' + tasks.filter((t) => t.hits.length).length + ' з ' + tasks.length +
  ' | збігів: ' + tasks.reduce((n, t) => n + t.hits.length, 0) +
  ' | не завершено: ' + unresolved);

// --- Крок 2: де починається поточний навчальний рік ---
// Рік у коледжі починається 1 вересня. Беремо найновішу дату занять у всіх
// знайдених журналах і від неї відштовхуємося: якщо ця дата ще до вересня,
// то це вже завершений навчальний рік, і поточним вважаємо попередній.
let latest = '';
for (const t of tasks) for (const h of t.hits) if (h.max_date > latest) latest = h.max_date;
let cutoff;
if (latest) {
  let year = Number(latest.slice(0, 4));
  if (Number(latest.slice(5, 7)) < 9) year--;
  cutoff = year + '-09-01';
} else {
  // Жодних дат немає: усі знайдені студенти щойно зараховані й ще не мають
  // занять. Тоді орієнтуємось на поточний навчальний рік за сьогодні.
  const now = new Date();
  cutoff = (now.getMonth() + 1 >= 9 ? now.getFullYear() : now.getFullYear() - 1) + '-09-01';
}
console.log('\nКрок 2: остання дата в журналах — ' + (latest || 'немає') +
  ' | поточний навчальний рік з ' + cutoff);

// --- Крок 3: поточна група кожного студента ---
// Група = та, де в журналі студента є заняття поточного року.
// Коли перебір груп обмежено (--only), це групи поточного року, тож студент
// без жодного заняття (тільки-но зарахований) теж поточний.
const isCurrent = (h) => h.max_date >= cutoff || (onlyRe && !h.max_date);
const roster = new Map(); // group -> Map(id -> student)
for (const t of tasks) {
  for (const h of t.hits.filter(isCurrent)) {
    if (!roster.has(h.group)) roster.set(h.group, new Map());
    roster.get(h.group).set(h.id, {
      student_id: h.id,
      last_name: h.last_name,
      first_name: h.first_name,
    });
  }
}

const outGroups = [];
for (const [g, map] of [...roster].sort((a, b) => a[0].localeCompare(b[0]))) {
  const students = [...map.values()].sort((a, b) => a.student_id - b.student_id);
  outGroups.push({ group: g, students });
}
for (const g of outGroups) {
  const ids = g.students.map((s) => s.student_id);
  console.log('  ' + g.group.padEnd(8) + String(g.students.length).padStart(3) + ' студ.  id ' +
    ids[0] + '…' + ids[ids.length - 1]);
}
console.log('\nГруп із ростером: ' + outGroups.length + ' з ' + allGroups.length +
  ' | студентів: ' + outGroups.reduce((n, g) => n + g.students.length, 0) +
  ' | без поточної групи: ' + tasks.filter((t) => !t.hits.some(isCurrent)).length);

const missing = allGroups.filter((g) => !roster.has(g));
if (missing.length) console.log('Без ростеру: ' + missing.join(', '));

console.log('\nЗапитів: ' + reqs + ' | помилок: ' + failures +
  ' | ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с');

const outData = {
  verified_at: new Date().toISOString(),
  academic_year_from: cutoff,
  college_groups: allGroups,
  groups: outGroups,
  unmatched: tasks.filter((t) => !t.hits.some(isCurrent)).length,
  unresolved,
};
if (OUT) {
  writeFileSync(OUT, JSON.stringify(outData, null, 2));
  console.log('\nЗбережено: ' + OUT);
}

if (WRITE && outData.groups.length) {
  const now = Date.now();
  const values = [];
  for (const g of outData.groups) {
    for (const s of g.students) {
      values.push('(' + JSON.stringify(g.group) + ',' + s.student_id + ',' +
        JSON.stringify(s.last_name) + ',' + JSON.stringify(s.first_name) + ",'журнал'," + now + ')');
    }
  }
  // Якщо перевірку завершили повністю, склад групи можна перезаписати: інакше
  // у базі лишилися б студенти, яких ми вже не знайшли. Незавершений скан
  // лише додає рядки — старі не чіпаємо.
  const sql = [];
  if (!unresolved) {
    const touched = new Set([...outData.groups.map((g) => g.group), ...candidates]);
    for (const g of touched) {
      sql.push('DELETE FROM group_students WHERE group_code = ' + JSON.stringify(g) + ';');
    }
  }
  sql.push('INSERT OR REPLACE INTO group_students (group_code, student_id, last_name, first_name, found_at) VALUES\n' + values.join(',\n') + ';');
  // SQL передаємо файлом: у командному рядку такий запит не вміщується.
  const sqlFile = process.env.TEMP + '/roster-write.sql';
  writeFileSync(sqlFile, sql.join('\n'));
  const cmd = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--remote', '--file=' + sqlFile], {
    cwd: ROOT, encoding: 'utf8', shell: true,
  });
  console.log('\nЗапис у D1: ' + (cmd.status === 0 ? 'ок' : 'помилка\n' + cmd.stdout + cmd.stderr));
}
