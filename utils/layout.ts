import path from 'path';

/**
 * Vault layout: folders are split by lifecycle (when an agent loads them),
 * while project / topic stays in frontmatter + tags so it can cut across folders.
 */
export const FOLDERS = {
  inbox: '00_Inbox',
  rules: '10_Rules',
  projects: '20_Projects',
  knowledge: '30_Knowledge',
  sessions: '40_Sessions',
  daily: '50_Daily',
  archive: '90_Archive',
  system: '_system',
} as const;

/** Sub folders inside 20_Projects/<project>/ */
export const PROJECT_SUB = {
  state: 'state',
  decisions: 'decisions',
  notes: 'notes',
} as const;

/** Sub folders inside 30_Knowledge/ */
export const KNOWLEDGE_SUB = {
  tips: 'tips',
  antipatterns: 'antipatterns',
  reference: 'reference',
} as const;

/** Directories (relative to the vault) never scanned as memory. */
export const IGNORED_DIRS = [
  `${FOLDERS.system}/templates`,
  'node_modules',
];

const RULE_TYPES = new Set(['rule', 'rules', 'feedback', 'user', 'preference']);
const SESSION_TYPES = new Set(['session']);
const DAILY_TYPES = new Set(['daily']);
const SYSTEM_TYPES = new Set(['index', 'moc', 'system']);
const STATE_TYPES = new Set(['state', 'handoff', 'todo', 'progress', 'status']);
const DECISION_TYPES = new Set(['decision', 'design', 'adr', 'policy']);
const TIP_TYPES = new Set(['tip', 'tips', 'howto', 'how-to']);
const ANTIPATTERN_TYPES = new Set(['antipattern', 'anti-pattern', 'pitfall', 'trap']);
const REFERENCE_TYPES = new Set(['reference', 'environment', 'env']);

const DATE_NAME = /^(\d{4})-(\d{2})-\d{2}$/;
const SESSION_NAME = /^Session (\d{4})-(\d{2})-\d{2}/;

/** Normalize a project name into a folder-safe slug ("GEX Japan App" -> "gex-japan-app"). */
export function normalizeProject(project: string | undefined | null): string | undefined {
  if (!project) return undefined;
  const slug = String(project)
    .trim()
    .replace(/^#?project\//, '')
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || undefined;
}

/** First `project/<x>` tag, if any. */
export function projectFromTags(tags: string[] | undefined): string | undefined {
  if (!tags) return undefined;
  for (const t of tags) {
    const m = String(t).trim().replace(/^#/, '').match(/^project\/(.+)$/);
    if (m) return normalizeProject(m[1]);
  }
  return undefined;
}

export interface FolderInput {
  name: string;
  entityType?: string;
  project?: string;
  now?: Date;
}

/**
 * Decide the vault-relative folder for a note.
 * Rule of thumb encoded here: if the note still makes sense without the project
 * name, the caller omits `project` and it lands in 30_Knowledge; otherwise it
 * goes under 20_Projects/<project>/.
 */
export function resolveFolder(input: FolderInput): string {
  const type = (input.entityType || '').toLowerCase().trim();
  const project = normalizeProject(input.project);
  const now = input.now || new Date();

  if (SESSION_TYPES.has(type) || SESSION_NAME.test(input.name)) {
    const m = input.name.match(SESSION_NAME);
    const y = m ? m[1] : String(now.getFullYear());
    const mo = m ? m[2] : String(now.getMonth() + 1).padStart(2, '0');
    return path.posix.join(FOLDERS.sessions, y, `${y}-${mo}`);
  }
  if (DAILY_TYPES.has(type) || DATE_NAME.test(input.name)) return FOLDERS.daily;
  if (SYSTEM_TYPES.has(type)) return FOLDERS.system;
  if (RULE_TYPES.has(type)) return FOLDERS.rules;

  const inProject = (sub: string) => path.posix.join(FOLDERS.projects, project!, sub);

  if (STATE_TYPES.has(type)) return project ? inProject(PROJECT_SUB.state) : FOLDERS.inbox;
  if (DECISION_TYPES.has(type)) return project ? inProject(PROJECT_SUB.decisions) : FOLDERS.inbox;
  if (TIP_TYPES.has(type)) {
    return project ? inProject(PROJECT_SUB.notes) : path.posix.join(FOLDERS.knowledge, KNOWLEDGE_SUB.tips);
  }
  if (ANTIPATTERN_TYPES.has(type)) {
    return project ? inProject(PROJECT_SUB.notes) : path.posix.join(FOLDERS.knowledge, KNOWLEDGE_SUB.antipatterns);
  }
  if (REFERENCE_TYPES.has(type)) {
    return project ? inProject(PROJECT_SUB.notes) : path.posix.join(FOLDERS.knowledge, KNOWLEDGE_SUB.reference);
  }
  // "project", "note", unknown ...
  return project ? inProject(PROJECT_SUB.notes) : FOLDERS.inbox;
}

/**
 * Validate a caller-supplied vault-relative folder. Returns a normalized posix path
 * ('' for the vault root). Throws if it escapes the vault or touches a hidden dir.
 */
export function sanitizeRelativeFolder(folder: string): string {
  const raw = String(folder).trim().replace(/\\/g, '/');
  if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`folder must be relative to the vault: ${folder}`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\/?/, '').replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return '';
  const parts = normalized.split('/');
  if (parts.some(p => p === '..' || p.startsWith('.'))) {
    throw new Error(`folder must stay inside the vault and not use hidden dirs: ${folder}`);
  }
  return normalized;
}
