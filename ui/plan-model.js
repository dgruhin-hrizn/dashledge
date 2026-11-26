// What the AI Plan Monitor shows, computed without the DOM so it can be tested in Node.

export const LOW = 25, CRITICAL = 10;
// A reading older than this is called out even if the collector didn't flag it.
export const OLD_READING = 10 * 60000;

/** Whole percent left, so a changing reading can't shift its neighbours with decimals. */
export function remaining(w) { return Math.max(0, Math.min(100, Math.round(100 - w.used))); }

/** A window as the view reads it. A window past its reset counts as full until the next reading. */
export function windowState(w, now) {
  if (!Number.isFinite(w?.used)) return null;
  const expired = !!w.reset && w.reset <= now;
  const left = expired ? 100 : remaining(w);
  const level = left <= 0 ? 'out' : left <= CRITICAL ? 'critical' : left <= LOW ? 'low' : 'ok';
  return {left, expired, idle: !expired && w.used === 0 && !w.reset, level};
}

/** The tightest window: least left, then the soonest reset. */
export function primaryWindow(windows, now) {
  let best = null, bestState = null;
  for (const w of windows || []) {
    const s = windowState(w, now);
    if (!s) continue;
    const sooner = (w.reset ?? Infinity) < (best?.reset ?? Infinity);
    if (!best || s.left < bestState.left || (s.left === bestState.left && sooner)) { best = w; bestState = s; }
  }
  return best;
}

/**
 * Where usage is heading, from how much of the window has passed. Only for windows whose length the
 * provider reported, and only once a tenth of the window has passed, so early bursts don't alarm.
 * `outAt` is set when the current rate would use the rest before the reset.
 */
export function pace(w, now) {
  if (!w?.minutes || !w.reset || w.reset <= now || !(w.used > 0) || w.used >= 100) return null;
  const span = w.minutes * 60000, start = w.reset - span, spent = now - start;
  if (spent < span * 0.1 || spent >= span) return null;
  const projected = w.used * span / spent;
  const outAt = projected > 100 ? now + (100 - w.used) * spent / w.used : null;
  return {projected: Math.round(projected), elapsed: spent / span, outAt};
}

export function until(ts, now) {
  const mins = Math.max(1, Math.ceil((ts - now) / 60000));
  if (mins < 60) return mins + 'm';
  if (mins < 1440) return Math.floor(mins / 60) + 'h ' + mins % 60 + 'm';
  return Math.floor(mins / 1440) + 'd ' + Math.floor(mins % 1440 / 60) + 'h';
}

export function ago(ts, now) {
  const mins = Math.max(0, Math.floor((now - ts) / 60000));
  return mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago' : mins < 1440 ? Math.floor(mins / 60) + 'h ago' : Math.floor(mins / 1440) + 'd ago';
}

export function paceText(p, reset, now) {
  if (!p) return '';
  if (p.outAt && p.outAt < reset) return 'At this pace, runs out in ' + until(p.outAt, now);
  return 'On pace for ' + Math.min(p.projected, 100) + '% used by reset';
}

/** The line under the dial for a window. */
export function windowCaption(w, now) {
  const s = windowState(w, now);
  if (!s) return '';
  if (s.expired) return 'Reset · updating';
  if (s.idle) return 'Starts with your next request';
  return w.reset ? 'Resets in ' + until(w.reset, now) : '';
}

const titles = {
  signedOut: 'Not signed in', noPlan: 'No subscription', empty: 'No limits reported',
  missing: 'Not installed', limited: 'Checks paused', error: 'Can’t reach provider',
};

/**
 * One account's status for the tile and the settings list.
 * `reading` says whether windows can be shown; `tone` is calm, warn or alert.
 */
export function accountStatus(a, now, {loaded = true, offline = false} = {}) {
  const reading = !!a.at && (a.windows || []).some(w => windowState(w, now));
  if (!loaded && !offline) return {reading: false, tone: 'calm', title: 'Checking…', detail: 'Reading accounts on this Mac'};
  if (offline && !reading) return {reading: false, tone: 'alert', title: 'Monitor stopped', detail: 'Dashledge will reconnect on its own.'};
  if (a.state === 'checking' && !reading) return {reading: false, tone: 'calm', title: 'Checking…', detail: 'Reading this account'};
  if (reading) {
    const old = a.stale || offline || now - a.at > OLD_READING;
    const detail = a.stale ? a.message || '' : offline ? 'Dashledge will reconnect on its own.' : '';
    return {reading, tone: old ? 'warn' : 'calm', title: (old ? 'Last reading ' : 'Updated ') + ago(a.at, now), detail};
  }
  return {reading, tone: ['limited', 'error'].includes(a.state) ? 'warn' : 'alert',
    title: titles[a.state] || 'No reading yet', detail: a.message || ''};
}

/** Accounts a placement shows, in discovery order. */
export function visibleAccounts(all, prefs) {
  if (prefs?.mode === 'account') {
    const id = prefs.pin || all[0]?.id;
    return all.filter(a => a.id === id);
  }
  return all.filter(a => !prefs?.ids || prefs.ids.includes(a.id));
}

/** Small facts worth a glance: a reached limit and banked resets. */
export function badges(a) {
  const out = [];
  if (a.reached) out.push({tone: 'alert', text: 'Limit reached'});
  if (a.resets > 0) out.push({tone: 'calm', text: a.resets === 1 ? '1 reset banked' : a.resets + ' resets banked'});
  return out;
}
