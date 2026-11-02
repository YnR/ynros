// Settings: Home Assistant phone link and automations.
const $ = (s) => document.querySelector(s);
let ctx;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fillList(id, values) {
  $(id).replaceChildren(...values.map((v) => Object.assign(document.createElement('option'), { value: v.id || v, label: v.name || '' })));
}

export async function loadAutomations() {
  const box = $('#auto-list');
  try {
    const list = await ctx.api('/api/automations');
    if (!list.length) { box.replaceChildren(el('p', 'muted small', 'No automations yet.')); return; }
    box.replaceChildren(...list.map((r) => {
      const row = el('div', 'mcp-row');
      const on = el('input');
      on.type = 'checkbox';
      on.checked = r.enabled !== false;
      on.addEventListener('change', () => ctx.api(`/api/automations/${r.id}/enabled`, { method: 'POST', body: { enabled: on.checked } }));
      const info = el('div');
      info.append(el('b', null, r.name), el('span', 'muted', ` ${r.summary}${r.lastFired ? ` · last ran ${new Date(r.lastFired).toLocaleString()}` : ''}`));
      const rm = el('button', 'btn ghost small danger', 'Delete');
      rm.type = 'button';
      rm.addEventListener('click', async () => { await ctx.api(`/api/automations/${r.id}`, { method: 'DELETE' }); loadAutomations(); });
      row.append(on, info, el('span'), el('span'), rm);
      return row;
    }));
  } catch (e) { box.replaceChildren(el('p', 'muted small', e.message)); }
}

export function fillHomeAssistant(settings) {
  const st = $('#ha-token-state');
  st.textContent = settings.homeAssistant?.hasToken ? 'saved' : 'not set';
  st.className = `key-state${settings.homeAssistant?.hasToken ? ' ok' : ''}`;
  $('#settings-form').elements['homeAssistant.token'].value = '';
  loadAutomations();
}

function nextOccurrence(time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d < new Date()) d.setDate(d.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:${pad(m)}`;
}

export function initAutomations(c) {
  ctx = c;
  $('#ha-discover').addEventListener('click', async () => {
    const out = $('#ha-result');
    out.className = 'test-result';
    out.textContent = 'Looking…';
    try {
      await ctx.save(ctx.collect());
      const r = await ctx.api('/api/home-assistant/discover');
      fillList('#ha-trackers', r.trackers);
      fillList('#ha-notify', r.notify);
      fillList('#ha-zones', [{ id: 'home', name: 'Home' }, ...r.zones.map((z) => ({ id: z.name, name: z.id }))]);
      const f = $('#settings-form').elements;
      if (!f['homeAssistant.locationEntity'].value && r.trackers.length) f['homeAssistant.locationEntity'].value = (r.trackers.find((t) => t.id.startsWith('person.')) || r.trackers[0]).id;
      if (!f['homeAssistant.notifyService'].value && r.notify.length) f['homeAssistant.notifyService'].value = r.notify[0];
      out.className = 'test-result ok';
      out.textContent = `Found ${r.trackers.length} trackers, ${r.notify.length} phones, ${r.zones.length} zones. Save to keep them.`;
    } catch (e) { out.className = 'test-result fail'; out.textContent = e.message; }
  });
  $('#ha-test-notify').addEventListener('click', async () => {
    const out = $('[data-result="homeAssistant"]');
    try {
      await ctx.save(ctx.collect());
      await ctx.api('/api/home-assistant/test-notify', { method: 'POST', body: {} });
      out.className = 'test-result ok';
      out.textContent = 'Sent. Check your phone.';
    } catch (e) { out.className = 'test-result fail'; out.textContent = e.message; }
  });
  $('#auto-action').addEventListener('change', () => {
    const prompt = $('#auto-action').value === 'prompt';
    $('#auto-text-label').textContent = prompt ? 'Prompt' : 'Notification text';
    $('#auto-text').placeholder = prompt ? 'Brief me on my day' : 'Buy milk';
  });
  $('#auto-add').addEventListener('click', async () => {
    const out = $('#auto-result');
    const action = $('#auto-action').value;
    const text = $('#auto-text').value.trim();
    const time = $('#auto-time').value;
    const days = $('#auto-days').value;
    const zone = $('#auto-zone').value.trim();
    const trigger = {};
    if (time && days === 'once') trigger.at = nextOccurrence(time);
    else if (time) trigger.schedule = { time, ...(days ? { days: days.split(',').map(Number) } : {}) };
    if (zone) trigger.zone = { zone, event: $('#auto-zone-event').value };
    const body = {
      trigger,
      action: action === 'prompt' ? { type: 'prompt', prompt: text } : { type: 'notify', title: text },
    };
    try {
      await ctx.api('/api/automations', { method: 'POST', body });
      out.className = 'test-result ok';
      out.textContent = 'Added.';
      $('#auto-text').value = '';
      loadAutomations();
    } catch (e) { out.className = 'test-result fail'; out.textContent = e.message; }
  });
}
