// Web Push: the app's own notifications, straight to the phone, with no
// second app to install. iPhone supports it for home-screen web apps (iOS
// 16.4 and later); Android and desktop browsers everywhere.
//
// Two standards, done with node's own crypto and no dependencies:
//   RFC 8292 (VAPID): each request is signed with this server's key pair,
//     so push services know who is sending.
//   RFC 8291 (message encryption): the payload is encrypted to the phone's
//     key, so the push service relays it without being able to read it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, APP_URL } from './config.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// The key pair is made once and kept with the trips, on the volume: a new
// key would orphan every phone's subscription. VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY (base64url) override it.
let vapid = null;
export function vapidKeys() {
  if (vapid) return vapid;
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  const file = path.join(DATA_DIR, 'vapid.json');
  if (!pub || !priv) {
    try {
      ({ publicKey: pub, privateKey: priv } = JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      pub = b64u(ecdh.getPublicKey());
      priv = b64u(ecdh.getPrivateKey());
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ publicKey: pub, privateKey: priv }), { mode: 0o600 });
    }
  }
  const raw = unb64u(pub);
  // A private scalar can come out shorter than 32 bytes; JWK wants exactly 32.
  const d = Buffer.alloc(32);
  const dRaw = unb64u(priv);
  dRaw.copy(d, 32 - dRaw.length);
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) },
  });
  vapid = { publicKey: pub, key };
  return vapid;
}

// RFC 8292: a short-lived ES256 token for the push service's origin.
export function vapidAuth(endpoint, now = Date.now()) {
  const { publicKey, key } = vapidKeys();
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: APP_URL || 'mailto:parkalert@example.com',
  }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

// RFC 8291 aes128gcm, one record. The optional sender key and salt exist for
// tests; in use both are fresh for every message.
export function encrypt(payload, { p256dh, auth }, { senderKeys = null, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = senderKeys || crypto.createECDH('prime256v1');
  if (!senderKeys) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the padding delimiter that marks the last (only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// Push services live at a handful of well-known hosts; anything else is
// refused, so a subscription can't make this server POST to arbitrary URLs.
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
export function isPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    // Tests stand up a fake push service on a local origin they name here.
    if (process.env.PUSH_TEST_ORIGIN && url.origin === process.env.PUSH_TEST_ORIGIN) return true;
    return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname)) && endpoint.length <= 1000;
  } catch {
    return false;
  }
}

// Sends one notification. Resolves 'ok', 'gone' (the phone unsubscribed or
// the app was removed; drop the subscription) or 'failed' (try next time).
export async function sendPush(subscription, data, { urgency = 'normal', ttl = 3600 } = {}) {
  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuth(subscription.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body: encrypt(JSON.stringify(data), subscription.keys),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return 'ok';
  } catch (err) {
    console.error(`[push] ${new URL(subscription.endpoint).hostname}:`, err.message);
    return 'failed';
  }
}
