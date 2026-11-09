#!/usr/bin/env node
// SessionStart hook for Claude Code and Antigravity.
// Injects (1) the shared, agent-neutral memory policy kept in the vault at
// _system/agent-memory-policy.md and (2) a compact index of 10_Rules
// (title + first observation) so every session starts with them in context.
// Full rule text is fetched on demand via the MCP (open_nodes).
//
// Vault path: OBSIDIAN_MEMORY_DIR or MEMORY_DIR (same value as the MCP server).
// Prints nothing (or `{}` with --agy) when the vault is not reachable, so a
// missing mount never blocks session start.
//
//   Claude Code : MEMORY_DIR=... node obsidian-rules-index.mjs
//   Antigravity : MEMORY_DIR=... node obsidian-rules-index.mjs --agy
import { promises as fs } from 'fs';
import path from 'path';

// Both agents get the same text: the shared memory policy (agent-neutral, kept in
// the vault) followed by the 10_Rules index. Agent-specific instructions live in each
// agent's own config (~/.claude/CLAUDE.md for Claude Code), never in the policy.
// --agy: emit Antigravity SessionStart JSON (injectSteps) instead of plain text.
const AGY = process.argv.includes('--agy');

const VAULT = process.env.OBSIDIAN_MEMORY_DIR || process.env.MEMORY_DIR || '';
const POLICY_FILE = path.join(VAULT, '_system', 'agent-memory-policy.md');

async function sharedPolicy() {
  if (!VAULT) return '';
  try {
    const raw = await fs.readFile(POLICY_FILE, 'utf-8');
    return raw
      .replace(/^---\n[\s\S]*?\n---\n?/, '')   // frontmatter
      .replace(/<!--[\s\S]*?-->\n?/g, '')        // editor-only notes
      .trim();
  } catch {
    return '';
  }
}

async function emit(rulesText) {
  const policy = await sharedPolicy();
  const msg = [policy, rulesText].filter(Boolean).join('\n\n');
  if (!AGY) { if (msg) process.stdout.write(msg); return; }
  if (!msg) { process.stdout.write('{}'); return; }
  process.stdout.write(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: msg } }] }));
}
const RULES_DIR = path.join(VAULT, '10_Rules');
const SUMMARY_MAX = 90;

function frontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { status: '', project: '', tags: [] };
  const fm = m[1];
  const get = k => (fm.match(new RegExp(`^${k}:\\s*['"]?([^'"\\n]*)['"]?\\s*$`, 'm')) || [])[1] || '';
  const tags = [...fm.matchAll(/^\s+-\s+['"]?([^'"\n]+)['"]?\s*$/gm)].map(x => x[1].trim());
  return { status: get('status').toLowerCase(), project: get('project'), tags };
}

function firstObservation(raw) {
  const lines = raw.split('\n');
  const i = lines.findIndex(l => /^#{2,3} Observations\s*$/.test(l.trim()));
  if (i === -1) return '';
  for (const l of lines.slice(i + 1)) {
    const t = l.trim();
    if (/^#{1,6}\s/.test(t)) break;
    if (t.startsWith('- ') || t.startsWith('* ')) return t.slice(2);
  }
  return '';
}

function clip(s) {
  const flat = s.replace(/\[\[(?:[^\]|:]+::)?([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').replace(/\s+/g, ' ');
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat;
}

async function main() {
  let files;
  if (!VAULT) return emit('');
  try {
    files = (await fs.readdir(RULES_DIR)).filter(f => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'));
  } catch {
    return emit(''); // vault not reachable (e.g. Drive not mounted): stay silent
  }

  const groups = new Map();
  for (const f of files.sort()) {
    const raw = await fs.readFile(path.join(RULES_DIR, f), 'utf-8');
    const fm = frontmatter(raw);
    if (['superseded', 'archived'].includes(fm.status)) continue;
    const project = fm.project
      || (fm.tags.find(t => t.startsWith('project/')) || '').replace('project/', '')
      || '共通';
    const summary = clip(firstObservation(raw));
    const line = `- ${f.slice(0, -3)}${summary ? ` — ${summary}` : ''}`;
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(line);
  }
  if (groups.size === 0) return emit('');

  const order = [...groups.keys()].sort((a, b) => (a === '共通' ? -1 : b === '共通' ? 1 : a.localeCompare(b)));
  const out = [
    '# Obsidian メモリ: 行動ルール一覧（10_Rules）',
    'ユーザーから受けた指示・フィードバックの蓄積。タイトルがルールそのもの。',
    '作業内容に関係するルールは obsidian-memory の open_nodes で全文を読んでから従うこと。',
    '「共通」は常に適用、プロジェクト名の付いたものはそのプロジェクトの作業時に適用。',
    '',
  ];
  for (const g of order) {
    out.push(`## ${g}`, ...groups.get(g), '');
  }
  await emit(out.join('\n'));
}

main().catch(() => { if (AGY) process.stdout.write('{}'); });
