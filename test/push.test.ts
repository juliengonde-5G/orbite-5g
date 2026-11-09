/**
 * Notifications Web Push : vecteur de test RFC 8291, aller-retour de déchiffrement
 * côté navigateur, jeton VAPID, contrôle des abonnements et envoi avec faux transport.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import {
  encryptPayload,
  generateVapidKeys,
  sendPush,
  validSubscription,
  vapidAuthorization,
  type PushSubscriptionJSON,
} from '../src/server/push.ts';

const b64 = (value: string) => Buffer.from(value, 'base64url');

/** RFC 8291, annexe A. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_' +
    'yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const rfcSub: PushSubscriptionJSON = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: RFC.uaPublic, auth: RFC.auth },
};

/** Déchiffrement côté navigateur (RFC 8291 + RFC 8188), indépendant du module testé. */
function decrypt(body: Uint8Array, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Buffer {
  const data = Buffer.from(body);
  const salt = data.subarray(0, 16);
  const rs = data.readUInt32BE(16);
  const idlen = data.readUInt8(20);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const asPublic = data.subarray(21, 21 + idlen);
  const record = data.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 0x02, 'délimiteur de dernier enregistrement attendu');
  return padded.subarray(0, end);
}

test('chiffrement : reproduit exactement le vecteur de la RFC 8291 (annexe A)', () => {
  const body = encryptPayload(Buffer.from(RFC.plaintext), rfcSub, {
    salt: b64(RFC.salt),
    serverKeys: { publicKey: b64(RFC.asPublic), privateKey: b64(RFC.asPrivate) },
  });
  assert.equal(Buffer.from(body).toString('base64url'), RFC.body);
  assert.equal(decrypt(body, b64(RFC.uaPrivate), b64(RFC.uaPublic), b64(RFC.auth)).toString(), RFC.plaintext);
  assert.throws(
    () =>
      encryptPayload(Buffer.from('x'), rfcSub, {
        serverKeys: { publicKey: b64(RFC.uaPublic), privateKey: b64(RFC.asPrivate) },
      }),
    /incohérente/,
  );
});

test('chiffrement : aller-retour avec clés aléatoires, sel et clé éphémère neufs à chaque envoi', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSubscriptionJSON = {
    endpoint: 'https://web.push.apple.com/abc',
    keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  const message = Buffer.from(JSON.stringify({ titre: 'Nouvelle note', élève: 'Léo', note: 17.5 }));
  const first = encryptPayload(message, sub);
  const second = encryptPayload(message, sub);
  assert.notDeepEqual(first.subarray(0, 86), second.subarray(0, 86));
  assert.equal(first.length, 86 + message.length + 1 + 16);
  assert.deepEqual(decrypt(first, ua.getPrivateKey(), ua.getPublicKey(), auth), message);
  assert.deepEqual(decrypt(second, ua.getPrivateKey(), ua.getPublicKey(), auth), message);
  assert.throws(() => encryptPayload(Buffer.alloc(4080), sub), /trop long/);
});

test('VAPID : clés au bon format et JWT ES256 vérifiable (aud, exp, sub)', () => {
  const keys = generateVapidKeys();
  assert.equal(b64(keys.publicKey).length, 65);
  assert.equal(b64(keys.publicKey)[0], 0x04);
  assert.equal(b64(keys.privateKey).length, 32);

  const now = 1_800_000_000_123;
  const header = vapidAuthorization(
    'https://fcm.googleapis.com/fcm/send/xyz?a=1',
    keys,
    'mailto:parents@example.org',
    now,
  );
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(match, header);
  const [, head = '', claims = '', signature = '', k = ''] = match;
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(b64(head).toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(b64(claims).toString()), {
    aud: 'https://fcm.googleapis.com',
    exp: 1_800_000_000 + 12 * 3600,
    sub: 'mailto:parents@example.org',
  });
  const raw = b64(k);
  const publicKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
  assert.equal(b64(signature).length, 64);
  const data = Buffer.from(`${head}.${claims}`);
  assert.ok(verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(signature)));
  assert.ok(!verify('sha256', Buffer.from(`${head}.x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(signature)));
  assert.throws(() => vapidAuthorization('https://fcm.googleapis.com/x', keys, 'parents@example.org'), /mailto/);
});

test('abonnements : seuls https, services push connus et clés de bonne taille sont acceptés', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  const sub = (endpoint: string, k: object = keys) => validSubscription({ endpoint, keys: k });

  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://autopush.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])
    assert.deepEqual(sub(endpoint), { endpoint, keys }, endpoint);

  // Champs superflus retirés, remplissage base64 normalisé.
  assert.deepEqual(
    validSubscription({
      endpoint: 'https://fcm.googleapis.com/x',
      expirationTime: null,
      keys: { ...keys, auth: `${keys.auth}==`, extra: 1 },
    }),
    { endpoint: 'https://fcm.googleapis.com/x', keys },
  );

  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://evil.example.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x',
    'https://notify.windows.com/x',
    'https://push.services.mozilla.com.evil.example/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://192.168.1.10/x',
    `https://fcm.googleapis.com/${'a'.repeat(2048)}`,
    'pas une url',
  ])
    assert.equal(sub(endpoint), null, endpoint);

  const ok = 'https://fcm.googleapis.com/x';
  assert.equal(sub(ok, { ...keys, p256dh: keys.p256dh.slice(0, 40) }), null);
  assert.equal(sub(ok, { ...keys, p256dh: Buffer.alloc(65, 4).toString('base64url') }), null, 'point hors courbe');
  assert.equal(sub(ok, { ...keys, auth: randomBytes(15).toString('base64url') }), null);
  assert.equal(sub(ok, { ...keys, auth: randomBytes(17).toString('base64url') }), null);
  assert.equal(sub(ok, { ...keys, auth: keys.auth.replace(/^./, '+') }), null);
  assert.equal(sub(ok, { p256dh: keys.p256dh }), null);
  for (const value of [null, 'texte', 42, {}, { endpoint: ok }, { endpoint: ok, keys: null }])
    assert.equal(validSubscription(value), null);
});

test('envoi : en-têtes, corps chiffré et résultats sent / gone / failed', async () => {
  const keys = generateVapidKeys();
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSubscriptionJSON = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch =
    (status: number): typeof fetch =>
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status });
    };

  const data = { titre: 'Devoir pour demain', corps: 'Maths : exercice 12 p. 84' };
  assert.equal(await sendPush(sub, data, keys, 'mailto:parents@example.org', fakeFetch(201), 600), 'sent');
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, sub.endpoint);
  assert.equal(call.init.method, 'POST');
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('content-encoding'), 'aes128gcm');
  assert.equal(headers.get('ttl'), '600');
  assert.equal(headers.get('urgency'), 'normal');
  assert.match(
    headers.get('authorization') ?? '',
    new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`),
  );
  assert.ok(call.init.signal instanceof AbortSignal);
  const body = call.init.body as Uint8Array;
  assert.deepEqual(JSON.parse(decrypt(body, ua.getPrivateKey(), ua.getPublicKey(), auth).toString()), data);

  assert.equal(await sendPush(sub, data, keys, 'mailto:a@b.fr', fakeFetch(200)), 'sent');
  assert.equal(new Headers(calls[1]?.init.headers).get('ttl'), String(24 * 3600));
  assert.equal(await sendPush(sub, data, keys, 'mailto:a@b.fr', fakeFetch(410)), 'gone');
  assert.equal(await sendPush(sub, data, keys, 'mailto:a@b.fr', fakeFetch(404)), 'gone');
  assert.equal(await sendPush(sub, data, keys, 'mailto:a@b.fr', fakeFetch(429)), 'failed');
  assert.equal(await sendPush(sub, data, keys, 'mailto:a@b.fr', fakeFetch(500)), 'failed');

  const failing: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(await sendPush(sub, data, keys, 'mailto:a@b.fr', failing), 'failed');
  // Message trop gros, données non sérialisables, sujet invalide : jamais d'exception.
  const before = calls.length;
  assert.equal(await sendPush(sub, { texte: 'x'.repeat(4000) }, keys, 'mailto:a@b.fr', fakeFetch(201)), 'failed');
  assert.equal(await sendPush(sub, undefined, keys, 'mailto:a@b.fr', fakeFetch(201)), 'failed');
  assert.equal(await sendPush(sub, data, keys, 'a@b.fr', fakeFetch(201)), 'failed');
  assert.equal(calls.length, before);
});
