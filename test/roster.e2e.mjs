// Наскрізна перевірка ростеру й електронного журналу групи:
// mock журналу + воркер у локальному режимі.
// Запуск: node test/roster.e2e.mjs
//
// Mock відповідає 200 лише для справжніх пар «Т-11 / Тест Студент» і
// «Т-11 / Другий Учень» — так само, як справжній journal API: для чужої
// групи або неіснуючого студента приходить 404.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const JOURNAL_PORT = 8793;
const WORKER_PORT = 8794;
const TT_PORT = 8792;
const PERSIST = '.wrangler/roster-test-state';

const GROUP = 'Т-11';
const OTHER_GROUP = 'Т-21';
const STUDENT = { lastName: 'Тест', firstName: 'Студент' };
const STUDENT2 = { lastName: 'Другий', firstName: 'Учень' };

let failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failed++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name);
  if (!ok) console.log('  очікувалося: ' + expected + '\n  отримано:   ' + actual);
}

const journalHits = [];
const journal = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  const group = q.get('group');
  const last = q.get('last_name');
  const first = q.get('first_name');
  journalHits.push({ group, last, first });
  const known = (group === GROUP && last === STUDENT.lastName && first === STUDENT.firstName)
    || (group === GROUP && last === STUDENT2.lastName && first === STUDENT2.firstName);
  if (known) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      student_id: last === STUDENT.lastName ? 42 : 43,
      group: GROUP,
      last_name: last,
      first_name: first,
      journal: [
        {
          discipline_id: 7,
          discipline: 'Математика',
          teacher: 'Викладач',
          sessions: [
            {
              date: '2026-10-12',
              pair_number: 1,
              entries: [
                { kind: 'lesson', number: '1', type: 'Комбіноване', topic: 'Тема', homework: '', self_study: '', mark: { value: '9', comment: '' } },
                { kind: 'lesson', number: '2', type: 'Комбіноване', topic: 'Тема', homework: '', self_study: '', mark: { value: '7', comment: '' } },
                // Заняття без оцінки — це не нуль: у середній бал воно не входить.
                { kind: 'lesson', number: '3', type: 'Комбіноване', topic: 'Тема', homework: '', self_study: '', mark: null },
              ],
            },
            {
              date: '2026-10-13',
              pair_number: 2,
              entries: [
                { kind: 'assessment', number: null, type: 'Модульна оцінка', topic: 'Заняття', homework: '', self_study: '', mark: { value: '10', comment: '' } },
                { kind: 'lesson', number: '3', type: 'Комбіноване', topic: 'Тема', homework: '', self_study: '', mark: { value: 'нб', comment: '' } },
              ],
            },
            {
              // Минулий навчальний рік — цю оцінку в підсумок не беремо.
              date: '2026-03-10',
              pair_number: 1,
              entries: [
                { kind: 'lesson', number: '1', type: 'Комбіноване', topic: 'Стара тема', homework: '', self_study: '', mark: { value: '2', comment: '' } },
              ],
            },
          ],
        },
      ],
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ detail: 'Student not found in the specified group' }));
});
await new Promise((r) => journal.listen(JOURNAL_PORT, r));

// Список груп коледжу — щоб тест не ходив у справжній коледж.
const tt = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: true, groups: [{ groups: [GROUP, OTHER_GROUP] }] }));
});
await new Promise((r) => tt.listen(TT_PORT, r));

const cwd = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';

// Тест має починатися з порожньої бази — інакше ростер залишиться від минулого запуску.
rmSync(new URL('../' + PERSIST, import.meta.url), { recursive: true, force: true });

const worker = spawn(process.execPath, [
  WRANGLER, 'dev', '--port', String(WORKER_PORT), '--local', '--persist-to', PERSIST,
  '--var', 'JOURNAL_API_URL:http://localhost:' + JOURNAL_PORT + '/api/v1',
  '--var', 'TT_API_URL:http://localhost:' + TT_PORT,
], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
const workerLog = [];
worker.stdout.on('data', (d) => workerLog.push(String(d)));
worker.stderr.on('data', (d) => workerLog.push(String(d)));

const base = 'http://localhost:' + WORKER_PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWorker() {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(base + '/api/groups');
      if (res.status) return true;
    } catch (e) { }
    await sleep(1000);
  }
  return false;
}

function api(method, path, body) {
  return fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

try {
  if (!await waitForWorker()) {
    console.log('FAIL воркер не піднявся\n' + workerLog.join(''));
    process.exit(1);
  }
  console.log('OK   воркер піднявся');

  const mig = spawnSync(process.execPath, [
    WRANGLER, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', PERSIST,
  ], { cwd, encoding: 'utf8' });
  if (mig.status !== 0) {
    console.log('FAIL міграція не застосувалась\n' + mig.stdout + mig.stderr);
    process.exit(1);
  }
  console.log('OK   міграція застосована');

  // --- портал групи більше не існує ---
  const old = await api('GET', '/api/groups/' + encodeURIComponent(GROUP));
  check('старий портал групи недоступний', old.status, 404);
  // POST /api/groups лишився проксі до списку груп коледжу — токена адміна він не видає.
  const oldPost = await api('POST', '/api/groups', { code: GROUP });
  const oldPostBody = await oldPost.json();
  check('створення групи недоступне', String(!!oldPostBody.token), 'false');

  // --- ростер порожній: список груп коледжу вже видно, але складів ще немає ---
  const emptyRoster = await api('GET', '/api/roster');
  const emptyBody = await emptyRoster.json();
  check('GET /api/roster', emptyRoster.status, 200);
  check('у списку всі групи коледжу', String((emptyBody.groups || []).length), '2');
  check('складів ще немає', String((emptyBody.groups || []).every((g) => !g.count)), 'true');

  // --- наповнюємо ростер, як це робить scripts/build-roster.mjs ---
  const seed = spawnSync(process.execPath, [
    WRANGLER, 'd1', 'execute', 'DB', '--local', '--persist-to', PERSIST, '--command',
    "INSERT OR REPLACE INTO group_students (group_code, student_id, last_name, first_name, found_at) VALUES" +
    "('" + GROUP + "', 42, '" + STUDENT.lastName + "', '" + STUDENT.firstName + "', 1)," +
    "('" + GROUP + "', 43, '" + STUDENT2.lastName + "', '" + STUDENT2.firstName + "', 1)",
  ], { cwd, encoding: 'utf8' });
  if (seed.status !== 0) {
    console.log('FAIL наповнення ростеру\n' + seed.stdout + seed.stderr);
    process.exit(1);
  }
  console.log('OK   ростер наповнено');

  // --- список груп ---
  const list = await api('GET', '/api/roster');
  const listBody = await list.json();
  check('у списку всі групи коледжу', String((listBody.groups || []).length), '2');
  const filled = (listBody.groups || []).find((g) => g.group_code === GROUP);
  const empty = (listBody.groups || []).find((g) => g.group_code === OTHER_GROUP);
  check('код групи', filled.group_code, GROUP);
  check('кількість студентів', String(filled.count), '2');
  check('група без складу — нуль', String(empty.count), '0');

  // --- склад групи ---
  const roster = await api('GET', '/api/roster/' + encodeURIComponent(GROUP));
  const rosterBody = await roster.json();
  check('GET /api/roster/:code', roster.status, 200);
  check('у складі двоє студентів', String((rosterBody.students || []).length), '2');
  // Склад відсортовано за прізвищем.
  check('прізвище першого', rosterBody.students[0].last_name, STUDENT2.lastName);
  check('ім\'я першого', rosterBody.students[0].first_name, STUDENT2.firstName);
  check('прізвище другого', rosterBody.students[1].last_name, STUDENT.lastName);

  // --- журнал групи ---
  const gj = await api('GET', '/api/roster/' + encodeURIComponent(GROUP) + '/journal');
  const gjBody = await gj.json();
  check('GET /api/roster/:code/journal', gj.status, 200);
  check('у журналі двоє студентів', String((gjBody.students || []).length), '2');
  check('предмет у журналі', String((gjBody.subjects || []).length), '1');
  check('назва предмета', gjBody.subjects[0].name, 'Математика');

  const first = gjBody.students.find((s) => s.last_name === STUDENT.lastName);
  // 9, 7 і 10 — середнє 8.67; «нб» не враховується, оцінка за минулий рік — теж.
  check('середній бал студента', String(first.average), '8.67');
  check('кількість оцінок', String(first.count), '3');
  check('оцінки за минулий рік не враховано', String(first.average), '8.67');
  check('заняття без оцінки не враховано', String(first.count), '3');
  check('середній за предметом', String(gjBody.discipline_average['7']), '8.67');
  check('середній бал групи', String(gjBody.group_average), '8.67');
  check('поточний навчальний рік', String(gjBody.academic_year_from), '2026-09-01');

  // --- кеш: другий запит не має знову питати журнал ---
  const before = journalHits.length;
  const again = await api('GET', '/api/roster/' + encodeURIComponent(GROUP) + '/journal');
  const againBody = await again.json();
  check('повторний запит журналу', again.status, 200);
  check('кешовано — без нових запитів', String(journalHits.length === before), 'true');
  check('кеш позначає прапорець', String(!!againBody.cached), 'true');

  // --- журнал недоступний: сервер не відповів жодного запиту ---
  const brokenSeed = spawnSync(process.execPath, [
    WRANGLER, 'd1', 'execute', 'DB', '--local', '--persist-to', PERSIST, '--command',
    "INSERT OR REPLACE INTO group_students (group_code, student_id, last_name, first_name, found_at) VALUES" +
    "('Т-99', 99, 'Невідомий', 'Студент', 1)",
  ], { cwd, encoding: 'utf8' });
  if (brokenSeed.status !== 0) {
    console.log('FAIL наповнення ростеру для недоступного журналу\n' + brokenSeed.stdout + brokenSeed.stderr);
    process.exit(1);
  }
  const brokenHits = journalHits.length;
  const broken = await api('GET', '/api/roster/' + encodeURIComponent('Т-99') + '/journal');
  const brokenBody = await broken.json();
  check('недоступний журнал — відповідь 200', broken.status, 200);
  check('журнал порожній', String((brokenBody.students || []).length), '0');
  check('позначено помилку журналу', String(!!brokenBody.journal_error), 'true');
  check('рахунок невдалих запитів', String(brokenBody.failed_students), '1');
  const brokenAgain = await api('GET', '/api/roster/' + encodeURIComponent('Т-99') + '/journal');
  check('помилку не кешовано — журнал питається знову',
    String(journalHits.length > brokenHits), 'true');
  check('кеш позначає прапорець', String(!!(await brokenAgain.json()).cached), 'false');

  // --- невідома група ---
  const unknown = await api('GET', '/api/roster/НЕМАЄТАК');
  const unknownBody = await unknown.json();
  check('невідома група — порожній склад', unknown.status, 200);
  check('склад порожній', String((unknownBody.students || []).length), '0');

  check('mock журналу справді використовувався',
    String(journalHits.some((h) => h.group === GROUP)), 'true');
} catch (e) {
  console.log('ПОМИЛКА: ' + e.stack);
  failed++;
} finally {
  worker.kill();
  journal.close();
  tt.close();
  console.log(failed ? '\n' + failed + ' перевірок впало' : '\nУсі перевірки пройдено');
  process.exit(failed ? 1 : 0);
}
