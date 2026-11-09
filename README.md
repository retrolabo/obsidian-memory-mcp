# Obsidian Memory MCP

MCP server that stores AI memories as Markdown files for visualization in Obsidian's graph view.

<a href="https://glama.ai/mcp/servers/@YuNaga224/obsidian-memory-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@YuNaga224/obsidian-memory-mcp/badge" alt="Obsidian Memory MCP server" />
</a>

## About

This project is a modified version of [Anthropic's memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) that has been adapted for Obsidian integration. The original server stored memories in JSON format, while this version stores them as individual Markdown files with Obsidian-compatible `[[link]]` syntax for graph visualization.

### Key Changes from Original

- **Storage Format**: Changed from JSON to individual Markdown files
- **Obsidian Integration**: Added `[[link]]` syntax for relations
- **YAML Frontmatter**: Metadata stored in frontmatter instead of JSON
- **File Structure**: Each entity becomes a separate `.md` file
- **Removed Features**: Simplified to focus on Markdown-only storage

## Features

- **Markdown Storage**: Individual `.md` files for each entity
- **Obsidian Integration**: Uses `[[link]]` syntax for graph visualization
- **Knowledge Graph**: Store entities, relations, and observations
- **Search Functionality**: Query across all stored memories
- **YAML Frontmatter**: Metadata stored in frontmatter

## Storage Format

Each entity is stored as an individual Markdown file with:

- **YAML frontmatter** for metadata (entityType, created, updated)
- **Obsidian-compatible `[[links]]`** for relations
- **Organized sections** for observations and relations

Example entity file (`John_Doe.md`):
```markdown
---
entityType: person
created: 2025-07-10
updated: 2025-07-10
---

# John Doe

## Observations
- Works at Tech Corp
- Expert in TypeScript
- Lives in Tokyo

## Relations
- [[Manager of::Alice Smith]]
- [[Collaborates with::Bob Johnson]]
- [[Located in::Tokyo Office]]
```


## Vault Layout (folders)

Notes are no longer kept in one flat directory. The server scans the vault recursively,
resolves notes by **file name** (exactly like Obsidian's `[[links]]`, so names must be unique
across the vault and moving a file never breaks a link), and places new notes automatically.

Folders are split by *when an agent loads them*; project and topic stay in frontmatter/tags
so they can cut across folders.

```
00_Inbox/                    no project where one is needed — triage later
10_Rules/                    rule / feedback / user        (loaded every session)
20_Projects/<project>/
    state/                   state / handoff / todo        (overwrite-style "where we are")
    decisions/               decision / design / policy    (old ones get status: superseded)
    notes/                   project-specific tips, references and other notes
30_Knowledge/                cross-project knowledge (no project given)
    tips/ antipatterns/ reference/
40_Sessions/YYYY/YYYY-MM/    session MOCs (append-only)
50_Daily/                    YYYY-MM-DD notes
90_Archive/                  hidden from search/read_graph unless includeArchived
_system/                     Sessions Index, agent policy, migration logs (templates/ is ignored)
```

Placement rules live in [`utils/layout.ts`](utils/layout.ts). Rule of thumb for agents: *if the
note still makes sense with the project name removed, omit `project`* and it lands in
`30_Knowledge`. Pass `folder` to override placement.

Frontmatter written by the server:

```yaml
entityType: decision
project: reton            # optional; falls back to the first project/<x> tag
status: active            # optional; e.g. superseded, archived
created: '2026-11-10'
updated: '2026-11-10'
tags: [project/reton]
```

`add_observations` / `delete_observations` edit the `## Observations` section in place, so other
sections (e.g. a session MOC's overview and decisions), inline links and unknown frontmatter
keys are preserved.

### Migrating a flat vault

```bash
MEMORY_DIR=/path/to/vault npm run migrate             # dry run: prints the plan
MEMORY_DIR=/path/to/vault npm run migrate -- --apply  # moves files, writes _system/migrations/layout-*.json
MEMORY_DIR=/path/to/vault npm run migrate -- --revert /path/to/vault/_system/migrations/layout-XXXX.json
```

Only notes directly in the vault root are moved. Legacy notes typed `project`/`unknown` are
refined from their title (再開位置/引き継ぎ/TODO/進捗 → `state`, 方針/設計/決定 → `decision`) and
their `entityType` line is rewritten; `--revert` restores both location and type.

## Session-start Integration (Claude Code / Antigravity)

MCP tools are only used when an agent decides to call them, so nothing guarantees an agent
reads its rules. [`integrations/obsidian-rules-index.mjs`](integrations/obsidian-rules-index.mjs)
is a session-start hook that injects, for every session:

1. the shared memory policy from `<vault>/_system/agent-memory-policy.md`
   (frontmatter and `<!-- -->` editor notes are stripped), and
2. a compact index of `10_Rules` — title + first observation, grouped by project,
   skipping `superseded`/`archived` (a few KB instead of the full text).

It prints nothing (`{}` with `--agy`) when the vault is unreachable, so it never blocks startup.

**One policy, two agents.** Memory usage that applies to every agent lives only in the vault's
`_system/agent-memory-policy.md` (template: [`templates/agent-memory-policy.md`](templates/agent-memory-policy.md)).
Agent-specific instructions stay in each agent's own file — e.g. `~/.claude/CLAUDE.md`
(template: [`templates/CLAUDE.md`](templates/CLAUDE.md)) — and are never injected into the other agent.

Claude Code (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "MEMORY_DIR='/path/to/vault' node /full/path/to/obsidian-memory-mcp/integrations/obsidian-rules-index.mjs 2>/dev/null || true",
        "timeout": 15
      }]
    }]
  }
}
```

Antigravity (`~/.gemini/config/hooks.json`) — same script with `--agy`, which emits
`{"injectSteps":[{"systemMessage":{...}}]}`:

```json
{
  "obsidian-rules-index": {
    "SessionStart": [{
      "type": "command",
      "command": "MEMORY_DIR='/path/to/vault' node /full/path/to/obsidian-memory-mcp/integrations/obsidian-rules-index.mjs --agy 2>/dev/null || echo '{}'",
      "timeout": 15
    }]
  }
}
```

## Installation & Configuration


```bash
git clone https://github.com/YuNaga224/obsidian-memory-mcp.git
cd obsidian-memory-mcp
npm install
npm run build
```

Then configure in Claude Desktop:

```json
{
  "mcpServers": {
    "obsidian-memory": {
      "command": "node",
      "args": ["/full/path/to/obsidian-memory-mcp/dist/index.js"],
      "env": {
        "MEMORY_DIR": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

## Usage with Obsidian

1. Configure Claude Desktop with one of the options above
2. Restart Claude Desktop
3. Use the MCP memory tools to create entities and relations
4. Open Obsidian and view the graph

The knowledge graph will be visualized with:
- Entity files as nodes
- `[[links]]` as edges
- Different colors for different entity types (if configured in Obsidian)

## API

The server exposes the following tools:

- `create_entities`: Create new entities
- `create_relations`: Create relations between entities  
- `add_observations`: Add observations to existing entities
- `delete_entities`: Delete entities and related data
- `delete_observations`: Remove specific observations
- `delete_relations`: Remove relations
- `read_graph`: Get the knowledge graph (optional filters below)
- `search_nodes`: Search entities by query (optional filters below; empty query = filters only)
- `open_nodes`: Get specific entities by name (archived notes included)
- `list_nodes`: List notes without observations (name, type, project, status, tags, updated, path) — e.g. `folder: "10_Rules"` at session start
- `update_entities`: Change `entityType` / `project` / `status` / `tags` and/or move notes; changing type or project relocates the note unless `relocate: false`
- `create_session_moc` / `create_session`: Create a session MOC under `40_Sessions/YYYY/YYYY-MM/`, link the previous session and update `Sessions Index` (optional `project`)

Filters accepted by `read_graph`, `search_nodes` and `list_nodes`: `folder` (vault-relative prefix),
`entityType`, `project`, `status` (notes without one count as `active`), `tag` (matches children,
e.g. `project` matches `project/x`), `includeArchived`.

## Development

```bash
npm run watch  # Watch for changes and rebuild
npm test       # Build, then run the end-to-end smoke test against a throwaway vault
```

## Credits

This project is based on [Anthropic's memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) from the Model Context Protocol servers collection. We thank Anthropic for releasing the original implementation under the MIT license.

## License

MIT License - see [LICENSE](LICENSE) file for details.

Original memory server: Copyright (c) 2024 Anthropic, PBC  
Obsidian integration modifications: Copyright (c) 2025 YuNaga224