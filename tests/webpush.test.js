import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-push-'));
const { encrypt, vapidAuth, vapidKeys, isPushEndpoint } = await import('../server/webpush.js');

// What the phone does with a push: RFC 8291 from the receiving side.
function decrypt(body, uaKeys, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = uaKeys.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaKeys.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return { text: plain.subarray(0, -1).toString(), rs };
}

test('a push decrypts on the phone to exactly what was sent', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const msg = JSON.stringify({ title: 'Space Mountain is down', body: 'Usually back in 10 to 40 min' });
  const { text, rs } = decrypt(encrypt(msg, sub), ua, auth);
  assert.equal(text, msg);
  assert.equal(rs, 4096);
});

test('each push uses a fresh key and salt, so two identical messages differ', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const sub = { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  assert.notDeepEqual(encrypt('same', sub), encrypt('same', sub));
});

test('the VAPID token is a valid ES256 JWT for the push service origin', () => {
  const header = vapidAuth('https://fcm.googleapis.com/fcm/send/abc', Date.parse('2026-09-28T12:00:00Z'));
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapidKeys().publicKey);
  const [h, c, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  const raw = Buffer.from(k, 'base64url');
  const pub = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('the key pair is made once and kept', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'vapid.json'), 'utf8'));
  assert.equal(saved.publicKey, vapidKeys().publicKey);
});

test('only real push services are accepted as endpoints', () => {
  assert.ok(isPushEndpoint('https://web.push.apple.com/QGuQ...'));
  assert.ok(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.equal(isPushEndpoint('https://evil.example.com/push'), false);
  assert.equal(isPushEndpoint('http://fcm.googleapis.com/x'), false);
  assert.equal(isPushEndpoint('not a url'), false);
});

// RFC 8291, Appendix A: fixed sender key and salt, and the exact bytes a
// correct implementation produces. Passing this is interoperability, not
// just agreement with our own decrypt above.
test('encryption matches the worked example in RFC 8291', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const out = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { senderKeys: ecdh, salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url') });
  assert.equal(out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});
