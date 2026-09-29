// Per-client token buckets. Everything here is unauthenticated by design (a
// trip code is the only credential), and every push leaves from this one
// server, whose IP ntfy.sh rate-limits. One client hammering the test button
// or minting trips could get every trip's alerts throttled, so the calls that
// cost something are metered.
import { TRUST_PROXY } from './config.js';

export const LIMITS = {
  api: { burst: 600, perHour: 36_000 }, // any API call: a flood guard, far above a phone's refresh
  create: { burst: 20, perHour: 20 }, // new trips
  push: { burst: 10, perHour: 30 }, // test and simulated alerts
  miss: { burst: 30, perHour: 60 }, // lookups of trip codes that don't exist
};

export function createLimiter({ burst, perHour }) {
  const rate = perHour / 3600_000; // tokens per ms
  const buckets = new Map(); // key -> { tokens, at }
  const level = (key, now) => {
    const b = buckets.get(key) || { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    buckets.set(key, b);
    return b;
  };
  return {
    // Spend a token. Returns 0 if allowed, else ms until one is available.
    take(key, now = Date.now()) {
      const b = level(key, now);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return 0;
      }
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) if (v.tokens + (now - v.at) * rate >= burst) buckets.delete(k);
      }
      return Math.ceil((1 - b.tokens) / rate);
    },
    // Like take, without spending: ms until a token is available, or 0.
    wait(key, now = Date.now()) {
      const b = level(key, now);
      return b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / rate);
    },
  };
}

// Who is asking. Railway's edge proxy connects on the client's behalf and
// appends the client's address to X-Forwarded-For, so the last entry is the
// one a client cannot forge; without a trusted proxy (see TRUST_PROXY), the
// header is the client's own word and it is the socket's peer. An IPv6
// client is keyed by its /64: one subscriber gets a whole /64 and could
// otherwise step through addresses to dodge every limit.
export function clientKey(req, { trustProxy = TRUST_PROXY } = {}) {
  const xff = trustProxy ? req.headers['x-forwarded-for'] : null;
  const last = xff ? String(xff).split(',').pop().trim() : '';
  return networkKey(last || req.socket.remoteAddress || 'unknown');
}

export function networkKey(addr) {
  const a = addr.replace(/^::ffff:(?=\d+\.)/, ''); // IPv4-mapped
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Trip codes each client has opened successfully. A phone already on a trip
// is never locked out of it by the code-guessing limit, which may have been
// spent by someone else behind the same address (carrier NAT, park Wi-Fi).
export function createKnownCodes(max = 20_000) {
  const known = new Map();
  return {
    has: (who, code) => known.has(`${who}|${code}`),
    add(who, code) {
      const k = `${who}|${code}`;
      known.delete(k);
      known.set(k, true);
      if (known.size > max) known.delete(known.keys().next().value);
    },
  };
}
