export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
  tags?: string[];
  created?: string;
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
}