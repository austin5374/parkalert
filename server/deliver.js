// Every alert goes out through here: to the trip's ntfy topic (phones set up
// that way) and straight to each phone that turned on the app's own
// notifications. A phone can be paused on its own, which a shared ntfy topic
// can't do; a subscription the push service says is gone is dropped.
import { publish } from './notify.js';
import { sendPush } from './webpush.js';
import { saveTrips } from './store.js';

export const MAX_DEVICES = 20;

export const deviceMuted = (device, now = Date.now()) =>
  !!device.mute && (device.mute.until === null || device.mute.until > now);

// push: { title, message, click, priority, tags, quiet }. tag: notifications
// with the same tag replace each other on the phone, so "back up" replaces
// "is down" instead of stacking. quiet: an update to something already on
// the lock screen, shown without a sound (ntfy's low priority). device: send
// to that phone only (a test).
// urgency: 'high' asks the push service to wake a sleeping phone at once
// (Android holds 'normal' ones while dozing); "is down" needs that as much as
// "back up" does. badge: how many of this trip's rides are down, for the
// Home Screen icon while the app is closed. ntfyOnly: the topic alone (the
// ntfy setup's test).
export async function deliver(trip, push, { tag = null, device = null, ntfyOnly = false, now = Date.now(), badge = null } = {}) {
  const jobs = [];
  if (!device) jobs.push(publish(trip.topic, push.quiet ? { ...push, priority: 2 } : push));
  const targets = ntfyOnly ? [] : (trip.devices || []).filter((d) => (device ? d.id === device : !deviceMuted(d, now)));
  const data = {
    title: push.title, body: push.message, url: push.click || '/', tag,
    ...(push.quiet ? { quiet: true } : {}),
    ...(Number.isInteger(badge) ? { badge } : {}),
  };
  const urgency = push.quiet ? 'normal' : push.urgency || ((push.priority || 3) >= 4 ? 'high' : 'normal');
  let gone = false;
  for (const d of targets) {
    jobs.push(sendPush(d, data, { urgency }).then((result) => {
      if (result === 'gone') {
        trip.devices = trip.devices.filter((x) => x !== d);
        gone = true;
      } else if (result === 'ok') d.lastOk = now;
      return result === 'ok';
    }));
  }
  const results = await Promise.all(jobs);
  if (gone) saveTrips();
  // Who it reached: phones on the app's own notifications, and the trip's
  // ntfy topic (which accepts a message whether or not anyone subscribes).
  const ntfy = device ? false : results[0];
  const devices = (device ? results : results.slice(1)).filter(Boolean).length;
  return { ok: ntfy || devices > 0, ntfy, devices };
}

// Does the ntfy topic count as reaching someone? For a trip with no phones on
// the app's own notifications, ntfy is how it gets alerts. Once it has some,
// only if a phone on ntfy has said a test arrived.
export const ntfyCounts = (trip) => !trip.devices?.length || !!trip.ntfyConfirmedAt;

// Whether a push that went out reached someone who will see it.
export const reachedSomeone = (trip, result) => result.devices > 0 || (result.ntfy && ntfyCounts(trip));

// Whether anyone could receive a push now: an unpaused phone, or ntfy.
export const hasReceiver = (trip, now = Date.now()) =>
  ntfyCounts(trip) || (trip.devices || []).some((d) => !deviceMuted(d, now));
