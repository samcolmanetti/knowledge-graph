---
name: kg-index
description: Re-index the Obsidian vault knowledge graph
---

Re-index the knowledge graph by calling the `kg_index` MCP tool. Report the indexing stats (nodes indexed, edges, communities detected, stubs created) when complete.

If the index has never been built, this will do a full index. Otherwise it's incremental — only changed files are reprocessed.
