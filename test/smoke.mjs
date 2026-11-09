// End-to-end smoke test against a throwaway vault. Run after `npm run build`:
//   npm test
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-memory-test-'));
process.env.MEMORY_DIR = V;
const { MarkdownStorageManager } = await import(path.join(root, 'dist/storage/MarkdownStorageManager.js'));
const read = p => fs.readFile(path.join(V, p), 'utf8');
const ok = l => console.log('ok -', l);

// --- a flat legacy vault ----------------------------------------------------
const legacy = {
  'Old rule.md': `---\nentityType: feedback\ntags:\n  - project/demo\n---\n\n# Old rule\n\n## Observations\n- do X\n`,
  'Demo の再開位置.md': `---\nentityType: project\ntags:\n  - project/demo\n---\n\n# Demo の再開位置\n\n## Observations\n- step 3\n`,
  'Session 2026-10-01_1200 first.md': `---\nentityType: session\ntags:\n  - session\n---\n\n# Session 2026-10-01_1200 first\n\n## 概要\nov\n\n## ナビゲーション\n- ⬆️ 目次: [[Sessions Index]]\n\nSee [[Old rule]] inline.\n\n## Observations\n- 概要: ov\n\n## Relations\n- [[indexed_in::Sessions Index]]\n`,
  'Sessions Index.md': `---\nentityType: index\n---\n\n# Sessions Index\n\n## セッション一覧（新しい順）\n\n- [[Session 2026-10-01_1200 first]]\n`,
  'loose.md': `no frontmatter\n`,
};
for (const [f, c] of Object.entries(legacy)) await fs.writeFile(path.join(V, f), c);

try {
  let m = new MarkdownStorageManager();
  assert.equal((await m.readGraph()).entities.length, 5); ok('flat vault still readable');

  // --- migration --------------------------------------------------------------
  const mig = path.join(root, 'dist/scripts/migrate-layout.js');
  execFileSync('node', [mig, '--apply'], { env: process.env, stdio: 'pipe' });
  await read('10_Rules/Old rule.md');
  assert((await read('20_Projects/demo/state/Demo の再開位置.md')).includes('entityType: state'));
  await read('40_Sessions/2026/2026-10/Session 2026-10-01_1200 first.md');
  await read('_system/Sessions Index.md');
  await read('00_Inbox/loose.md');
  ok('migration places notes and refines legacy types');

  m = new MarkdownStorageManager();
  assert.equal((await m.listNodes({ folder: '10_Rules' })).length, 1);
  assert.equal((await m.listNodes({ project: 'demo', entityType: 'state' })).length, 1);
  ok('recursive load + filters');

  // --- automatic placement ------------------------------------------------------
  const c = await m.createEntities([
    { name: 'T tip', entityType: 'tip', observations: ['a'] },
    { name: 'T anti', entityType: 'antipattern', project: 'Demo App', observations: ['b'] },
    { name: 'T decision', entityType: 'decision', tags: ['project/demo'], observations: ['c'] },
    { name: 'T state', entityType: 'state', observations: ['d'] },
    { name: 'T explicit', entityType: 'note', folder: '30_Knowledge/antipatterns', observations: ['e'] },
  ]);
  assert.deepEqual(c.map(e => e.path), [
    '30_Knowledge/tips/T tip.md',
    '20_Projects/demo-app/notes/T anti.md',
    '20_Projects/demo/decisions/T decision.md',
    '00_Inbox/T state.md',
    '30_Knowledge/antipatterns/T explicit.md',
  ]);
  assert.equal((await m.createEntities([{ name: 'Old rule', entityType: 'x', observations: [] }])).length, 0);
  await assert.rejects(m.createEntities([{ name: 'T bad', entityType: 'x', folder: '../escape', observations: [] }]));
  ok('placement by entityType/project, no duplicates, no vault escape');

  // --- observations are edited in place -----------------------------------------
  const sp = '40_Sessions/2026/2026-10/Session 2026-10-01_1200 first.md';
  const before = await read(sp);
  await m.addObservations([{ entityName: 'Session 2026-10-01_1200 first', contents: ['added'] }]);
  const after = await read(sp);
  for (const h of before.match(/^## .+$/gm)) assert(after.includes(h), `lost ${h}`);
  assert(after.includes('See [[Old rule]] inline.') && !after.includes('mentioned_in::'));
  await m.deleteObservations([{ entityName: 'Session 2026-10-01_1200 first', observations: ['added'] }]);
  const strip = s => s.replace(/^updated: .*\n/m, '');
  assert.equal(strip(await read(sp)), strip(before));
  ok('add/delete observations keep other sections intact');

  // --- relations / update / archive ---------------------------------------------
  await m.createRelations([{ from: 'T tip', to: 'T decision', relationType: 'informs' }]);
  assert.equal((await m.openNodes(['T tip', 'T decision'])).relations.length, 1);
  let u = await m.updateEntities([{ name: 'T state', project: 'demo' }]);
  assert.equal(u[0].path, '20_Projects/demo/state/T state.md');
  await m.updateEntities([{ name: 'T decision', status: 'superseded' }]);
  assert.equal((await m.listNodes({ status: 'superseded' })).length, 1);
  u = await m.updateEntities([{ name: 'T decision', folder: '90_Archive' }]);
  assert.equal(u[0].path, '90_Archive/T decision.md');
  assert.equal((await m.searchNodes('T decision')).entities.length, 0);
  assert.equal((await m.searchNodes('T decision', { includeArchived: true })).entities.length, 1);
  assert((await read('90_Archive/T decision.md')).includes('project: demo'));
  ok('cross-folder relations, relocate, status, archive');

  // --- sessions -----------------------------------------------------------------
  const s = await m.createSessionMoc({ title: 'second', overview: 'ov2', project: 'demo' });
  assert(s.filePath.startsWith('40_Sessions/'));
  assert((await read('_system/Sessions Index.md')).includes(s.entityName));
  assert((await read(sp)).includes(`preceded_by::${s.entityName}`));
  ok('session placed, index and forward link updated');

  await m.deleteEntities(['T decision']);
  assert(!(await read('30_Knowledge/tips/T tip.md')).includes('informs::T decision'));
  ok('delete removes inbound relations');

  // --- session-start hook ---------------------------------------------------------
  await fs.mkdir(path.join(V, '_system'), { recursive: true });
  await fs.writeFile(path.join(V, '_system/agent-memory-policy.md'), '---\nentityType: system\n---\n<!-- editor note -->\n# Policy\n- shared\n');
  const hook = path.join(root, 'integrations/obsidian-rules-index.mjs');
  const plain = execFileSync('node', [hook], { env: process.env }).toString();
  assert(plain.includes('# Policy') && plain.includes('- Old rule') && !plain.includes('editor note'));
  const agy = JSON.parse(execFileSync('node', [hook, '--agy'], { env: process.env }).toString());
  assert(agy.injectSteps[0].systemMessage.systemMessage.includes('- Old rule'));
  const none = execFileSync('node', [hook, '--agy'], { env: { PATH: process.env.PATH } }).toString();
  assert.equal(none, '{}');
  ok('session-start hook output (plain, --agy, no vault)');


  console.log('\nall passed');
} finally {
  await fs.rm(V, { recursive: true, force: true });
}
