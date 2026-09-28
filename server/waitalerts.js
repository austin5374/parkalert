// Wait-time alerts: "tell me when Seven Dwarfs is 30 minutes or less".
//
// They live on the trip and are shared by everyone on it, like the follow
// list. Each one fires once: on the first poll where the ride is running with
// a posted wait at or under the limit. Each lasts only the park day it was set
// on, so an alert left over from last night never goes off at tomorrow's
// rope drop, when every wait is short.
//
//   trip.waitAlerts: { [rideId]: { max, day, setAt, sentAt?, sentWait? } }
//     max: minutes; day: park-local YYYY-MM-DD it was set on
//     sentAt/sentWait: when it fired, and the wait it fired at

export const WAIT_ALERT_MIN = 5;
export const WAIT_ALERT_MAX = 240;

// Today's alerts only; older ones are dead.
export function currentWaitAlerts(trip, today) {
  return Object.fromEntries(Object.entries(trip.waitAlerts || {}).filter(([, a]) => a.day === today));
}

// Drop alerts from earlier park days. Returns whether anything went.
export function pruneWaitAlerts(trip, today) {
  if (!trip.waitAlerts) return false;
  const kept = currentWaitAlerts(trip, today);
  const changed = Object.keys(kept).length !== Object.keys(trip.waitAlerts).length;
  if (changed) trip.waitAlerts = kept;
  return changed;
}

// Alerts that should go out now: set today, not yet sent, and the ride is
// running with a posted wait at or under the limit. A ride that is down or
// closed has no posted wait, so an alert set on it waits for it to reopen.
export function dueWaitAlerts(trip, rides, today) {
  const due = [];
  for (const [rideId, alert] of Object.entries(currentWaitAlerts(trip, today))) {
    const ride = rides[rideId];
    if (alert.sentAt || ride?.status !== 'OPERATING' || ride.waitTime == null) continue;
    if (ride.waitTime <= alert.max) due.push({ rideId, ride, alert });
  }
  return due;
}

export function waitAlertMessage(ride, alert, parkName) {
  return {
    title: `${ride.name}: ${ride.waitTime} min wait`,
    message: `You asked for ${alert.max} min or less · ${parkName}`,
    tags: 'stopwatch',
    priority: 4,
  };
}
