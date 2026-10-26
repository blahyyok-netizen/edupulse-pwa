// Тест шифрування Web Push за тестовим вектором RFC 8291 (Appendix A)
// та підпису VAPID за RFC 8292.
// Запуск: node test/webpush.test.mjs

import { encryptPush, importEcdhKeyPair, b64uDecode, b64uEncode, signVapidJwt, generateVapidKeys } from '../webpush.mjs';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name);
  if (!ok) {
    console.log('  очікувалося: ' + expected);
    console.log('  отримано:   ' + actual);
  }
}

// --- RFC 8291, додаток A ---
const plaintext = 'When I grow up, I want to be a watermelon';
const asPublic = b64uDecode('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
const asPrivate = b64uDecode('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
const uaPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const authSecret = 'BTBZMqHH6r4Tts7J_aSIgg';
const salt = 'DGv6ra1nlYgDCS1FRnbzlw';

const expectedHeader = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const expectedCipher = '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ';

const keyPair = await importEcdhKeyPair(asPrivate, asPublic);
const body = await encryptPush({ plaintext, p256dh: uaPublic, auth: authSecret, keyPair, salt });

check('довжина тіла (86 + шифротекст)', String(body.length), String(86 + 58));
check('заголовок (86 байт)', b64uEncode(body.slice(0, 86)), expectedHeader);
check('шифротекст', b64uEncode(body.slice(86)), expectedCipher);

// --- RFC 8292: підпис VAPID (ES256) ---
const keys = await generateVapidKeys();
const jwt = await signVapidJwt({
  privateKeyRaw: b64uDecode(keys.privateKey),
  publicKeyRaw: b64uDecode(keys.publicKey),
  audience: 'https://fcm.googleapis.com',
  subject: 'mailto:admin@sclnau.com.ua',
});

const [h, p, s] = jwt.split('.');
check('JWT має три частини', String(!!(h && p && s)), 'true');
check('заголовок JWT', atob(h.replace(/-/g, '+').replace(/_/g, '/')), '{"typ":"JWT","alg":"ES256"}');

const payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
check('aud у JWT', payload.aud, 'https://fcm.googleapis.com');
check('sub у JWT', payload.sub, 'mailto:admin@sclnau.com.ua');
check('підпис — 64 байти (r||s)', String(b64uDecode(s).length), '64');

// Підпис має перевірятися публічним ключем VAPID.
const pubRaw = b64uDecode(keys.publicKey);
const pubKey = await crypto.subtle.importKey(
  'raw', pubRaw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
);
const ok = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' },
  pubKey,
  b64uDecode(s),
  new TextEncoder().encode(h + '.' + p)
);
check('підпис VAPID перевіряється', String(ok), 'true');

console.log(failed ? '\n' + failed + ' перевірок впало' : '\nУсі перевірки пройдено');
process.exit(failed ? 1 : 0);
