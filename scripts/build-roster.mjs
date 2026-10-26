// Збір ростеру груп: імена з PDF «Рейтингу успішності студентів» коледжу,
// підтверджені журнальним API.
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
// Запуск: node scripts/build-roster.mjs [--pdf file.json] [--out file.json]
//        [--cache file.json] [--write]

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const PDF_FILE = args.includes('--pdf') ? args[args.indexOf('--pdf') + 1] : '';
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : '';
const CACHE = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : '';
const WRITE = args.includes('--write');
const CONC = Number(process.env.ROSTER_CONC || 24);

const workerSrc = readFileSync(ROOT + 'worker.js', 'utf8');
const TOKEN = process.env.JOURNAL_API_TOKEN || workerSrc.match(/PUBLIC_JOURNAL_TOKEN = '([^']+)'/)[1];
const HEADERS = { 'X-Auth-Token': TOKEN, 'user-agent': 'okhttp/4.12.0' };
const API = 'https://journal-api.sclnau.com.ua/api/v1/journal/';

const CYR = 'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ';
const MID_FIX = ["'", '’', 'і', 'ї', 'є', 'ґ'];
const OK = /^[а-яіїєґА-ЯІЇЄҐ'’\- ]+$/;

let reqs = 0;
const t0 = Date.now();

async function lookup(group, last, first) {
  const url = `${API}?group=${encodeURIComponent(group)}&last_name=${encodeURIComponent(last)}&first_name=${encodeURIComponent(first)}`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    reqs++;
    if (res.status !== 200) return null;
    const d = await res.json();
    let maxDate = '';
    for (const j of d.journal || []) {
      for (const s of j.sessions || []) {
        if (s.date && s.date > maxDate) maxDate = s.date;
      }
    }
    return {
      group: d.group,
      id: d.student_id,
      last_name: d.last_name,
      first_name: d.first_name,
      max_date: maxDate,
    };
  } catch (e) {
    reqs++;
    return null;
  }
}

async function groups() {
  const res = await fetch('https://tt.sclnau.com.ua/student/getGroups.php', { headers: HEADERS });
  const data = await res.json();
  const list = [];
  for (const f of data.groups || []) for (const g of f.groups || []) list.push(g);
  return list;
}

// Варіанти виправлення «зіпсаного» символу: на початку слова — будь-яка
// українська велика літера, усередині — апостроф чи «і/ї/є/ґ».
function variants(token) {
  if (OK.test(token)) return [token];
  const out = new Set();
  for (let i = 0; i < token.length; i++) {
    if (OK.test(token[i])) continue;
    const fixes = i === 0 ? [...CYR, ...MID_FIX] : MID_FIX;
    for (const f of fixes) {
      let t = '';
      for (let k = 0; k < token.length; k++) t += k === i ? f : token[k];
      out.add(t);
    }
    if (out.size > 200) break;
  }
  return [...out];
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
console.log('Груп у коледжі: ' + allGroups.length + ' | блоків у PDF: ' + raw.groups.length);

// --- Крок 1: шукаємо кожного студента у всіх групах ---
const tasks = [];
for (const block of raw.groups) {
  const num = String(block.num);
  const near = allGroups.filter((g) => numOf(g) === num);
  const rest = allGroups.filter((g) => !near.includes(g));
  for (const s of block.students) tasks.push({ block, student: s, order: [...near, ...rest] });
}
console.log('Крок 1: шукаю кожного студента у всіх групах (' + tasks.length + ' студ.)');

const cacheKey = (t) => t.block.letter + '-' + t.block.num + '|' + t.student.last_name + '|' + t.student.first_name;

async function scan() {
  await pool(tasks, CONC, async (t) => {
    t.hits = [];
    for (const g of t.order) {
      const hit = await lookup(g, t.student.last_name, t.student.first_name);
      if (hit) t.hits.push(hit);
    }
    // У PDF іноді зайвий токен (напр. «Пітула | Ярослав | - | Юліан | Юрійович»).
    if (!t.hits.length) {
      for (const extra of t.student.extra || []) {
        if (!extra || extra === '-') continue;
        for (const g of t.order) {
          const hit = await lookup(g, t.student.last_name, extra);
          if (hit) { t.hits.push(hit); break; }
        }
        if (t.hits.length) break;
      }
    }
  });
}

let cached = false;
if (CACHE) {
  try {
    const saved = JSON.parse(readFileSync(CACHE, 'utf8'));
    const byKey = new Map(saved.map((c) => [c.key, c.hits]));
    if (saved.length === tasks.length && tasks.every((t) => byKey.has(cacheKey(t)))) {
      for (const t of tasks) t.hits = byKey.get(cacheKey(t));
      cached = true;
      console.log('  збіги взято з кешу ' + CACHE);
    }
  } catch (e) { }
}
if (!cached) {
  await scan();
  if (CACHE) writeFileSync(CACHE, JSON.stringify(tasks.map((t) => ({ key: cacheKey(t), hits: t.hits }))));
}
console.log('  знайдено: ' + tasks.filter((t) => t.hits.length).length + ' з ' + tasks.length +
  ' | збігів: ' + tasks.reduce((n, t) => n + t.hits.length, 0));

// --- Крок 2: де починається поточний навчальний рік ---
// Рік у коледжі починається 1 вересня. Беремо найновішу дату занять у всіх
// знайдених журналах і від неї відштовхуємося: якщо ця дата ще до вересня,
// то це вже завершений навчальний рік, і поточним вважаємо попередній.
let latest = '';
for (const t of tasks) for (const h of t.hits) if (h.max_date > latest) latest = h.max_date;
if (!latest) {
  console.log('У журналах немає жодної дати — не вдалося визначити поточний рік.');
  process.exit(1);
}
let year = Number(latest.slice(0, 4));
if (Number(latest.slice(5, 7)) < 9) year--;
const cutoff = year + '-09-01';
console.log('\nКрок 2: остання дата в журналах — ' + latest +
  ' | поточний навчальний рік з ' + cutoff);

// --- Крок 3: поточна група кожного студента ---
// Група = та, де в журналі студента є заняття поточного року.
const roster = new Map(); // group -> Map(id -> student)
const found = new Map(); // key -> group (для звіту)
let noCurrent = 0;
for (const t of tasks) {
  const current = t.hits.filter((h) => h.max_date >= cutoff);
  if (!current.length) { noCurrent++; continue; }
  for (const h of current) {
    if (!roster.has(h.group)) roster.set(h.group, new Map());
    roster.get(h.group).set(h.id, {
      student_id: h.id,
      last_name: h.last_name,
      first_name: h.first_name,
    });
    const key = cacheKey(t);
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(h.group);
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
  ' | без поточної групи: ' + noCurrent);

const missing = allGroups.filter((g) => !roster.has(g));
if (missing.length) console.log('Без ростеру: ' + missing.join(', '));

console.log('\nЗапитів: ' + reqs + ' за ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с');

const outData = {
  verified_at: new Date().toISOString(),
  academic_year_from: cutoff,
  college_groups: allGroups,
  groups: outGroups,
  unmatched: noCurrent,
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
        JSON.stringify(s.last_name) + ',' + JSON.stringify(s.first_name) + ',' + now + ')');
    }
  }
  const sql = 'INSERT OR REPLACE INTO group_students (group_code, student_id, last_name, first_name, found_at) VALUES\n' + values.join(',\n') + ';';
  // SQL передаємо файлом: у командному рядку такий запит не вміщується.
  const sqlFile = process.env.TEMP + '/roster-write.sql';
  writeFileSync(sqlFile, sql);
  const cmd = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--remote', '--file=' + sqlFile], {
    cwd: ROOT, encoding: 'utf8', shell: true,
  });
  console.log('\nЗапис у D1: ' + (cmd.status === 0 ? 'ок' : 'помилка\n' + cmd.stdout + cmd.stderr));
}
