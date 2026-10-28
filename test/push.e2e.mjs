// Наскрізна перевірка сповіщень: підроблений push-сервіс + воркер у локальному режимі.
// Запуск: node test/push.e2e.mjs
//
// 1. піднімаємо сервер, який приймає push, розшифровує payload і перевіряє підпис VAPID,
// 2. підписуємо тестового «студента» через /api/push/subscribe,
// 3. запускаємо хронологію воркера: спершу без змін, потім з «новою» оцінкою.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { b64uDecode, b64uEncode } from '../webpush.mjs';

const PORT = 8791;
const WORKER_PORT = 8792;
const API_PORT = 8795;
const PERSIST = '.wrangler/test-state';
const VAPID_PUBLIC_KEY = 'BD9WRsrpsAahSZYjE3IOWnJCUpzY0l0jV_-HD6pyAwTz0uZSUnewbMc9N-JvMy3lRBc-TOoW4H-zzxLT2RSAd3o';
const ENDPOINT = 'http://localhost:' + PORT + '/push/test-1';

const FS = '\u001f';
const RS = '\u001e';

let failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failed++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name);
  if (!ok) console.log('  очікувалося: ' + expected + '\n  отримано:   ' + actual);
}

const TE = new TextEncoder();
function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// Розшифровка за RFC 8291 — зі сторони браузера.
async function decryptPush(body, uaPublicRaw, uaPrivateRaw, authSecretRaw) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);

  const uaPrivate = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: b64uEncode(uaPrivateRaw),
    x: b64uEncode(uaPublicRaw.slice(1, 33)),
    y: b64uEncode(uaPublicRaw.slice(33, 65)),
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asPubKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asPubKey }, uaPrivate, 256));

  const keyInfo = concat(TE.encode('WebPush: info'), new Uint8Array([0]), uaPublicRaw, asPublic);
  const prkKey = await hmac(authSecretRaw, shared);
  const ikm = (await hmac(prkKey, concat(keyInfo, new Uint8Array([1])))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(TE.encode('Content-Encoding: aes128gcm'), new Uint8Array([0]), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(TE.encode('Content-Encoding: nonce'), new Uint8Array([0]), new Uint8Array([1])))).slice(0, 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(0), tagLength: 128 }, cekKey, cipher
  ));
  return new TextDecoder().decode(plain).replace(/[\u0000\u0002]+$/, '');
}

// --- «браузер»: пара ECDH підписника + секрет автентифікації ---
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
const uaPrivateRaw = b64uDecode((await crypto.subtle.exportKey('jwk', ua.privateKey)).d);
const authSecretRaw = crypto.getRandomValues(new Uint8Array(16));
const authSecret = b64uEncode(authSecretRaw);

const received = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201);
    res.end();
  });
});
await new Promise((r) => server.listen(PORT, r));

// --- «кабінет коледжу» і Firebase: mock замість справжніх серверів ---
// Кабінет коледжу (tt-api) живий і лежить рідко, а Firebase — сторонній сервіс,
// тож тест не має від них залежати: інакше падає не код, а доступність чужих серверів.
const api = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/v1/accounts:refresh') {
    json(200, { id_token: 'test-id-token', refresh_token: 'test-refresh', expires_in: 3600 });
    return;
  }
  if (url.pathname === '/admin/auth/config') {
    json(200, { google_client_id: 'test.apps.googleusercontent.com', workspace_domain: 'sclnau.com.ua' });
    return;
  }
  if (url.pathname === '/journal/me') {
    if (!(req.headers.authorization || '').startsWith('Bearer ')) {
      json(401, { detail: 'Missing authorization credentials' });
      return;
    }
    json(200, {
      journal: [
        {
          discipline_id: 3,
          discipline: 'Математика',
          teacher: 'Викладач',
          sessions: [
            {
              date: '2026-10-12',
              pair_number: 1,
              entries: [
                { kind: 'lesson', number: '1', type: 'Комбіноване', topic: 'Тема', homework: '', self_study: '', mark: { value: '9', comment: '' } },
                { kind: 'lesson', number: '2', type: 'Комбіноване', topic: 'Тема', homework: '', self_study: '', mark: null },
              ],
            },
          ],
        },
      ],
    });
    return;
  }
  json(404, { detail: 'Not Found' });
});
await new Promise((r) => api.listen(API_PORT, r));

const cwd = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const worker = spawn(process.execPath, [WRANGLER, 'dev', '--port', String(WORKER_PORT), '--test-scheduled', '--local', '--persist-to', PERSIST,
  '--var', 'TT_API_URL:http://localhost:' + API_PORT,
  '--var', 'FIREBASE_API_URL:http://localhost:' + API_PORT], {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const workerLog = [];
worker.stdout.on('data', (d) => workerLog.push(String(d)));
worker.stderr.on('data', (d) => workerLog.push(String(d)));

const base = 'http://localhost:' + WORKER_PORT;

async function waitForWorker() {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(base + '/api/push/key');
      if (res.ok) return true;
    } catch (e) { }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function kvCmd(args) {
  return spawnSync(process.execPath, [WRANGLER, ...args, '--binding', 'PUSH_SUBS', '--local', '--persist-to', PERSIST], {
    cwd, encoding: 'utf8',
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (!await waitForWorker()) {
    console.log('FAIL воркер не піднявся\n' + workerLog.join(''));
    process.exit(1);
  }
  console.log('OK   воркер піднявся');

  const keyRes = await (await fetch(base + '/api/push/key')).json();
  check('публічний ключ VAPID', keyRes.publicKey, VAPID_PUBLIC_KEY);

  const subRes = await fetch(base + '/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({
      subscription: { endpoint: ENDPOINT, keys: { p256dh: b64uEncode(uaPublicRaw), auth: authSecret } },
      refreshToken: 'test-refresh',
      email: 'student@sclnau.com.ua',
    }),
  });
  check('POST /api/push/subscribe', subRes.status, 200);

  await fetch(base + '/__scheduled?cron=23,53');
  await sleep(4000);
  check('без змін нічого не надсилається', String(received.length), '0');

  // Імітуємо нову оцінку: у знімку, який зберіг сервер, прибираємо оцінку
  // (тобто «до того, як викладач поставив её»). У журналі оцінка вже є —
  // воркер має побачити різницю і надіслати сповіщення.
  const key = 'sub:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ENDPOINT)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  const got = kvCmd(['kv', 'key', 'get', key, '--text']);
  const raw = got.stdout.slice(got.stdout.indexOf('{'), got.stdout.lastIndexOf('}') + 1);
  const record = JSON.parse(raw);
  const markKeys = Object.keys(record.marks || {});
  check('у знімку є оцінки', String(markKeys.length > 0), 'true');

  let expectedMark = '';
  let target = '';
  for (const k of markKeys) {
    const parts = (record.marks[k] || '').split(RS).filter(Boolean);
    const withMark = parts.find((p) => (p.split(FS)[3] || '') !== '');
    if (!withMark) continue;
    expectedMark = withMark.split(FS)[3];
    record.marks[k] = parts.map((p) => (p === withMark ? p.slice(0, p.length - expectedMark.length) : p)).join(RS);
    target = k;
    break;
  }
  check('знайдено оцінку у знімку', String(!!target), 'true');
  kvCmd(['kv', 'key', 'put', key, JSON.stringify(record)]);

  await fetch(base + '/__scheduled?cron=23,53');
  await sleep(5000);
  check('після зміни приходить сповіщення', String(received.length), '1');

  if (received.length) {
    const msg = received[0];
    check('заголовок VAPID', (msg.headers.authorization || '').startsWith('vapid t='), 'true');
    check('crypto-key у запиті', (msg.headers['crypto-key'] || '').startsWith('dh='), 'true');
    check('content-encoding', msg.headers['content-encoding'], 'aes128gcm');

    const payload = JSON.parse(await decryptPush(new Uint8Array(msg.body), uaPublicRaw, uaPrivateRaw, authSecretRaw));
    console.log('     сповіщення: ' + payload.title + ' — ' + payload.body.replace(/\n/g, ' | '));
    check('у сповіщенні є оцінка', String(payload.body.includes(expectedMark)), 'true');
    check('посилання веде в журнал', payload.url, '/#/journal');
  }
} catch (e) {
  console.log('ПОМИЛКА: ' + e.stack);
  failed++;
} finally {
  worker.kill();
  server.close();
  api.close();
  console.log(failed ? '\n' + failed + ' перевірок впало' : '\nУсі перевірки пройдено');
  process.exit(failed ? 1 : 0);
}
