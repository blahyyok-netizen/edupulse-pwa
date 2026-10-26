// Наскрізна перевірка порталу групи: mock журналу + воркер у локальному режимі.
// Запуск: node test/groups.e2e.mjs
//
// Mock відповідає 200 лише для однієї пари «Т-11 / Тест Студент» — так само,
// як справжній journal API: для чужої групи або неіснуючого студента приходить 404.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const JOURNAL_PORT = 8793;
const WORKER_PORT = 8794;
const PERSIST = '.wrangler/groups-test-state';

const GROUP = 'Т-11';
const STUDENT = { lastName: 'Тест', firstName: 'Студент' };
const STUDENT2 = { lastName: 'Другий', firstName: 'Учень' };
const PASSWORD = 'test1234';

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
  if ((group === GROUP && last === STUDENT.lastName && first === STUDENT.firstName)
    || (group === GROUP && last === STUDENT2.lastName && first === STUDENT2.firstName)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      student_id: 42, group: GROUP, last_name: last, first_name: first, journal: [],
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ detail: 'Student not found in the specified group' }));
});
await new Promise((r) => journal.listen(JOURNAL_PORT, r));

const cwd = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';

// Тест має починатися з порожньої бази — інакше група з минулого запуску вже існує.
rmSync(new URL('../' + PERSIST, import.meta.url), { recursive: true, force: true });

// AUTH_SECRET: беремо з .dev.vars, якщо файл є, інакше — тестове значення.
let authSecret = 'groups-test-secret';
try {
  const vars = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const txt = fs.readFileSync('.dev.vars', 'utf8');
    const m = txt.match(/^AUTH_SECRET\\s*=\\s*(.+)$/m);
    process.stdout.write(m ? m[1].trim() : '');
  `], { cwd, encoding: 'utf8' });
  if (vars.stdout.trim()) authSecret = vars.stdout.trim();
} catch (e) { }

const worker = spawn(process.execPath, [
  WRANGLER, 'dev', '--port', String(WORKER_PORT), '--local', '--persist-to', PERSIST,
  '--var', 'AUTH_SECRET:' + authSecret,
  '--var', 'JOURNAL_API_URL:http://localhost:' + JOURNAL_PORT + '/api/v1',
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

function api(method, path, body, token, origin) {
  const headers = { 'content-type': 'application/json' };
  if (origin !== null) headers.origin = origin === undefined ? base : origin;
  if (token) headers.authorization = 'Bearer ' + token;
  return fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

try {
  if (!await waitForWorker()) {
    console.log('FAIL воркер не піднявся\n' + workerLog.join(''));
    process.exit(1);
  }
  console.log('OK   воркер піднявся');

  // Міграція D1 у тестову базу.
  const mig = spawnSync(process.execPath, [
    WRANGLER, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', PERSIST,
  ], { cwd, encoding: 'utf8' });
  if (mig.status !== 0) {
    console.log('FAIL міграція не застосувалась\n' + mig.stdout + mig.stderr);
    process.exit(1);
  }
  console.log('OK   міграція застосована');

  // --- створення групи ---
  const create = await api('POST', '/api/groups', {
    code: GROUP, name: 'Тестова група', password: PASSWORD, ...STUDENT,
  });
  const createBody = await create.json();
  check('POST /api/groups', create.status, 200);
  check('у відповіді є токен адміна', String(!!createBody.token), 'true');

  const dup = await api('POST', '/api/groups', {
    code: GROUP, name: 'Дубль', password: PASSWORD, ...STUDENT,
  });
  check('повторне створення групи', dup.status, 409);

  const badCode = await api('POST', '/api/groups', {
    code: '$$$', name: 'x', password: PASSWORD, ...STUDENT,
  });
  check('некоректний код групи', badCode.status, 400);

  const shortPass = await api('POST', '/api/groups', {
    code: 'Т-12', name: 'x', password: 'ab', ...STUDENT,
  });
  check('короткий пароль адміна', shortPass.status, 400);

  const notStudent = await api('POST', '/api/groups', {
    code: 'Т-13', name: 'x', password: PASSWORD, lastName: 'Хтось', firstName: 'Незнайомець',
  });
  check('створення групи не студентом', notStudent.status, 404);

  const badOrigin = await api('POST', '/api/groups', {
    code: 'Т-14', name: 'x', password: PASSWORD, ...STUDENT,
  }, undefined, 'https://evil.example');
  check('запит з чужим origin', badOrigin.status, 403);

  // --- читання групи ---
  const view = await api('GET', '/api/groups/' + encodeURIComponent(GROUP));
  const viewBody = await view.json();
  check('GET /api/groups/:code', view.status, 200);
  check('у групі один учасник', String(viewBody.members.length), '1');
  check('творець — адмін', viewBody.members[0].role, 'admin');

  const missing = await api('GET', '/api/groups/НЕІСНУЄ');
  check('GET неіснуючої групи', missing.status, 404);

  // --- самозапис ---
  const joinFake = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/join', {
    lastName: 'Хтось', firstName: 'Незнайомець',
  });
  check('самозапис чужого студента', joinFake.status, 404);

  const join = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/join', STUDENT2);
  const joinBody = await join.json();
  check('самозапис студента групи', join.status, 200);
  check('у списку двоє', String(joinBody.members.length), '2');

  const joinAgain = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/join', STUDENT2);
  const joinAgainBody = await joinAgain.json();
  check('повторний самозапис не дублює', String(joinAgainBody.members.length), '2');

  // --- вхід адміна ---
  const wrongPass = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/admin/login', {
    password: 'неправильний',
  });
  check('вхід з невірним паролем', wrongPass.status, 401);

  const login = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/admin/login', {
    password: PASSWORD,
  });
  const loginBody = await login.json();
  check('вхід адміна', login.status, 200);
  check('у відповіді є токен', String(!!loginBody.token), 'true');
  const token = loginBody.token;

  // --- об'явлення ---
  const noToken = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/admin/announcements', {
    body: 'Хтось намагався',
  });
  check('об\'явлення без прав', noToken.status, 403);

  const empty = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/admin/announcements', {
    body: '   ',
  }, token);
  check('порожнє об\'явлення', empty.status, 400);

  const post = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/admin/announcements', {
    body: 'Здайте ДЗ до п\'ятниці',
  }, token);
  const postBody = await post.json();
  check('публікація об\'явлення', post.status, 200);
  check('без підписників push не надіслано', String(postBody.pushed), '0');
  check('об\'явлення в стрічці', String(postBody.announcements.length), '1');

  // --- керування списком ---
  const memberId = viewBody.members[0].id;
  const addFake = await api('POST', '/api/groups/' + encodeURIComponent(GROUP) + '/admin/members', {
    lastName: 'Хтось', firstName: 'Незнайомець',
  }, token);
  check('додавання чужого студента', addFake.status, 404);

  const delNoToken = await api('DELETE', '/api/groups/' + encodeURIComponent(GROUP) + '/admin/members/' + memberId);
  check('видалення без прав', delNoToken.status, 403);

  const del = await api('DELETE', '/api/groups/' + encodeURIComponent(GROUP) + '/admin/members/' + memberId, undefined, token);
  const delBody = await del.json();
  check('видалення учасника', del.status, 200);
  check('у списку залишився один', String(delBody.members.length), '1');

  // --- mock журналу справді використовувався ---
  check('журнал питався про групу Т-11', String(journalHits.some((h) => h.group === GROUP)), 'true');
  check('перевірка чужої групи теж дійшла до журналу',
    String(journalHits.some((h) => h.group === 'Т-13')), 'true');
} catch (e) {
  console.log('ПОМИЛКА: ' + e.stack);
  failed++;
} finally {
  worker.kill();
  journal.close();
  console.log(failed ? '\n' + failed + ' перевірок впало' : '\nУсі перевірки пройдено');
  process.exit(failed ? 1 : 0);
}
