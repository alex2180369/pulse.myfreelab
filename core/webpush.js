'use strict';
// Push-уведомления по стандартам VAPID (RFC 8292) и шифрования сообщений (RFC 8291), без сторонних пакетов.
const crypto = require('node:crypto');

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(s, 'base64url');

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)])), x: pub.x, y: pub.y, d: priv.d };
}

function vapidHeader(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const data = `${header}.${claims}`;
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: keys.x, y: keys.y, d: keys.d }, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(signature)}, k=${keys.publicKey}`;
}

const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

function encrypt(payload, p256dh, auth) {
  const uaPublic = fromB64u(p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const prk = hkdf(fromB64u(auth), shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

// Возвращает код ответа. 404 и 410 значат, что подписка больше не действует.
async function sendPush(sub, payload, keys, subject) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '3600', Urgency: 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      Authorization: vapidHeader(sub.endpoint, keys, subject),
    },
    body: encrypt(JSON.stringify(payload), sub.p256dh, sub.auth),
    signal: AbortSignal.timeout(15000),
  });
  return res.status;
}

// Подписка принимается только от известных служб: иначе сервер можно заставить стучаться куда угодно.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
function allowedEndpoint(endpoint, extraHost) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (extraHost && url.host === extraHost) return true;
  return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some(re => re.test(url.hostname));
}

module.exports = { generateKeys, sendPush, allowedEndpoint, vapidHeader, encrypt };
