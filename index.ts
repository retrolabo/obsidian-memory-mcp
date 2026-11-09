#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Entity, Relation, NodeFilter, UpdateEntityParams } from './types.js';
import { MarkdownStorageManager } from './storage/MarkdownStorageManager.js';

// Create Markdown storage manager
const storageManager = new MarkdownStorageManager();


const LAYOUT_GUIDE = `Notes are placed automatically by entityType + project:
- rule / feedback / user -> 10_Rules (always-load behaviour rules)
- state / handoff / todo -> 20_Projects/<project>/state (overwrite-style current status)
- decision / design / policy -> 20_Projects/<project>/decisions (mark old ones status=superseded)
- tip / antipattern / reference -> 30_Knowledge/{tips,antipatterns,reference} when cross-project (omit project),
  or 20_Projects/<project>/notes when it only makes sense for that project
- project / note / other -> 20_Projects/<project>/notes
- session -> 40_Sessions/YYYY/YYYY-MM, daily -> 50_Daily, index -> _system
- anything without a project that needs one -> 00_Inbox
Rule of thumb: if the note still makes sense with the project name removed, omit project.
Names must be unique across the whole vault (Obsidian links by name).`;

const FILTER_PROPS = {
  folder: { type: "string", description: "Vault-relative folder prefix, e.g. '10_Rules', '20_Projects/reton', '30_Knowledge/antipatterns'" },
  entityType: { type: "string", description: "Exact entityType (case-insensitive)" },
  project: { type: "string", description: "Project slug, e.g. 'reton'" },
  status: { type: "string", description: "Status, e.g. 'active' (notes without status count as active) or 'superseded'" },
  tag: { type: "string", description: "Tag (matches the tag itself and its children, e.g. 'project' matches 'project/reton')" },
  includeArchived: { type: "boolean", description: "Include notes in 90_Archive (default false)" },
};

const pickFilter = (a: any): NodeFilter => ({
  folder: a?.folder, entityType: a?.entityType, project: a?.project,
  status: a?.status, tag: a?.tag, includeArchived: a?.includeArchived,
});

// The server instance and tools exposed to Claude
const server = new Server({
  name: "memory-server",
  version: "0.6.3",
},    {
    capabilities: {
      tools: {},
    },
  },);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_entities",
        description: `Create multiple new entities (notes) in the knowledge graph.\n${LAYOUT_GUIDE}`,
        inputSchema: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "The name of the entity" },
                  entityType: { type: "string", description: "The type of the entity" },
                  observations: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "An array of observation contents associated with the entity"
                  },
                  tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional tags for the entity (e.g. ['project/smb', 'tips', 'session'])"
                  },
                  project: { type: "string", description: "Project slug (e.g. 'reton'). Decides the 20_Projects/<project>/ folder. Falls back to the first project/<x> tag." },
                  status: { type: "string", description: "Optional status, e.g. 'active' or 'superseded'" },
                  folder: { type: "string", description: "Optional vault-relative folder that overrides automatic placement" },
                },
                required: ["name", "entityType", "observations"],
              },
            },
          },
          required: ["entities"],
        },
      },
      {
        name: "create_relations",
        description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "add_observations",
        description: "Add new observations to existing entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            observations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity to add the observations to" },
                  contents: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "An array of observation contents to add"
                  },
                },
                required: ["entityName", "contents"],
              },
            },
          },
          required: ["observations"],
        },
      },
      {
        name: "delete_entities",
        description: "Delete multiple entities and their associated relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entityNames: { 
              type: "array", 
              items: { type: "string" },
              description: "An array of entity names to delete" 
            },
          },
          required: ["entityNames"],
        },
      },
      {
        name: "delete_observations",
        description: "Delete specific observations from entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            deletions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity containing the observations" },
                  observations: { 
                    type: "array", 
                    items: { type: "string" },
                    description: "An array of observations to delete"
                  },
                },
                required: ["entityName", "observations"],
              },
            },
          },
          required: ["deletions"],
        },
      },
      {
        name: "delete_relations",
        description: "Delete multiple relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            relations: { 
              type: "array", 
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
              description: "An array of relations to delete" 
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "read_graph",
        description: "Read the knowledge graph (optionally filtered by folder / entityType / project / status / tag). Archived notes are excluded unless includeArchived is true.",
        inputSchema: {
          type: "object",
          properties: { ...FILTER_PROPS },
        },
      },
      {
        name: "search_nodes",
        description: "Search for nodes in the knowledge graph based on a query",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query to match against entity names, types, tags, project and observation content (empty string = filters only)" },
            ...FILTER_PROPS,
          },
          required: ["query"],
        },
      },
      {
        name: "open_nodes",
        description: "Open specific nodes in the knowledge graph by their names",
        inputSchema: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to retrieve",
            },
          },
          required: ["names"],
        },
      },
      {
        name: "list_nodes",
        description: "List notes without their observations (name, entityType, project, status, tags, updated, path). Use it to decide what to open, e.g. folder='10_Rules' at session start or project='reton' when resuming a project.",
        inputSchema: {
          type: "object",
          properties: { ...FILTER_PROPS },
        },
      },
      {
        name: "update_entities",
        description: `Update note metadata (entityType / project / status / tags) and/or move notes between folders. Changing entityType or project relocates the note to its new automatic folder unless relocate=false. Pass folder to move explicitly (e.g. '90_Archive' or '30_Knowledge/antipatterns'). Links keep working since Obsidian resolves by name.\n${LAYOUT_GUIDE}`,
        inputSchema: {
          type: "object",
          properties: {
            updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Entity name" },
                  entityType: { type: "string" },
                  project: { type: ["string", "null"], description: "New project slug; null or '' removes it" },
                  status: { type: ["string", "null"], description: "New status; null or '' removes it" },
                  tags: { type: "array", items: { type: "string" }, description: "Replace tags" },
                  folder: { type: "string", description: "Vault-relative destination folder" },
                  relocate: { type: "boolean", description: "Recompute folder from entityType/project and move (default: true when entityType or project changes)" },
                },
                required: ["name"],
              },
            },
          },
          required: ["updates"],
        },
      },
      {
        name: "create_session_moc",
        description: "Create a structured Session MOC (Map of Content) note in Obsidian, automatically link it to the previous session, link related topics/entities, and prepend to Sessions Index.md",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short summary title of the session" },
            overview: { type: "string", description: "Comprehensive summary of the session" },
            parentSession: { type: "string", description: "Optional name of the parent session to branch/resume from (defaults to most recent session)" },
            topics: { type: "array", items: { type: "string" }, description: "List of topics or inquiries discussed" },
            decisions: { type: "array", items: { type: "string" }, description: "List of architectural or design decisions made" },
            tips: { type: "array", items: { type: "string" }, description: "List of tips, insights, or pitfalls discovered" },
            relatedEntities: { type: "array", items: { type: "string" }, description: "Names of entities to include in the Map of Content" },
            nextSteps: { type: "array", items: { type: "string" }, description: "Next steps or carry-overs for subsequent sessions" },
            tags: { type: "array", items: { type: "string" }, description: "Optional extra tags (e.g. ['project/smb'])" },
            project: { type: "string", description: "Optional project slug; adds project frontmatter, project/<x> tag and a link to the project hub note" }
          },
          required: ["title", "overview"],
        },
      },
      {
        name: "create_session",
        description: "Alias for create_session_moc. Create a structured Session MOC note in Obsidian, link parent session and related topics, and update Sessions Index.md",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short summary title of the session" },
            overview: { type: "string", description: "Comprehensive summary of the session" },
            parentSession: { type: "string", description: "Optional name of the parent session to branch/resume from (defaults to most recent session)" },
            topics: { type: "array", items: { type: "string" }, description: "List of topics or inquiries discussed" },
            decisions: { type: "array", items: { type: "string" }, description: "List of architectural or design decisions made" },
            tips: { type: "array", items: { type: "string" }, description: "List of tips, insights, or pitfalls discovered" },
            relatedEntities: { type: "array", items: { type: "string" }, description: "Names of entities to include in the Map of Content" },
            nextSteps: { type: "array", items: { type: "string" }, description: "Next steps or carry-overs for subsequent sessions" },
            tags: { type: "array", items: { type: "string" }, description: "Optional extra tags (e.g. ['project/smb'])" },
            project: { type: "string", description: "Optional project slug; adds project frontmatter, project/<x> tag and a link to the project hub note" }
          },
          required: ["title", "overview"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  const args = (request.params.arguments || {}) as Record<string, any>;

  switch (name) {
    case "create_entities":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.createEntities(args.entities as Entity[]), null, 2) }] };
    case "create_relations":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.createRelations(args.relations as Relation[]), null, 2) }] };
    case "add_observations":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.addObservations(args.observations as { entityName: string; contents: string[] }[]), null, 2) }] };
    case "delete_entities":
      await storageManager.deleteEntities(args.entityNames as string[]);
      return { content: [{ type: "text", text: "Entities deleted successfully" }] };
    case "delete_observations":
      await storageManager.deleteObservations(args.deletions as { entityName: string; observations: string[] }[]);
      return { content: [{ type: "text", text: "Observations deleted successfully" }] };
    case "delete_relations":
      await storageManager.deleteRelations(args.relations as Relation[]);
      return { content: [{ type: "text", text: "Relations deleted successfully" }] };
    case "read_graph":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.readGraph(pickFilter(args)), null, 2) }] };
    case "search_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.searchNodes(args.query as string, pickFilter(args)), null, 2) }] };
    case "open_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.openNodes(args.names as string[]), null, 2) }] };
    case "list_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.listNodes(pickFilter(args)), null, 2) }] };
    case "update_entities":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.updateEntities(args.updates as UpdateEntityParams[]), null, 2) }] };
    case "create_session_moc":
    case "create_session":
      return { content: [{ type: "text", text: JSON.stringify(await storageManager.createSessionMoc(args as any), null, 2) }] };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});


async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio (storage: markdown)");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});