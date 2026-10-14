import { promises as fs } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { Entity, Relation, KnowledgeGraph, CreateSessionMocParams } from '../types.js';
import { 
  getMemoryDir, 
  getEntityPath, 
  getEntityNameFromPath,
  sanitizeFilename 
} from '../utils/pathUtils.js';
import { 
  parseMarkdown, 
  generateMarkdown,
  updateMetadata,
  addRelationToContent,
  removeRelationFromContent
} from '../utils/markdownUtils.js';

export class MarkdownStorageManager {
  private memoryDir: string;

  constructor() {
    this.memoryDir = getMemoryDir();
  }

  /**
   * Ensure the memory directory exists
   */
  private async ensureMemoryDir(): Promise<void> {
    try {
      await fs.mkdir(this.memoryDir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create memory directory: ${error}`);
    }
  }

  /**
   * Load a single entity from a markdown file
   */
  private async loadEntity(filePath: string): Promise<Entity | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const entityName = getEntityNameFromPath(filePath);
      if (!entityName) return null;

      const parsed = parseMarkdown(content, entityName);
      return {
        name: entityName,
        entityType: parsed.metadata.entityType || 'unknown',
        observations: parsed.observations,
        tags: parsed.metadata.tags || [],
        created: parsed.metadata.created
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Load all entities from the memory directory
   */
  private async loadAllEntities(): Promise<Entity[]> {
    await this.ensureMemoryDir();
    
    try {
      const files = await fs.readdir(this.memoryDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      
      const entities = await Promise.all(
        mdFiles.map(file => this.loadEntity(path.join(this.memoryDir, file)))
      );
      
      return entities.filter((e): e is Entity => e !== null);
    } catch (error) {
      throw new Error(`Failed to load entities: ${error}`);
    }
  }

  /**
   * Load all relations from all markdown files
   */
  private async loadAllRelations(): Promise<Relation[]> {
    await this.ensureMemoryDir();
    
    try {
      const files = await fs.readdir(this.memoryDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      
      const allRelations: Relation[] = [];
      
      for (const file of mdFiles) {
        const filePath = path.join(this.memoryDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const entityName = getEntityNameFromPath(filePath);
        if (!entityName) continue;
        
        const parsed = parseMarkdown(content, entityName);
        
        for (const rel of parsed.relations) {
          allRelations.push({
            from: entityName,
            to: rel.to,
            relationType: rel.relationType
          });
        }
      }
      
      return allRelations;
    } catch (error) {
      throw new Error(`Failed to load relations: ${error}`);
    }
  }

  /**
   * Save an entity to a markdown file
   */
  private async saveEntity(entity: Entity, relations: Relation[]): Promise<void> {
    await this.ensureMemoryDir();
    
    const filePath = getEntityPath(entity.name);
    const content = generateMarkdown(entity, relations);
    
    try {
      await fs.writeFile(filePath, content, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to save entity ${entity.name}: ${error}`);
    }
  }

  /**
   * Load the entire knowledge graph
   */
  async loadGraph(): Promise<KnowledgeGraph> {
    const [entities, relations] = await Promise.all([
      this.loadAllEntities(),
      this.loadAllRelations()
    ]);
    
    return { entities, relations };
  }

  /**
   * Create new entities
   */
  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const newEntities: Entity[] = [];
    
    for (const entity of entities) {
      // Check if entity already exists
      if (graph.entities.some(e => e.name === entity.name)) {
        continue;
      }
      
      // Save the entity
      await this.saveEntity(entity, []);
      newEntities.push(entity);
    }
    
    return newEntities;
  }

  /**
   * Create new relations and update both source and target files
   */
  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const newRelations: Relation[] = [];
    
    for (const relation of relations) {
      // Check if relation already exists
      const exists = graph.relations.some(r => 
        r.from === relation.from && 
        r.to === relation.to && 
        r.relationType === relation.relationType
      );
      
      if (exists) continue;
      
      // Update the source entity file
      const fromPath = getEntityPath(relation.from);
      try {
        const content = await fs.readFile(fromPath, 'utf-8');
        const updatedContent = addRelationToContent(content, relation);
        await fs.writeFile(fromPath, updatedContent, 'utf-8');
        
        newRelations.push(relation);
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
          throw new Error(`Entity ${relation.from} not found`);
        }
        throw error;
      }
    }
    
    return newRelations;
  }

  /**
   * Add observations to existing entities
   */
  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const results: { entityName: string; addedObservations: string[] }[] = [];
    
    for (const obs of observations) {
      const entityPath = getEntityPath(obs.entityName);
      
      try {
        // Load current entity
        const entity = await this.loadEntity(entityPath);
        if (!entity) {
          throw new Error(`Entity ${obs.entityName} not found`);
        }
        
        // Filter out duplicate observations
        const newObservations = obs.contents.filter(
          content => !entity.observations.includes(content)
        );
        
        if (newObservations.length > 0) {
          // Update entity
          entity.observations.push(...newObservations);
          
          // Get current relations for this entity
          const graph = await this.loadGraph();
          const entityRelations = graph.relations.filter(r => r.from === entity.name);
          
          // Save updated entity
          await this.saveEntity(entity, entityRelations);
          
          results.push({
            entityName: obs.entityName,
            addedObservations: newObservations
          });
        }
      } catch (error) {
        throw new Error(`Failed to add observations to ${obs.entityName}: ${error}`);
      }
    }
    
    return results;
  }

  /**
   * Delete entities and their files
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    for (const name of entityNames) {
      const filePath = getEntityPath(name);
      
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as any).code !== 'ENOENT') {
          throw new Error(`Failed to delete entity ${name}: ${error}`);
        }
      }
    }
    
    // Remove relations pointing to deleted entities
    const remainingRelations = await this.loadAllRelations();
    const relationsToRemove = remainingRelations.filter(
      r => entityNames.includes(r.to)
    );
    
    for (const relation of relationsToRemove) {
      const fromPath = getEntityPath(relation.from);
      try {
        const content = await fs.readFile(fromPath, 'utf-8');
        const updatedContent = removeRelationFromContent(content, relation);
        await fs.writeFile(fromPath, updatedContent, 'utf-8');
      } catch (error) {
        // Entity might have been deleted
      }
    }
  }

  /**
   * Delete specific observations from entities
   */
  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    for (const del of deletions) {
      const entityPath = getEntityPath(del.entityName);
      
      try {
        const entity = await this.loadEntity(entityPath);
        if (!entity) continue;
        
        // Remove specified observations
        entity.observations = entity.observations.filter(
          obs => !del.observations.includes(obs)
        );
        
        // Get current relations
        const graph = await this.loadGraph();
        const entityRelations = graph.relations.filter(r => r.from === entity.name);
        
        // Save updated entity
        await this.saveEntity(entity, entityRelations);
      } catch (error) {
        throw new Error(`Failed to delete observations from ${del.entityName}: ${error}`);
      }
    }
  }

  /**
   * Delete relations
   */
  async deleteRelations(relations: Relation[]): Promise<void> {
    for (const relation of relations) {
      const fromPath = getEntityPath(relation.from);
      
      try {
        const content = await fs.readFile(fromPath, 'utf-8');
        const updatedContent = removeRelationFromContent(content, relation);
        await fs.writeFile(fromPath, updatedContent, 'utf-8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as any).code !== 'ENOENT') {
          throw new Error(`Failed to delete relation from ${relation.from}: ${error}`);
        }
      }
    }
  }

  /**
   * Read the entire graph
   */
  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  /**
   * Search nodes based on query
   */
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const queryLower = query.toLowerCase();
    
    // Filter entities
    const filteredEntities = graph.entities.filter(e => 
      e.name.toLowerCase().includes(queryLower) ||
      e.entityType.toLowerCase().includes(queryLower) ||
      (e.tags && e.tags.some(t => t.toLowerCase().includes(queryLower))) ||
      e.observations.some(o => o.toLowerCase().includes(queryLower))
    );
    
    // Get filtered entity names
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    
    // Filter relations to only include those between filtered entities
    const filteredRelations = graph.relations.filter(r => 
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );
    
    return {
      entities: filteredEntities,
      relations: filteredRelations
    };
  }

  /**
   * Open specific nodes by name
   */
  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    
    // Filter entities
    const filteredEntities = graph.entities.filter(e => names.includes(e.name));
    
    // Get filtered entity names
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    
    // Filter relations
    const filteredRelations = graph.relations.filter(r => 
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );
    
    return {
      entities: filteredEntities,
      relations: filteredRelations
    };
  }

  /**
   * Create a structured Session MOC (Map of Content) note
   */
  async createSessionMoc(params: CreateSessionMocParams): Promise<{ entityName: string; filePath: string }> {
    await this.ensureMemoryDir();

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
    const filePath = getEntityPath(entityName);

    // 1. Find previous session file
    const files = await fs.readdir(this.memoryDir);
    const sessionFiles = files
      .filter(f => f.startsWith('Session ') && f.endsWith('.md') && !f.includes('Index'))
      .sort()
      .reverse();
    
    let prevSessionName: string | null = null;
    for (const sf of sessionFiles) {
      const name = sf.replace(/\.md$/, '');
      if (name !== entityName) {
        prevSessionName = name;
        break;
      }
    }

    // 2. Prepare tags
    const tagsSet = new Set<string>();
    tagsSet.add('session');
    tagsSet.add(monthTag);
    if (params.tags && Array.isArray(params.tags)) {
      params.tags.forEach(t => tagsSet.add(t.trim().replace(/^#/, '')));
    }

    // 3. Prepare frontmatter
    const frontmatter: Record<string, any> = {
      entityType: 'session',
      tags: Array.from(tagsSet),
      created: todayYMD,
      updated: todayYMD
    };

    // 4. Build MOC content sections
    let content = matter.stringify('', frontmatter);
    content += `# ${entityName}\n\n`;

    // Overview section
    content += `## 概要\n${params.overview.trim()}\n\n`;

    // Navigation section
    content += `## ナビゲーション\n`;
    content += `- ⬆️ 目次: [[Sessions Index]]\n`;
    if (prevSessionName) {
      content += `- ⬅️ 前のセッション: [[followed_by::${prevSessionName}]]\n`;
    }
    content += `\n`;

    // Topics section
    if (params.topics && params.topics.length > 0) {
      content += `## 相談・議論内容\n`;
      for (const t of params.topics) {
        content += `- ${t}\n`;
      }
      content += `\n`;
    }

    // Decisions section
    if (params.decisions && params.decisions.length > 0) {
      content += `## 決定事項 (Decisions)\n`;
      for (const d of params.decisions) {
        content += `- ${d}\n`;
      }
      content += `\n`;
    }

    // Tips section
    if (params.tips && params.tips.length > 0) {
      content += `## 知見・Tips (Knowledge)\n`;
      for (const t of params.tips) {
        content += `- ${t}\n`;
      }
      content += `\n`;
    }

    // Related entities (Map of Content)
    if (params.relatedEntities && params.relatedEntities.length > 0) {
      content += `## 関連ノート（Map of Content）\n`;
      for (const re of params.relatedEntities) {
        content += `- [[${re.trim()}]]\n`;
      }
      content += `\n`;
    }

    // Next steps
    if (params.nextSteps && params.nextSteps.length > 0) {
      content += `## 次回への申し送り (Next Steps)\n`;
      for (const ns of params.nextSteps) {
        content += `- ${ns}\n`;
      }
      content += `\n`;
    }

    // Observations section (for standard MCP memory search)
    content += `## Observations\n`;
    content += `- 概要: ${params.overview.trim()}\n`;
    if (params.topics) {
      params.topics.forEach(t => { content += `- 相談: ${t}\n`; });
    }
    if (params.decisions) {
      params.decisions.forEach(d => { content += `- 決定: ${d}\n`; });
    }
    if (params.tips) {
      params.tips.forEach(t => { content += `- Tips: ${t}\n`; });
    }
    if (params.nextSteps) {
      params.nextSteps.forEach(ns => { content += `- 申し送り: ${ns}\n`; });
    }
    content += `\n`;

    // Relations section
    content += `## Relations\n`;
    content += `- [[indexed_in::Sessions Index]]\n`;
    if (prevSessionName) {
      content += `- [[followed_by::${prevSessionName}]]\n`;
    }
    if (params.relatedEntities) {
      for (const re of params.relatedEntities) {
        content += `- [[related_to::${re.trim()}]]\n`;
      }
    }
    content += `\n`;

    // Write the new session file
    await fs.writeFile(filePath, content, 'utf-8');

    // 5. Update previous session file with forward link
    if (prevSessionName) {
      const prevPath = getEntityPath(prevSessionName);
      try {
        let prevContent = await fs.readFile(prevPath, 'utf-8');
        if (prevContent.includes('## ナビゲーション')) {
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
    }

    // 6. Update Sessions Index.md
    const indexPath = path.join(this.memoryDir, 'Sessions Index.md');
    try {
      let indexContent = await fs.readFile(indexPath, 'utf-8');
      const entryText = `- [[${entityName}]]\n  - 主な内容: ${params.overview.trim()}\n`;
      if (indexContent.includes('## セッション一覧（新しい順）\n\n')) {
        indexContent = indexContent.replace(
          '## セッション一覧（新しい順）\n\n',
          `## セッション一覧（新しい順）\n\n${entryText}`
        );
        await fs.writeFile(indexPath, indexContent, 'utf-8');
      } else if (indexContent.includes('## セッション一覧（新しい順）\n')) {
        indexContent = indexContent.replace(
          '## セッション一覧（新しい順）\n',
          `## セッション一覧（新しい順）\n${entryText}`
        );
        await fs.writeFile(indexPath, indexContent, 'utf-8');
      }
    } catch (e) {
      // Create Sessions Index if not present
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

- [[${entityName}]]
  - 主な内容: ${params.overview.trim()}

---

## Dataview（プラグイン有効時）

\`\`\`dataview
TABLE created, tags, file.outlinks AS "Links"
FROM #session AND !"Sessions Index"
SORT file.name DESC
\`\`\`
`;
      await fs.writeFile(indexPath, newIndex, 'utf-8');
    }

    return {
      entityName,
      filePath
    };
  }
}