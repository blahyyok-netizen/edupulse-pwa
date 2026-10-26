// Web Push: шифрування повідомлення (RFC 8291) і підпис VAPID (RFC 8292).
// Тільки WebCrypto — однаковий код працює в Worker і в Node (див. test/webpush.test.mjs).

const TE = new TextEncoder();

export function b64uEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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

// HKDF-Extract(salt, ikm) і HKDF-Expand(prk, info, len) — довжина ≤ 32, тож один блок.
async function hkdfExtract(salt, ikm) { return hmac(salt, ikm); }
async function hkdfExpand(prk, info, len) {
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

async function importEcdhPublic(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

// Приватні ключі EC імпортуємо через JWK: формат 'raw' для приватних ключів підтримують
// не всі руни (Node — ні), а JWK працює і в Worker, і в Node.
function ecJwk(privateRaw, publicRaw) {
  return {
    kty: 'EC',
    crv: 'P-256',
    d: b64uEncode(privateRaw),
    x: b64uEncode(publicRaw.slice(1, 33)),
    y: b64uEncode(publicRaw.slice(33, 65)),
  };
}

// Типова пара ECDH: приватний ключ + 65-байтна публічна точка (0x04 || X || Y).
export async function generateEcdhKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, publicKeyRaw };
}

export async function importEcdhKeyPair(privateRaw, publicRaw) {
  const privateKey = await crypto.subtle.importKey(
    'jwk', ecJwk(privateRaw, publicRaw), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
  );
  return { privateKey, publicKeyRaw: publicRaw };
}

// Шифрує повідомлення за RFC 8291. keyPair — тимчасова пара ECDH застосунка.
export async function encryptPush({ plaintext, p256dh, auth, keyPair, salt, recordSize = 4096 }) {
  const uaPublic = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);
  const asPublic = keyPair.publicKeyRaw;

  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importEcdhPublic(uaPublic) },
    keyPair.privateKey,
    256
  ));

  const saltBytes = salt ? b64uDecode(salt) : crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concat(TE.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const prkKey = await hkdfExtract(authSecret, shared);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  const cekInfo = concat(TE.encode('Content-Encoding: aes128gcm'), new Uint8Array([0]));
  const prk = await hkdfExtract(saltBytes, ikm);
  const cek = await hkdfExpand(prk, cekInfo, 16);
  const nonceInfo = concat(TE.encode('Content-Encoding: nonce'), new Uint8Array([0]));
  const nonce = await hkdfExpand(prk, nonceInfo, 12);

  const data = TE.encode(plaintext);
  // RFC 8188: після тексту йде роздільник 0x02; нульове доповнення не обов'язкове.
  const padded = concat(data, new Uint8Array([2]));

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(0), tagLength: 128 },
    cekKey,
    padded
  ));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, recordSize, false);
  const header = concat(saltBytes, rs, new Uint8Array([asPublic.length]), asPublic);
  return concat(header, cipher);
}

// JWT ES256 за RFC 8292. Підпис — «raw» (r || s), саме такого формату очікує VAPID.
export async function signVapidJwt({ privateKeyRaw, publicKeyRaw, audience, subject, expiresIn = 12 * 3600 }) {
  const key = await crypto.subtle.importKey(
    'jwk', ecJwk(privateKeyRaw, publicKeyRaw), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const header = b64uEncode(TE.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64uEncode(TE.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + expiresIn,
    sub: subject,
  })));
  const signingInput = header + '.' + payload;
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, TE.encode(signingInput)
  ));
  return signingInput + '.' + b64uEncode(sig);
}

// Пара VAPID: приватний ключ (base64url) у секрет, публічний (base64url) — у клієнта.
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const publicKey = b64uEncode(concat(
    new Uint8Array([0x04]),
    b64uDecode(pub.x),
    b64uDecode(pub.y)
  ));
  return { publicKey, privateKey: priv.d };
}
