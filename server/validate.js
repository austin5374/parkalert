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
  if (body.mute !== undefined) {
    if (body.mute === null || body.mute === false) out.mute = null;
    else {
      const until = isPlainObject(body.mute) ? body.mute.until ?? null : undefined;
      if (until !== null && !Number.isFinite(until)) bad('mute must be null or { until: epoch ms | null }');
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
