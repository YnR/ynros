// Left nav: chats grouped by project, 3 most recent per group, "Show more".
const PROVIDER_LABEL = { anthropic: 'Claude', claudeCode: 'Claude Code', gemini: 'Gemini' };
const KEY = 'harness-sidebar';
let prefs = { collapsed: {}, expanded: {} };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* ignore */ }
const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function chatLink(c, { currentId, activeRuns }) {
  const a = el('a', `conv-item${currentId === c.id ? ' active' : ''}`);
  a.href = `#/c/${c.id}`;
  const run = activeRuns.get(c.id);
  if (run) {
    a.append(el('span', 'spinner'));
    const subs = run.subagents.filter((s) => s.status === 'running').length;
    a.append(el('span', 'conv-title', c.title || 'New chat'));
    if (subs) {
      const badge = el('span', 'run-badge', `${subs} agent${subs > 1 ? 's' : ''}`);
      badge.title = `${subs} subagent${subs > 1 ? 's' : ''} running`;
      a.append(badge);
    }
  } else {
    a.append(el('span', 'conv-title', c.title || 'New chat'));
  }
  if (c.needsYou) a.append(el('span', 'run-badge', '●'));
  const model = c.model === 'auto' ? 'auto' : c.model;
  a.append(el('small', null, [PROVIDER_LABEL[c.provider], model].filter(Boolean).join(' · ')));
  return a;
}

/**
 * groups: [{ id, name, chats }] where id is a project id or '' for no project.
 * onNew(projectId) starts a chat in that group.
 */
export function renderSidebar(container, { projects, conversations, currentId, activeRuns, onNew }) {
  const byProject = new Map();
  for (const c of conversations) {
    const k = c.projectId && projects.some((p) => p.id === c.projectId) ? c.projectId : '';
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k).push(c);
  }
  const latest = (list) => (list?.[0]?.updatedAt || '');
  const groups = projects.map((p) => ({ id: p.id, name: p.name, title: p.path, chats: byProject.get(p.id) || [] }))
    .sort((a, b) => latest(b.chats).localeCompare(latest(a.chats)) || a.name.localeCompare(b.name));
  groups.push({ id: '', name: 'Misc', title: 'Chats not in a project', chats: byProject.get('') || [] });

  const nodes = groups.map((g) => {
    const key = g.id || '_none';
    const wrap = el('section', `group${prefs.collapsed[key] ? ' collapsed' : ''}`);
    const head = el('div', 'group-head');
    const toggle = el('button', 'group-toggle');
    toggle.type = 'button';
    toggle.title = g.title || '';
    toggle.setAttribute('aria-expanded', String(!prefs.collapsed[key]));
    const running = g.chats.filter((c) => activeRuns.has(c.id)).length;
    toggle.append(el('span', 'chev', '▾'), el('span', 'gname', g.name), el('span', 'group-count', running ? `${running} working` : String(g.chats.length || '')));
    toggle.addEventListener('click', () => {
      prefs.collapsed[key] = !prefs.collapsed[key];
      savePrefs();
      wrap.classList.toggle('collapsed', prefs.collapsed[key]);
      toggle.setAttribute('aria-expanded', String(!prefs.collapsed[key]));
    });
    const add = el('button', 'btn ghost small group-add', '+');
    add.type = 'button';
    add.title = g.id ? `New chat in ${g.name}` : 'New chat';
    add.addEventListener('click', () => onNew(g.id || null));
    head.append(toggle, add);

    const body = el('div', 'group-body');
    const expanded = prefs.expanded[key];
    let shown = expanded ? g.chats : g.chats.slice(0, 3);
    // Keep the open chat visible even when it is older than the top 3.
    const cur = g.chats.find((c) => c.id === currentId);
    if (cur && !shown.includes(cur)) shown = [...shown, cur];
    for (const c of shown) body.append(chatLink(c, { currentId, activeRuns }));
    if (!g.chats.length) body.append(el('div', 'group-empty', 'No chats yet'));
    if (g.chats.length > 3) {
      const more = el('button', 'group-more', expanded ? 'Show less' : `Show ${g.chats.length - 3} more`);
      more.type = 'button';
      more.addEventListener('click', () => {
        prefs.expanded[key] = !expanded;
        savePrefs();
        renderSidebar(container, { projects, conversations, currentId, activeRuns, onNew });
      });
      body.append(more);
    }
    wrap.append(head, body);
    return wrap;
  });
  container.replaceChildren(...nodes);
}

export function initSidebarCollapse() {
  const apply = (v) => document.body.classList.toggle('sidebar-collapsed', v);
  try { apply(localStorage.getItem('harness-sidebar-collapsed') === '1'); } catch { /* ignore */ }
  const set = (v) => { apply(v); try { localStorage.setItem('harness-sidebar-collapsed', v ? '1' : '0'); } catch { /* ignore */ } };
  document.getElementById('collapse-sidebar').addEventListener('click', () => set(true));
  return {
    show() {
      if (window.matchMedia('(max-width: 760px)').matches) document.getElementById('sidebar').classList.toggle('open');
      else set(false);
    },
  };
}
