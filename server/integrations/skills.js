import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Agent Skills (SKILL.md folders) for the API providers, read from the same
 * places Claude Code uses: ~/.claude/skills and <working dir>/.claude/skills.
 */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

export function skillDirs(settings) {
  return [path.join(os.homedir(), '.claude', 'skills'),
    settings.claudeCode.workingDirectory && path.join(settings.claudeCode.workingDirectory, '.claude', 'skills')]
    .filter(Boolean);
}

export async function listSkills(settings) {
  const out = new Map();
  for (const dir of skillDirs(settings)) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      try {
        const { meta } = frontmatter(await fs.readFile(file, 'utf8'));
        out.set(meta.name || e.name, { name: meta.name || e.name, description: meta.description || '', file });
      } catch { /* not a skill */ }
    }
  }
  return [...out.values()];
}

export async function loadSkill(settings, name) {
  const skill = (await listSkills(settings)).find((s) => s.name === name);
  if (!skill) throw new Error(`No skill named "${name}"`);
  const { body } = frontmatter(await fs.readFile(skill.file, 'utf8'));
  return { ...skill, path: path.dirname(skill.file), text: body };
}

/**
 * Skills and slash commands for the "/" menu: global (~/.claude), project
 * (<project>/.claude) and the harness's own commands.
 */
export async function listCommands(settings, project) {
  const out = [{ name: 'clear', description: 'Start over: the model forgets earlier turns (they stay visible, dimmed).', scope: 'harness', kind: 'command' }];
  const scopes = [['global', path.join(os.homedir(), '.claude')]];
  if (project?.path) scopes.push(['project', path.join(project.path, '.claude')]);
  for (const [scope, base] of scopes) {
    let skills = [];
    try { skills = await fs.readdir(path.join(base, 'skills'), { withFileTypes: true }); } catch { /* none */ }
    for (const e of skills) {
      if (!e.isDirectory()) continue;
      try {
        const { meta } = frontmatter(await fs.readFile(path.join(base, 'skills', e.name, 'SKILL.md'), 'utf8'));
        out.push({ name: meta.name || e.name, description: meta.description || '', scope, kind: 'skill' });
      } catch { /* not a skill */ }
    }
    let cmds = [];
    try { cmds = await fs.readdir(path.join(base, 'commands'), { withFileTypes: true }); } catch { /* none */ }
    for (const e of cmds) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      try {
        const { meta, body } = frontmatter(await fs.readFile(path.join(base, 'commands', e.name), 'utf8'));
        out.push({ name: e.name.replace(/\.md$/, ''), description: meta.description || body.trim().split('\n')[0].slice(0, 120), scope, kind: 'command' });
      } catch { /* unreadable */ }
    }
  }
  // Project entries override global ones with the same name.
  const seen = new Map();
  for (const c of out) seen.set(`${c.kind}:${c.name}`, c);
  return [...seen.values()];
}
