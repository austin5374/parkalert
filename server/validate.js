// Request validation. Pure, so the rules can be tested without HTTP.

// A park has a few dozen rides; these are generous ceilings that keep one
// request from bloating trips.json.
const MAX_IDS = 500;
const MAX_ID_LENGTH = 100;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => {
  throw new HttpError(400, message);
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;

export function requireObject(body) {
  if (!isPlainObject(body)) bad('expected a JSON object');
  return body;
}

export function requireRideId(id) {
  if (!isId(id)) bad('bad ride id');
  return id;
}

// PUT /api/trips/:code/wait-alerts/:rideId: { max: whole minutes }.
export function parseWaitAlert(body, min, max) {
  requireObject(body);
  if (!Number.isInteger(body.max) || body.max < min || body.max > max) bad(`max must be whole minutes from ${min} to ${max}`);
  // device: keep the alert to one phone ("Just me"); absent, it goes to the trip.
  if (body.device != null && (typeof body.device !== 'string' || !body.device || body.device.length > 200)) bad('device must be a device id');
  return { max: body.max, device: body.device ?? null };
}

// PATCH /api/trips/:code. Returns only the recognised fields, each checked,
// so a bad field rejects the whole request before anything changes.
//   parkId: a known park id
//   watched: null (every ride) or an array of ride ids
//   mute: null, or { until: epoch ms | null } (null = until resumed)
//   rideMutes: { [rideId]: true }
export function parseTripPatch(body, isPark) {
  requireObject(body);
  const out = {};
  if (body.parkId !== undefined) {
    if (typeof body.parkId !== 'string' || !isPark(body.parkId)) bad('unknown parkId');
    out.parkId = body.parkId;
  }
  if (body.watched !== undefined) {
    if (body.watched !== null) {
      if (!Array.isArray(body.watched) || body.watched.length > MAX_IDS || !body.watched.every(isId)) {
        bad('watched must be null or a list of ride ids');
      }
      out.watched = [...new Set(body.watched)];
    } else out.watched = null;
  }
  if (body.ntfy !== undefined) {
    if (typeof body.ntfy !== 'boolean') bad('ntfy must be true or false');
    out.ntfy = body.ntfy;
  }
  if (body.crowdAlerts !== undefined) {
    if (typeof body.crowdAlerts !== 'boolean') bad('crowdAlerts must be true or false');
    out.crowdAlerts = body.crowdAlerts;
  }
  if (body.ntfyWorking !== undefined) {
    if (typeof body.ntfyWorking !== 'boolean') bad('ntfyWorking must be true or false');
    out.ntfyWorking = body.ntfyWorking;
  }
  if (body.mute !== undefined) {
    if (body.mute === null || body.mute === false) out.mute = null;
    else {
      const until = isPlainObject(body.mute) ? body.mute.until ?? null : undefined;
      if (until !== null && !Number.isFinite(until)) bad('mute must be null or { until: epoch ms | null }');
      if (until !== null && !muteTimeOk(until)) bad('mute.until must be a time within the next year');
      out.mute = { until };
    }
  }
  if (body.rideMutes !== undefined) {
    const rm = body.rideMutes ?? {};
    const keys = isPlainObject(rm) ? Object.keys(rm) : null;
    if (!keys || keys.length > MAX_IDS || !keys.every(isId) || !Object.values(rm).every((v) => typeof v === 'boolean')) {
      bad('rideMutes must map ride ids to true or false');
    }
    out.rideMutes = Object.fromEntries(keys.filter((k) => rm[k]).map((k) => [k, true]));
  }
  return out;
}

// POST /api/trips/:code/devices: a browser push subscription, as
// PushSubscription.toJSON() gives it. The endpoint must be a known push
// service (see webpush.js); the keys must be the sizes P-256 and the spec use.
export function parseSubscription(body, isPushEndpoint) {
  requireObject(body);
  const sub = body.subscription;
  if (!isPlainObject(sub) || typeof sub.endpoint !== 'string' || !isPushEndpoint(sub.endpoint)) bad('bad push subscription');
  const { p256dh, auth } = isPlainObject(sub.keys) ? sub.keys : {};
  const b64 = /^[A-Za-z0-9_-]+={0,2}$/;
  if (typeof p256dh !== 'string' || !b64.test(p256dh) || Buffer.from(p256dh, 'base64url').length !== 65) bad('bad push key');
  if (typeof auth !== 'string' || !b64.test(auth) || Buffer.from(auth, 'base64url').length !== 16) bad('bad push secret');
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}

// A pause ends at a real time: not before 2020 (a negative or zero time is
// a bug somewhere), and within a year.
const muteTimeOk = (t) => t > Date.UTC(2020, 0, 1) && t < Date.now() + 366 * 24 * 3600_000;

// PATCH /api/trips/:code/devices/:id: { mute: null | { until: epoch ms | null } }.
export function parseDeviceMute(body) {
  requireObject(body);
  if (body.mute === null) return null;
  if (!isPlainObject(body.mute)) bad('mute must be null or { until }');
  const { until } = body.mute;
  if (until !== null && (!Number.isFinite(until) || !muteTimeOk(until))) bad('until must be a time within the next year, or null');
  return { until };
}
