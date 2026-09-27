const NTFY_BASE = process.env.NTFY_BASE || 'https://ntfy.sh';

// JSON publish API: unlike header-based publishing it supports full UTF-8.
export async function publish(topic, { title, message, tags, priority }) {
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

export function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
