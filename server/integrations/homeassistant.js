/**
 * Home Assistant: your phone's location (person.* / device_tracker.* and the
 * zones it is in) and push notifications through the companion app's notify
 * service. Uses a long-lived access token (Profile → Security in HA).
 */

function cfgOf(settings) {
  const c = settings.homeAssistant || {};
  if (!c.url || !c.token) throw new Error('Home Assistant is not connected. Add its URL and a long-lived token in Settings.');
  return { base: c.url.replace(/\/+$/, ''), token: c.token, entity: c.locationEntity, notify: c.notifyService };
}

async function ha(settings, path, opts = {}, fetchImpl = fetch) {
  const { base, token } = cfgOf(settings);
  const res = await fetchImpl(`${base}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...opts.headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Home Assistant ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export function connected(settings) {
  const c = settings.homeAssistant || {};
  return Boolean(c.url && c.token);
}

export async function test(settings, fetchImpl = fetch) {
  const r = await ha(settings, '/api/', {}, fetchImpl);
  const loc = settings.homeAssistant.locationEntity ? await location(settings, fetchImpl).catch((e) => ({ error: e.message })) : null;
  return {
    ok: true,
    message: `${r.message || 'Connected'}${loc?.zone ? `. Your phone is in: ${loc.zone}` : loc?.error ? `. Location: ${loc.error}` : ''}`,
  };
}

/** Phone location: zone name (or "not_home"), coordinates when HA has them. */
export async function location(settings, fetchImpl = fetch) {
  const { entity } = cfgOf(settings);
  if (!entity) throw new Error('Choose the person or device tracker that follows your phone in Settings.');
  const s = await ha(settings, `/api/states/${encodeURIComponent(entity)}`, {}, fetchImpl);
  return {
    entity,
    zone: s.state, // "home", "not_home", or a zone name like "Work"
    latitude: s.attributes?.latitude,
    longitude: s.attributes?.longitude,
    accuracy: s.attributes?.gps_accuracy,
    updated: s.last_updated,
  };
}

export async function zones(settings, fetchImpl = fetch) {
  const states = await ha(settings, '/api/states', {}, fetchImpl);
  return states.filter((s) => s.entity_id.startsWith('zone.')).map((s) => ({
    id: s.entity_id, name: s.attributes?.friendly_name || s.entity_id.slice(5), radius: s.attributes?.radius,
  }));
}

export async function trackers(settings, fetchImpl = fetch) {
  const states = await ha(settings, '/api/states', {}, fetchImpl);
  return states.filter((s) => /^(person|device_tracker)\./.test(s.entity_id))
    .map((s) => ({ id: s.entity_id, name: s.attributes?.friendly_name || s.entity_id, state: s.state }));
}

export async function notifyServices(settings, fetchImpl = fetch) {
  const services = await ha(settings, '/api/services', {}, fetchImpl);
  const notify = services.find((d) => d.domain === 'notify');
  return Object.keys(notify?.services || {}).filter((n) => n.startsWith('mobile_app_')).map((n) => `notify.${n}`);
}

/** Push a notification to the phone via the HA companion app. */
export async function notifyPhone(settings, { title, message, url }, fetchImpl = fetch) {
  const { notify } = cfgOf(settings);
  if (!notify) throw new Error('Choose your phone\'s notify service (notify.mobile_app_…) in Settings.');
  const service = notify.replace(/^notify\./, '');
  await ha(settings, `/api/services/notify/${encodeURIComponent(service)}`, {
    method: 'POST',
    body: JSON.stringify({ title, message: message || title, ...(url ? { data: { url, clickAction: url } } : {}) }),
  }, fetchImpl);
  return { sent: true, to: notify };
}

/** Does the zone state match the zone named in a rule? ("home", "Work", "zone.work"…) */
export function inZone(state, zone) {
  const z = String(zone || '').toLowerCase().replace(/^zone\./, '');
  const s = String(state || '').toLowerCase();
  if (z === 'home') return s === 'home';
  if (z === 'away' || z === 'not_home') return s === 'not_home';
  return s === z || s.replace(/\s+/g, '_') === z;
}
