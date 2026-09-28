import { NTFY_BASE } from './config.js';

// JSON publish API: unlike header-based publishing it supports full UTF-8.
export async function publish(topic, { title, message, tags, priority, click }) {
  try {
    const res = await fetch(NTFY_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        title,
        message,
        ...(tags ? { tags: tags.split(',') } : {}),
        ...(priority ? { priority } : {}),
        ...(click ? { click } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    console.error(`[ntfy] failed to publish to ${topic}:`, err.message);
    return false;
  }
}

// "<1 min", "47 min", "1 hr 5 min": the same wording as the app
// (public/time.js), so a push and the dashboard never disagree.
export function formatDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
