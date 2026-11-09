import matter from 'gray-matter';
import { Entity, Relation } from '../types.js';

interface MarkdownMetadata {
  entityType: string;
  tags?: string[];
  created?: string;
  updated?: string;
  project?: string;
  status?: string;
}

interface ParsedMarkdown {
  metadata: MarkdownMetadata;
  name: string;
  observations: string[];
  relations: Array<{
    to: string;
    relationType: string;
  }>;
}

/**
 * Parse a markdown file content into structured data
 */
export function parseMarkdown(content: string, entityName: string): ParsedMarkdown {
  const parsed = matter(content);

  // Extract and normalize tags from frontmatter
  let tags: string[] = [];
  const rawTags = (parsed.data as any)?.tags;
  if (Array.isArray(rawTags)) {
    tags = rawTags.map(t => String(t).trim().replace(/^#/, '')).filter(Boolean);
  } else if (typeof rawTags === 'string') {
    tags = rawTags.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
  }

  const metadata: MarkdownMetadata = {
    entityType: (parsed.data as any)?.entityType || 'unknown',
    tags,
    created: (parsed.data as any)?.created,
    updated: (parsed.data as any)?.updated,
    project: (parsed.data as any)?.project ? String((parsed.data as any).project) : undefined,
    status: (parsed.data as any)?.status ? String((parsed.data as any).status) : undefined,
  };
  
  // Extract observations from the content
  const observations: string[] = [];
  const relations: Array<{ to: string; relationType: string }> = [];
  
  // Split content into lines for processing
  const lines = parsed.content.split('\n');
  let inObservations = false;
  let inRelations = false;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Check for section headers
    if (trimmed === '## Observations' || trimmed === '### Observations') {
      inObservations = true;
      inRelations = false;
      continue;
    } else if (trimmed === '## Relations' || trimmed === '### Relations') {
      inObservations = false;
      inRelations = true;
      continue;
    } else if (trimmed.startsWith('##') || trimmed.startsWith('###')) {
      // Another section started
      inObservations = false;
      inRelations = false;
    }
    
    // Extract observations (bullet points)
    if (inObservations && (trimmed.startsWith('- ') || trimmed.startsWith('* '))) {
      observations.push(trimmed.substring(2));
    }
    
    // Extract relations (Obsidian links)
    if (inRelations && (trimmed.startsWith('- ') || trimmed.startsWith('* '))) {
      const linkMatch = trimmed.match(/\[\[([^:\]]+)(?:::([^\]]+))?\]\]/);
      if (linkMatch) {
        if (linkMatch[2]) {
          // Format: [[relationType::target]]
          relations.push({
            to: linkMatch[2],
            relationType: linkMatch[1]
          });
        } else {
          // Format: [[target]] - default relation type
          relations.push({
            to: linkMatch[1],
            relationType: 'related_to'
          });
        }
      }
    }
    
    // Also check for inline links anywhere in the content
    const inlineLinks = trimmed.matchAll(/\[\[([^:\]]+)(?:::([^\]]+))?\]\]/g);
    for (const match of inlineLinks) {
      if (!inRelations) { // Avoid duplicates from the Relations section
        if (match[2]) {
          relations.push({
            to: match[2],
            relationType: match[1]
          });
        } else {
          relations.push({
            to: match[1],
            relationType: 'mentioned_in'
          });
        }
      }
    }
  }
  
  return {
    metadata,
    name: entityName,
    observations,
    relations
  };
}

/**
 * Derive automatic tags based on entity name and type
 */
export function deriveAutoTags(name: string, entityType: string): string[] {
  const tags = new Set<string>();
  const lowerType = (entityType || '').toLowerCase().trim();
  const lowerName = (name || '').toLowerCase().trim();

  if (lowerType) {
    tags.add(lowerType);
  }

  // Derive project tags
  if (lowerName.includes('smb')) {
    tags.add('project/smb');
  }
  if (lowerName.includes('reton')) {
    tags.add('project/reton');
  }
  if (lowerName.includes('msx')) {
    tags.add('project/msx');
  }

  // Derive category tags
  if (lowerName.startsWith('session ') || lowerName.includes('セッション') || lowerType === 'session') {
    tags.add('session');
  }
  if (lowerName.includes('tips') || lowerName.includes('落とし穴')) {
    tags.add('tips');
  }
  if (lowerName.includes('再開位置') || lowerName.includes('引き継ぎ')) {
    tags.add('state');
  }
  if (lowerName.includes('決まり') || lowerName.includes('方針') || lowerType === 'rule') {
    tags.add('rule');
  }
  if (lowerName.includes('検査') || lowerName.includes('設定') || lowerName.includes('環境')) {
    tags.add('reference');
  }

  return Array.from(tags);
}

/**
 * Generate markdown content from an entity
 */
export function generateMarkdown(entity: Entity, relations: Relation[]): string {
  const now = new Date().toISOString().split('T')[0];

  // Prepare tags: if explicitly provided, use them; otherwise auto-derive
  const tagsSet = new Set<string>();
  if (entity.tags && Array.isArray(entity.tags) && entity.tags.length > 0) {
    entity.tags.forEach(t => tagsSet.add(t.trim().replace(/^#/, '')));
  } else {
    deriveAutoTags(entity.name, entity.entityType).forEach(t => tagsSet.add(t));
  }

  // Prepare frontmatter
  const frontmatter: Record<string, any> = {
    entityType: entity.entityType,
    created: entity.created || now,
    updated: now
  };
  if (entity.project) frontmatter.project = entity.project;
  if (entity.status) frontmatter.status = entity.status;

  if (tagsSet.size > 0) {
    frontmatter.tags = Array.from(tagsSet);
  }

  // Build content sections
  let content = matter.stringify('', frontmatter);
  
  // Add title
  content += `# ${entity.name}\n\n`;
  
  // Add observations
  if (entity.observations.length > 0) {
    content += `## Observations\n`;
    for (const observation of entity.observations) {
      content += `- ${observation}\n`;
    }
    content += '\n';
  }
  
  // Add relations
  const entityRelations = relations.filter(r => r.from === entity.name);
  if (entityRelations.length > 0) {
    content += `## Relations\n`;
    for (const relation of entityRelations) {
      content += `- [[${relation.relationType}::${relation.to}]]\n`;
    }
    content += '\n';
  }
  
  return content;
}

/**
 * Update the metadata section of a markdown file
 */
export function updateMetadata(content: string, updates: Partial<MarkdownMetadata>): string {
  const parsed = matter(content);
  const updatedData = { ...parsed.data, ...updates };
  
  // Update the 'updated' timestamp
  updatedData.updated = new Date().toISOString().split('T')[0];
  
  return matter.stringify(parsed.content, updatedData);
}

/**
 * Add a relation link to the content
 */
export function addRelationToContent(content: string, relation: Relation): string {
  const lines = content.split('\n');
  let relationsIndex = -1;
  let lastRelationIndex = -1;
  
  // Find the Relations section
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '## Relations' || trimmed === '### Relations') {
      relationsIndex = i;
    } else if (relationsIndex !== -1 && (trimmed.startsWith('- ') || trimmed.startsWith('* '))) {
      lastRelationIndex = i;
    } else if (relationsIndex !== -1 && trimmed.startsWith('#')) {
      // Another section started
      break;
    }
  }
  
  const newRelationLine = `- [[${relation.relationType}::${relation.to}]]`;
  
  if (relationsIndex === -1) {
    // No Relations section exists, create one
    lines.push('');
    lines.push('## Relations');
    lines.push(newRelationLine);
  } else if (lastRelationIndex !== -1) {
    // Add after the last relation
    lines.splice(lastRelationIndex + 1, 0, newRelationLine);
  } else {
    // Add right after the Relations header
    lines.splice(relationsIndex + 1, 0, newRelationLine);
  }
  
  return lines.join('\n');
}

/**
 * Remove a relation link from the content
 */
export function removeRelationFromContent(content: string, relation: Relation): string {
  const linkPattern = new RegExp(
    `^[\\s\\-\\*]*\\[\\[${escapeRegExp(relation.relationType)}::${escapeRegExp(relation.to)}\\]\\]\\s*$`,
    'gm'
  );
  
  return content.replace(linkPattern, '');
}

/** Locate the Observations section: [headerIndex, endIndexExclusive] or null. */
function findSection(lines: string[], names: string[]): [number, number] | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (start === -1) {
      if (names.some(n => t === `## ${n}` || t === `### ${n}`)) start = i;
    } else if (/^#{1,6}\s/.test(t)) {
      return [start, i];
    }
  }
  return start === -1 ? null : [start, lines.length];
}

/**
 * Append observation bullets to the Observations section in place, keeping every
 * other section (and the frontmatter) untouched. Creates the section if missing,
 * right before "## Relations" when that exists.
 */
export function appendObservationsToContent(content: string, observations: string[]): string {
  if (observations.length === 0) return content;
  const lines = content.split('\n');
  const bullets = observations.map(o => `- ${o}`);
  const sec = findSection(lines, ['Observations']);
  if (sec) {
    let last = sec[0];
    for (let i = sec[0] + 1; i < sec[1]; i++) {
      if (lines[i].trim() !== '') last = i;
    }
    lines.splice(last + 1, 0, ...bullets);
    return lines.join('\n');
  }
  const rel = findSection(lines, ['Relations']);
  if (rel) {
    lines.splice(rel[0], 0, '## Observations', ...bullets, '');
    return lines.join('\n');
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push('', '## Observations', ...bullets, '');
  return lines.join('\n');
}

/** Remove matching observation bullets from the Observations section in place. */
export function removeObservationsFromContent(content: string, observations: string[]): string {
  const targets = new Set(observations);
  const lines = content.split('\n');
  const sec = findSection(lines, ['Observations']);
  if (!sec) return content;
  const kept: string[] = [];
  lines.forEach((line, i) => {
    if (i > sec[0] && i < sec[1]) {
      const t = line.trim();
      if ((t.startsWith('- ') || t.startsWith('* ')) && targets.has(t.substring(2))) return;
    }
    kept.push(line);
  });
  return kept.join('\n');
}

/**
 * Merge frontmatter fields (null/undefined-valued keys in `remove` are deleted)
 * and bump `updated`, preserving the body and any frontmatter keys we don't own.
 */
export function mergeFrontmatter(content: string, set: Record<string, any>, remove: string[] = []): string {
  const parsed = matter(content);
  const data: Record<string, any> = { ...(parsed.data as Record<string, any>) };
  for (const [k, v] of Object.entries(set)) {
    if (v !== undefined) data[k] = v;
  }
  for (const k of remove) delete data[k];
  data.updated = new Date().toISOString().split('T')[0];
  return matter.stringify(parsed.content, data);
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}