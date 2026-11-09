#!/usr/bin/env node
/**
 * Move flat notes in the vault root into the folder layout (utils/layout.ts).
 *
 *   node dist/scripts/migrate-layout.js                 # dry run: print the plan
 *   node dist/scripts/migrate-layout.js --apply         # move files, write a revert log
 *   node dist/scripts/migrate-layout.js --revert <log>  # undo a previous --apply
 *
 * Uses MEMORY_DIR like the server. Only notes directly in the vault root are moved;
 * anything already inside a folder is left alone.
 */
import { promises as fs } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getMemoryDir } from '../utils/pathUtils.js';
import { FOLDERS, normalizeProject, projectFromTags, resolveFolder } from '../utils/layout.js';

interface Move { name: string; entityType: string; newEntityType?: string; project?: string; from: string; to: string }

const SYSTEM_NOTES = new Set(['Sessions Index']);

/**
 * Migration-only refinement: legacy notes mostly use the vague type "project",
 * so guess state / decision from the title. Explicit types are never overridden.
 */
function refineType(name: string, entityType: string): string {
  if (!['project', 'unknown', 'note'].includes(entityType.toLowerCase())) return entityType;
  if (/再開位置|引き継ぎ|現在地|進捗|TODO|到達点|状態/.test(name)) return 'state';
  if (/方針|設計|決定|決まり/.test(name)) return 'decision';
  return entityType;
}

async function plan(vault: string): Promise<Move[]> {
  const dirents = await fs.readdir(vault, { withFileTypes: true });
  const moves: Move[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.md') || d.name.startsWith('.')) continue;
    const name = d.name.slice(0, -3);
    const raw = await fs.readFile(path.join(vault, d.name), 'utf-8');
    const data = (matter(raw).data || {}) as Record<string, any>;
    const entityType = String(data.entityType || 'unknown');
    let tags: string[] = [];
    if (Array.isArray(data.tags)) tags = data.tags.map(String);
    else if (typeof data.tags === 'string') tags = data.tags.split(',');
    const project = normalizeProject(data.project) || projectFromTags(tags);

    const refined = refineType(name, entityType);
    const folder = SYSTEM_NOTES.has(name)
      ? FOLDERS.system
      : resolveFolder({ name, entityType: refined, project });
    moves.push({
      name, entityType, project, from: d.name, to: path.posix.join(folder, d.name),
      ...(refined !== entityType ? { newEntityType: refined } : {}),
    });
  }
  return moves.sort((a, b) => a.to.localeCompare(b.to));
}

function summarize(moves: Move[]): void {
  const byFolder = new Map<string, number>();
  for (const m of moves) {
    const f = path.posix.dirname(m.to);
    byFolder.set(f, (byFolder.get(f) || 0) + 1);
  }
  console.log('\n== summary (folder: count) ==');
  for (const [f, n] of [...byFolder.entries()].sort()) console.log(`${String(n).padStart(4)}  ${f}`);
  console.log(`${String(moves.length).padStart(4)}  total`);
}

/** Rewrite only the entityType line of the frontmatter (minimal diff). */
async function setEntityType(file: string, from: string, to: string): Promise<void> {
  const raw = await fs.readFile(file, 'utf-8');
  const end = raw.startsWith('---') ? raw.indexOf('\n---', 3) : -1;
  if (end === -1) return;
  const head = raw.slice(0, end);
  const re = new RegExp(`^entityType:\\s*['"]?${from}['"]?\\s*$`, 'm');
  if (!re.test(head)) return;
  await fs.writeFile(file, head.replace(re, `entityType: ${to}`) + raw.slice(end), 'utf-8');
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function apply(vault: string, moves: Move[]): Promise<void> {
  for (const m of moves) {
    if (await exists(path.join(vault, m.to))) {
      throw new Error(`target already exists, aborting before any move: ${m.to}`);
    }
  }
  const logDir = path.join(vault, FOLDERS.system, 'migrations');
  await fs.mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `layout-${stamp}.json`);
  const done: Move[] = [];
  try {
    for (const m of moves) {
      await fs.mkdir(path.join(vault, path.posix.dirname(m.to)), { recursive: true });
      await fs.rename(path.join(vault, m.from), path.join(vault, m.to));
      done.push(m);
      if (m.newEntityType) await setEntityType(path.join(vault, m.to), m.entityType, m.newEntityType);
    }
  } finally {
    await fs.writeFile(logPath, JSON.stringify(done, null, 2), 'utf-8');
    console.log(`moved ${done.length}/${moves.length}; revert log: ${logPath}`);
  }
}

async function revert(vault: string, logPath: string): Promise<void> {
  const moves = JSON.parse(await fs.readFile(logPath, 'utf-8')) as Move[];
  let n = 0;
  for (const m of moves.reverse()) {
    const src = path.join(vault, m.to);
    const dst = path.join(vault, m.from);
    if (!(await exists(src))) { console.error(`missing, skipped: ${m.to}`); continue; }
    if (await exists(dst)) { console.error(`root already has ${m.from}, skipped`); continue; }
    if (m.newEntityType) await setEntityType(src, m.newEntityType, m.entityType);
    await fs.rename(src, dst);
    n++;
  }
  console.log(`reverted ${n}/${moves.length}`);
}

async function main() {
  const vault = getMemoryDir();
  const args = process.argv.slice(2);
  console.log(`vault: ${vault}`);

  const r = args.indexOf('--revert');
  if (r !== -1) {
    if (!args[r + 1]) throw new Error('--revert needs a log path');
    await revert(vault, args[r + 1]);
    return;
  }

  const moves = await plan(vault);
  for (const m of moves) {
    const t = m.newEntityType ? `${m.entityType}->${m.newEntityType}` : m.entityType;
    console.log(`${t.padEnd(16)}\t${(m.project || '-').padEnd(16)}\t${m.to}`);
  }
  summarize(moves);

  if (args.includes('--apply')) await apply(vault, moves);
  else console.log('\n(dry run — pass --apply to move files)');
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
