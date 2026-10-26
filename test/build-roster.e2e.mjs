// Перевірка scripts/build-roster.mjs на локальних моках.
//
// Скрипт ходить у журнальний API коледжу, а той лежить нестабільно. Тут піднімаємо
// два моки: список груп (tt) і журнал (журнальний API), і перевіряємо головне:
// студент потрапляє саме в свою групу, незнайоме ім'я не створює рядків,
// а незавершений скан продовжується з кешу.
//
// Запуск: node test/build-roster.e2e.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'roster-'));

let failed = 0;
function check(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failed++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : ' -> ' + got + ' (очікували ' + want + ')'));
}

// --- моки ---
const GROUPS = ['Т-11', 'Т-21', 'Б-11', 'К-12'];
// студент -> група; журнал містить одну сесію поточного року
const STUDENTS = {
  'Т-11|Шепіда|Андрій': { id: 3142, group: 'Т-11', sessions: [{ date: '2026-09-15' }] },
  'Б-11|Коваленко|Олег': { id: 3200, group: 'Б-11', sessions: [{ date: '2026-09-16' }] },
  'К-12|Мельник|Софія': { id: 3301, group: 'К-12', sessions: [{ date: '2026-09-17' }] },
  // минулий навчальний рік: у журналі є старі оцінки, але група не поточна
  'Т-21|Захарченко|Петро': { id: 2140, group: 'Т-21', sessions: [{ date: '2026-04-10' }] },
};

let down = false; // імітуємо «сервер лежить»
let requests = 0;

const tt = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ groups: [{ groups: GROUPS }] }));
});

const journal = http.createServer((req, res) => {
  requests++;
  if (down) { res.statusCode = 525; res.end('error'); return; }
  const q = new URL(req.url, 'http://x').searchParams;
  const key = (q.get('group') || '') + '|' + (q.get('last_name') || '') + '|' + (q.get('first_name') || '');
  const hit = STUDENTS[key];
  if (!hit) { res.statusCode = 404; res.end('{}'); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    student_id: hit.id,
    group: hit.group,
    last_name: key.split('|')[1],
    first_name: key.split('|')[2],
    journal: [{ subject: 'Математика', sessions: hit.sessions }],
  }));
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const ttPort = await listen(tt);
const jPort = await listen(journal);

const PDF = join(DIR, 'pdf.json');
writeFileSync(PDF, JSON.stringify({
  source: 'test',
  groups: [{
    letter: '', num: '',
    students: [
      { last_name: 'Шепіда', first_name: 'Андрій', patronymic: 'Васильович', extra: [] },
      { last_name: 'Коваленко', first_name: 'Олег', patronymic: 'Петрович', extra: [] },
      { last_name: 'Мельник', first_name: 'Софія', patronymic: 'Іванівна', extra: [] },
      { last_name: 'Захарченко', first_name: 'Петро', patronymic: 'Миколайович', extra: [] },
      { last_name: 'Немає', first_name: 'Такого', patronymic: '', extra: [] },
    ],
  }],
}));

const env = {
  ...process.env,
  JOURNAL_API_URL: 'http://127.0.0.1:' + jPort + '/api/v1',
  TT_GROUPS_URL: 'http://127.0.0.1:' + ttPort + '/student/getGroups.php',
  ROSTER_CONC: '4',
  ROSTER_ATTEMPTS: '2',
  ROSTER_BACKOFF_MS: '20',
};

// Скрипт запускаємо асинхронно: spawnSync заблокував би цикл подій батьківського
// процесу, а моки живуть саме в ньому — і сервер не відповів би ніколи.
function run(extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ROOT + 'scripts/build-roster.mjs',
      '--pdf', PDF, '--cache', join(DIR, 'cache.json'), '--out', join(DIR, 'out.json'), ...extra],
      { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

console.log('--- скан успішний ---');
let r = await run();
if (r.status !== 0) { console.log(r.stdout + r.stderr); failed++; }
const out = JSON.parse(readFileSync(join(DIR, 'out.json'), 'utf8'));
const byGroup = Object.fromEntries(out.groups.map((g) => [g.group, g.students.length]));
check('Т-11 — один студент', byGroup['Т-11'], 1);
check('Б-11 — один студент', byGroup['Б-11'], 1);
check('К-12 — один студент', byGroup['К-12'], 1);
check('Т-21 без поточної групи', byGroup['Т-21'], undefined);
check('усього студентів', out.groups.reduce((n, g) => n + g.students.length, 0), 3);
check('поточний навчальний рік', out.academic_year_from, '2026-09-01');
check('невідоме ім\'я не створило групи', out.groups.length, 3);

console.log('\n--- кеш: повторний запуск не робить запитів ---');
const before = requests;
r = await run();
const after = requests;
check('запитів не додалось', after - before, 0);
if (r.status !== 0) { console.log(r.stdout + r.stderr); failed++; }

console.log('\n--- сервер лежить: скан зупиняється і зберігається ---');
// Кеш чистимо, щоб скан почався з нуля — інакше він просто взяв би готове.
rmSync(join(DIR, 'cache.json'), { force: true });
down = true;
r = await run();
const cache = JSON.parse(readFileSync(join(DIR, 'cache.json'), 'utf8'));
check('кеш не порожній', cache.length > 0, true);
check('незавершених позначено', cache.some((c) => c.todo.length > 0), true);
check('жодного студента не вгадано', cache.every((c) => c.hits.length === 0), true);
down = false;

console.log('\n--- після відновлення сервера скан завершується ---');
r = await run();
const out2 = JSON.parse(readFileSync(join(DIR, 'out.json'), 'utf8'));
check('усього студентів після відновлення',
  out2.groups.reduce((n, g) => n + g.students.length, 0), 3);
check('незавершених не лишилось', out2.unresolved, 0);

tt.close();
journal.close();
console.log(failed ? '\n' + failed + ' перевірок впало' : '\nУсі перевірки пройдено');
process.exit(failed ? 1 : 0);
