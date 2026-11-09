export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
  tags?: string[];
  created?: string;
  updated?: string;
  /** Project slug (frontmatter `project`), e.g. "reton". Falls back to the first project/<x> tag. */
  project?: string;
  /** active | superseded | archived ... (frontmatter `status`) */
  status?: string;
  /** Input only: vault-relative folder that overrides the automatic placement. */
  folder?: string;
  /** Output only: vault-relative path of the note file. */
  path?: string;
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

export interface CreateSessionMocParams {
  title: string;
  overview: string;
  parentSession?: string; // Explicit parent session to branch/resume from
  topics?: string[];
  decisions?: string[];
  tips?: string[];
  relatedEntities?: string[];
  nextSteps?: string[];
  tags?: string[];
  project?: string;
}

export interface NodeFilter {
  /** Vault-relative folder prefix, e.g. "10_Rules" or "20_Projects/reton" */
  folder?: string;
  entityType?: string;
  project?: string;
  status?: string;
  tag?: string;
  /** Include notes under 90_Archive (default false) */
  includeArchived?: boolean;
}

export interface NodeSummary {
  name: string;
  entityType: string;
  project?: string;
  status?: string;
  tags: string[];
  updated?: string;
  path: string;
}

export interface UpdateEntityParams {
  name: string;
  entityType?: string;
  project?: string | null;
  status?: string | null;
  tags?: string[];
  /** Move to this vault-relative folder. */
  folder?: string;
  /**
   * Re-compute the folder from entityType/project and move there.
   * Defaults to true when entityType or project changes and no folder is given.
   */
  relocate?: boolean;
}
