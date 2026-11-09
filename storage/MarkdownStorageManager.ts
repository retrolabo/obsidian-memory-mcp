import { promises as fs } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import {
  Entity,
  Relation,
  KnowledgeGraph,
  CreateSessionMocParams,
  NodeFilter,
  NodeSummary,
  UpdateEntityParams,
} from '../types.js';
import {
  getMemoryDir,
  getEntityNameFromPath,
  sanitizeFilename
} from '../utils/pathUtils.js';
import {
  parseMarkdown,
  generateMarkdown,
  addRelationToContent,
  removeRelationFromContent,
  appendObservationsToContent,
  removeObservationsFromContent,
  mergeFrontmatter,
} from '../utils/markdownUtils.js';
import {
  FOLDERS,
  IGNORED_DIRS,
  normalizeProject,
  projectFromTags,
  resolveFolder,
  sanitizeRelativeFolder,
} from '../utils/layout.js';

interface LoadedNote {
  entity: Entity;
  relations: Relation[];
}

const SESSIONS_INDEX = 'Sessions Index';

export class MarkdownStorageManager {
  private memoryDir: string;

  constructor() {
    this.memoryDir = getMemoryDir();
  }

  // ---------------------------------------------------------------------------
  // Paths & index
  // ---------------------------------------------------------------------------

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create directory ${dir}: ${error}`);
    }
  }

  private rel(absPath: string): string {
    return path.relative(this.memoryDir, absPath).split(path.sep).join('/');
  }

  /**
   * Walk the vault recursively and map entity name (file basename) -> absolute path.
   * Obsidian resolves [[links]] by basename, so names are the unique key across folders.
   */
  private async buildIndex(): Promise<Map<string, string>> {
    await this.ensureDir(this.memoryDir);
    const index = new Map<string, string>();
    const ignored = new Set(IGNORED_DIRS);

    const walk = async (dir: string): Promise<void> => {
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        throw new Error(`Failed to read directory ${dir}: ${error}`);
      }
      // Sort so that duplicate resolution is deterministic (shallower/alphabetical first).
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      const subdirs: string[] = [];
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue;
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) {
          const r = this.rel(abs);
          if (ignored.has(r) || ignored.has(d.name)) continue;
          subdirs.push(abs);
        } else if (d.isFile() && d.name.endsWith('.md')) {
          const name = getEntityNameFromPath(abs);
          if (!name) continue;
          if (index.has(name)) {
            console.error(`[obsidian-memory] duplicate note name "${name}": using ${this.rel(index.get(name)!)}, ignoring ${this.rel(abs)}`);
            continue;
          }
          index.set(name, abs);
        }
      }
      for (const s of subdirs) await walk(s);
    };

    await walk(this.memoryDir);
    return index;
  }

  private async resolvePath(name: string, index?: Map<string, string>): Promise<string | undefined> {
    const idx = index || await this.buildIndex();
    return idx.get(name) ?? idx.get(sanitizeFilename(name));
  }

  private async requirePath(name: string, index?: Map<string, string>): Promise<string> {
    const p = await this.resolvePath(name, index);
    if (!p) throw new Error(`Entity ${name} not found`);
    return p;
  }

  /** Absolute path where a new note named `name` should be written. */
  private placementPath(name: string, folder: string): string {
    return path.join(this.memoryDir, folder, `${sanitizeFilename(name)}.md`);
  }

  private folderFor(entity: { name: string; entityType?: string; project?: string; folder?: string }): string {
    if (entity.folder !== undefined && entity.folder !== null) {
      return sanitizeRelativeFolder(entity.folder);
    }
    return resolveFolder({ name: entity.name, entityType: entity.entityType, project: entity.project });
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  private async loadNote(filePath: string): Promise<LoadedNote | null> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') return null;
      throw error;
    }
    const entityName = getEntityNameFromPath(filePath);
    if (!entityName) return null;

    const parsed = parseMarkdown(content, entityName);
    const tags = parsed.metadata.tags || [];
    const entity: Entity = {
      name: entityName,
      entityType: parsed.metadata.entityType || 'unknown',
      observations: parsed.observations,
      tags,
      created: parsed.metadata.created,
      updated: parsed.metadata.updated,
      project: normalizeProject(parsed.metadata.project) || projectFromTags(tags),
      status: parsed.metadata.status,
      path: this.rel(filePath),
    };
    const relations = parsed.relations.map(r => ({ from: entityName, to: r.to, relationType: r.relationType }));
    return { entity, relations };
  }

  private async loadAll(index?: Map<string, string>): Promise<LoadedNote[]> {
    const idx = index || await this.buildIndex();
    try {
      const notes = await Promise.all([...idx.values()].map(p => this.loadNote(p)));
      return notes.filter((n): n is LoadedNote => n !== null);
    } catch (error) {
      throw new Error(`Failed to load entities: ${error}`);
    }
  }

  async loadGraph(): Promise<KnowledgeGraph> {
    const notes = await this.loadAll();
    return {
      entities: notes.map(n => n.entity),
      relations: notes.flatMap(n => n.relations),
    };
  }

  private matchesFilter(e: Entity, f: NodeFilter = {}): boolean {
    const p = e.path || '';
    if (!f.includeArchived && (p === FOLDERS.archive || p.startsWith(`${FOLDERS.archive}/`))) {
      // An explicit folder filter pointing into the archive wins.
      if (!(f.folder && sanitizeRelativeFolder(f.folder).startsWith(FOLDERS.archive))) return false;
    }
    if (f.folder) {
      const folder = sanitizeRelativeFolder(f.folder);
      if (folder && !(p.startsWith(`${folder}/`))) return false;
    }
    if (f.entityType && e.entityType.toLowerCase() !== f.entityType.toLowerCase()) return false;
    if (f.project && e.project !== normalizeProject(f.project)) return false;
    if (f.status && (e.status || 'active').toLowerCase() !== f.status.toLowerCase()) return false;
    if (f.tag) {
      const tag = f.tag.replace(/^#/, '').toLowerCase();
      if (!(e.tags || []).some(t => t.toLowerCase() === tag || t.toLowerCase().startsWith(`${tag}/`))) return false;
    }
    return true;
  }

  private subgraph(graph: KnowledgeGraph, entities: Entity[]): KnowledgeGraph {
    const names = new Set(entities.map(e => e.name));
    return {
      entities,
      relations: graph.relations.filter(r => names.has(r.from) && names.has(r.to)),
    };
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const index = await this.buildIndex();
    const created: Entity[] = [];

    for (const input of entities) {
      if (await this.resolvePath(input.name, index)) continue;

      const project = normalizeProject(input.project) || projectFromTags(input.tags);
      const entity: Entity = { ...input, project };
      const folder = this.folderFor(entity);
      const filePath = this.placementPath(entity.name, folder);

      await this.ensureDir(path.dirname(filePath));
      try {
        await fs.writeFile(filePath, generateMarkdown(entity, []), { encoding: 'utf-8', flag: 'wx' });
      } catch (error) {
        throw new Error(`Failed to save entity ${entity.name}: ${error}`);
      }
      index.set(entity.name, filePath);

      const { folder: _ignored, ...rest } = entity;
      created.push({ ...rest, path: this.rel(filePath) });
    }

    return created;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const index = await this.buildIndex();
    const graph = await this.loadGraph();
    const newRelations: Relation[] = [];

    for (const relation of relations) {
      const exists = graph.relations.some(r =>
        r.from === relation.from && r.to === relation.to && r.relationType === relation.relationType
      );
      if (exists) continue;

      const fromPath = await this.requirePath(relation.from, index);
      const content = await fs.readFile(fromPath, 'utf-8');
      await fs.writeFile(fromPath, addRelationToContent(content, relation), 'utf-8');
      graph.relations.push(relation);
      newRelations.push(relation);
    }

    return newRelations;
  }

  /** Appends observations in place: other sections of the note are preserved. */
  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const index = await this.buildIndex();
    const results: { entityName: string; addedObservations: string[] }[] = [];

    for (const obs of observations) {
      try {
        const filePath = await this.requirePath(obs.entityName, index);
        const content = await fs.readFile(filePath, 'utf-8');
        const existing = new Set(parseMarkdown(content, obs.entityName).observations);
        const fresh = [...new Set(obs.contents)].filter(c => !existing.has(c));
        if (fresh.length === 0) continue;

        const updated = mergeFrontmatter(appendObservationsToContent(content, fresh), {});
        await fs.writeFile(filePath, updated, 'utf-8');
        results.push({ entityName: obs.entityName, addedObservations: fresh });
      } catch (error) {
        throw new Error(`Failed to add observations to ${obs.entityName}: ${error}`);
      }
    }

    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const index = await this.buildIndex();

    for (const name of entityNames) {
      const filePath = await this.resolvePath(name, index);
      if (!filePath) continue;
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as any).code !== 'ENOENT') {
          throw new Error(`Failed to delete entity ${name}: ${error}`);
        }
      }
      index.delete(name);
    }

    // Remove relations pointing to deleted entities
    const notes = await this.loadAll(index);
    const targets = new Set(entityNames);
    for (const note of notes) {
      const toRemove = note.relations.filter(r => targets.has(r.to));
      if (toRemove.length === 0) continue;
      const filePath = index.get(note.entity.name)!;
      let content = await fs.readFile(filePath, 'utf-8');
      for (const r of toRemove) content = removeRelationFromContent(content, r);
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    const index = await this.buildIndex();

    for (const del of deletions) {
      const filePath = await this.resolvePath(del.entityName, index);
      if (!filePath) continue;
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const next = removeObservationsFromContent(content, del.observations);
        if (next === content) continue;
        await fs.writeFile(filePath, mergeFrontmatter(next, {}), 'utf-8');
      } catch (error) {
        throw new Error(`Failed to delete observations from ${del.entityName}: ${error}`);
      }
    }
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const index = await this.buildIndex();

    for (const relation of relations) {
      const fromPath = await this.resolvePath(relation.from, index);
      if (!fromPath) continue;
      const content = await fs.readFile(fromPath, 'utf-8');
      await fs.writeFile(fromPath, removeRelationFromContent(content, relation), 'utf-8');
    }
  }

  /**
   * Update frontmatter (entityType / project / status / tags) and optionally move
   * the note to another folder. Links keep working because Obsidian resolves by name.
   */
  async updateEntities(updates: UpdateEntityParams[]): Promise<{ name: string; path: string; moved: boolean }[]> {
    const index = await this.buildIndex();
    const results: { name: string; path: string; moved: boolean }[] = [];

    for (const u of updates) {
      const filePath = await this.requirePath(u.name, index);
      let content = await fs.readFile(filePath, 'utf-8');

      const set: Record<string, any> = {};
      const remove: string[] = [];
      if (u.entityType !== undefined) set.entityType = u.entityType;
      if (u.project !== undefined) {
        const p = normalizeProject(u.project);
        if (p) set.project = p; else remove.push('project');
      }
      if (u.status !== undefined) {
        if (u.status) set.status = u.status; else remove.push('status');
      }
      if (u.tags !== undefined) set.tags = u.tags.map(t => t.trim().replace(/^#/, '')).filter(Boolean);

      if (Object.keys(set).length > 0 || remove.length > 0) {
        content = mergeFrontmatter(content, set, remove);
        await fs.writeFile(filePath, content, 'utf-8');
      }

      let target = filePath;
      const relocate = u.folder !== undefined
        || (u.relocate ?? (u.entityType !== undefined || u.project !== undefined));
      if (relocate) {
        const loaded = await this.loadNote(filePath);
        const folder = this.folderFor({
          name: u.name,
          entityType: loaded?.entity.entityType,
          project: loaded?.entity.project,
          folder: u.folder,
        });
        target = path.join(this.memoryDir, folder, path.basename(filePath));
        if (path.resolve(target) !== path.resolve(filePath)) {
          try {
            await fs.access(target);
            throw new Error(`Cannot move ${u.name}: ${this.rel(target)} already exists`);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && (error as any).code === 'ENOENT')) throw error;
          }
          await this.ensureDir(path.dirname(target));
          await fs.rename(filePath, target);
          index.set(u.name, target);
        }
      }

      results.push({ name: u.name, path: this.rel(target), moved: target !== filePath });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async readGraph(filter: NodeFilter = {}): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    return this.subgraph(graph, graph.entities.filter(e => this.matchesFilter(e, filter)));
  }

  async searchNodes(query: string, filter: NodeFilter = {}): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const q = (query || '').toLowerCase();

    const entities = graph.entities.filter(e => this.matchesFilter(e, filter) && (
      !q ||
      e.name.toLowerCase().includes(q) ||
      e.entityType.toLowerCase().includes(q) ||
      (e.project || '').includes(q) ||
      (e.tags && e.tags.some(t => t.toLowerCase().includes(q))) ||
      e.observations.some(o => o.toLowerCase().includes(q))
    ));

    return this.subgraph(graph, entities);
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    return this.subgraph(graph, graph.entities.filter(e => names.includes(e.name)));
  }

  /** Lightweight listing (no observations) for deciding what to load. */
  async listNodes(filter: NodeFilter = {}): Promise<NodeSummary[]> {
    const notes = await this.loadAll();
    return notes
      .map(n => n.entity)
      .filter(e => this.matchesFilter(e, filter))
      .map(e => ({
        name: e.name,
        entityType: e.entityType,
        project: e.project,
        status: e.status,
        tags: e.tags || [],
        updated: e.updated,
        path: e.path!,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async createSessionMoc(params: CreateSessionMocParams): Promise<{ entityName: string; filePath: string }> {
    const index = await this.buildIndex();

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}_${hours}${minutes}`;
    const todayYMD = `${year}-${month}-${day}`;
    const monthTag = `session/${year}-${month}`;

    const cleanTitle = params.title.trim().replace(/^Session\s+/, '');
    const entityName = `Session ${dateStr} ${cleanTitle}`;
    const filePath = this.placementPath(entityName, resolveFolder({ name: entityName, entityType: 'session', now }));

    // 1. Find previous / parent session
    let prevSessionName: string | null = null;
    if (params.parentSession) {
      prevSessionName = params.parentSession.replace(/\.md$/, '').trim();
    } else {
      const sessionNames = [...index.keys()]
        .filter(n => n.startsWith('Session ') && !n.includes('Index') && n !== entityName)
        .sort()
        .reverse();
      prevSessionName = sessionNames[0] || null;
    }

    // 2. Tags / project
    const tagsSet = new Set<string>();
    tagsSet.add('session');
    tagsSet.add(monthTag);
    if (params.tags && Array.isArray(params.tags)) {
      params.tags.forEach(t => tagsSet.add(t.trim().replace(/^#/, '')));
    }
    const project = normalizeProject(params.project) || projectFromTags([...tagsSet]);
    if (project) tagsSet.add(`project/${project}`);

    // 3. Frontmatter
    const frontmatter: Record<string, any> = {
      entityType: 'session',
      tags: Array.from(tagsSet),
      created: todayYMD,
      updated: todayYMD
    };
    if (project) frontmatter.project = project;

    // 4. Body
    let content = matter.stringify('', frontmatter);
    content += `# ${entityName}\n\n`;
    content += `## 概要\n${params.overview.trim()}\n\n`;

    content += `## ナビゲーション\n`;
    content += `- ⬆️ 目次: [[${SESSIONS_INDEX}]]\n`;
    if (project) content += `- 🏠 プロジェクト: [[${project}]]\n`;
    if (prevSessionName) content += `- ⬅️ 前のセッション: [[followed_by::${prevSessionName}]]\n`;
    content += `\n`;

    const section = (title: string, items?: string[]) => {
      if (items && items.length > 0) {
        content += `## ${title}\n`;
        for (const i of items) content += `- ${i}\n`;
        content += `\n`;
      }
    };
    section('相談・議論内容', params.topics);
    section('決定事項 (Decisions)', params.decisions);
    section('知見・Tips (Knowledge)', params.tips);
    if (params.relatedEntities && params.relatedEntities.length > 0) {
      section('関連ノート（Map of Content）', params.relatedEntities.map(re => `[[${re.trim()}]]`));
    }
    section('次回への申し送り (Next Steps)', params.nextSteps);

    // Observations (for standard MCP memory search)
    content += `## Observations\n`;
    content += `- 概要: ${params.overview.trim()}\n`;
    params.topics?.forEach(t => { content += `- 相談: ${t}\n`; });
    params.decisions?.forEach(d => { content += `- 決定: ${d}\n`; });
    params.tips?.forEach(t => { content += `- Tips: ${t}\n`; });
    params.nextSteps?.forEach(ns => { content += `- 申し送り: ${ns}\n`; });
    content += `\n`;

    content += `## Relations\n`;
    content += `- [[indexed_in::${SESSIONS_INDEX}]]\n`;
    if (prevSessionName) content += `- [[followed_by::${prevSessionName}]]\n`;
    params.relatedEntities?.forEach(re => { content += `- [[related_to::${re.trim()}]]\n`; });
    content += `\n`;

    await this.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, 'utf-8');
    index.set(entityName, filePath);

    // 5. Forward link on the previous session
    if (prevSessionName) {
      const prevPath = await this.resolvePath(prevSessionName, index);
      if (prevPath) {
        try {
          let prevContent = await fs.readFile(prevPath, 'utf-8');
          if (prevContent.includes('## ナビゲーション\n')) {
            prevContent = prevContent.replace(
              '## ナビゲーション\n',
              `## ナビゲーション\n- ➡️ 次のセッション: [[preceded_by::${entityName}]]\n`
            );
          }
          const updatedPrev = addRelationToContent(prevContent, {
            from: prevSessionName,
            to: entityName,
            relationType: 'preceded_by'
          });
          await fs.writeFile(prevPath, updatedPrev, 'utf-8');
        } catch (e) {
          console.error(`Failed to update forward link in ${prevSessionName}:`, e);
        }
      } else {
        console.error(`Previous session ${prevSessionName} not found; forward link skipped`);
      }
    }

    // 6. Sessions Index (found anywhere in the vault; created under _system/)
    const entryText = `- [[${entityName}]]\n  - 主な内容: ${params.overview.trim()}\n`;
    const indexPath = await this.resolvePath(SESSIONS_INDEX, index);
    if (indexPath) {
      let indexContent = await fs.readFile(indexPath, 'utf-8');
      for (const header of ['## セッション一覧（新しい順）\n\n', '## セッション一覧（新しい順）\n']) {
        if (indexContent.includes(header)) {
          indexContent = indexContent.replace(header, `${header}${entryText}`);
          await fs.writeFile(indexPath, indexContent, 'utf-8');
          break;
        }
      }
    } else {
      const newIndexPath = this.placementPath(SESSIONS_INDEX, FOLDERS.system);
      const newIndex = `---
entityType: index
tags:
  - session
  - index
created: '${todayYMD}'
updated: '${todayYMD}'
---

# Sessions Index（セッション履歴・目次）

各会話セッションの要約と、そのセッションで生まれた決定・Tips・作業状態を時系列で辿るためのインデックスです。

## セッション一覧（新しい順）

${entryText}
---

## Dataview（プラグイン有効時）

\`\`\`dataview
TABLE created, project, tags, file.outlinks AS "Links"
FROM "${FOLDERS.sessions}"
SORT file.name DESC
\`\`\`
`;
      await this.ensureDir(path.dirname(newIndexPath));
      await fs.writeFile(newIndexPath, newIndex, 'utf-8');
    }

    return { entityName, filePath: this.rel(filePath) };
  }
}
