import { stat } from 'fs/promises';
import { join } from 'path';
import { parseVault } from './parser.js';
import type { Store } from './store.js';
import { Embedder } from './embedder.js';
import type { ParsedNode, EdgeType } from './types.js';
import { KnowledgeGraph } from './graph.js';

export interface IndexStats {
  nodesIndexed: number;
  nodesSkipped: number;
  edgesIndexed: number;
  communitiesDetected: number;
  stubNodesCreated: number;
}

export class IndexPipeline {
  constructor(
    private store: Store,
    private embedder: Embedder,
  ) {}

  async index(vaultPath: string, resolution = 1.0): Promise<IndexStats> {
    const stats: IndexStats = {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
    };

    const { nodes, edges, stubIds } = await parseVault(vaultPath);
    const previousPaths = this.store.getAllSyncPaths();

    // Detect deleted files
    const currentPaths = new Set(nodes.map(n => n.id));
    for (const oldPath of previousPaths) {
      if (!currentPaths.has(oldPath)) {
        this.store.deleteNode(oldPath);
      }
    }

    // Index nodes (incremental)
    for (const node of nodes) {
      const fileStat = await stat(join(vaultPath, node.id));
      const mtime = fileStat.mtimeMs;
      const prevMtime = this.store.getSyncMtime(node.id);

      if (prevMtime !== undefined && prevMtime >= mtime) {
        stats.nodesSkipped++;
        continue;
      }

      this.store.upsertNode(node);

      // Compute and store embedding
      const tags = Array.isArray(node.frontmatter.tags) ? node.frontmatter.tags : [];
      const text = Embedder.buildEmbeddingText(node.title, tags as string[], node.content);
      const embedding = await this.embedder.embed(text);
      this.store.upsertEmbedding(node.id, embedding);

      // Re-index edges from this node
      this.store.deleteAllEdgesFrom(node.id);
      for (const edge of edges.filter(e => e.sourceId === node.id)) {
        this.store.insertEdge(edge);
        stats.edgesIndexed++;
      }

      this.store.upsertSync(node.id, mtime);
      stats.nodesIndexed++;
    }

    // Unit 4: Create hub nodes for shared attributes (tags, category, components)
    await this.createHubNodes(nodes, stats);

    // Create stub nodes
    for (const stubId of stubIds) {
      if (!this.store.getNode(stubId)) {
        this.store.upsertNode({
          id: stubId,
          title: stubId.replace('_stub/', '').replace('.md', ''),
          content: '',
          frontmatter: { _stub: true },
        });
        stats.stubNodesCreated++;
      }
    }

    // If any nodes were indexed, re-run community detection
    if (stats.nodesIndexed > 0 || stats.stubNodesCreated > 0) {
      const kg = KnowledgeGraph.fromStore(this.store);
      const communities = kg.detectCommunities(resolution);
      this.store.clearCommunities();
      for (const c of communities) {
        this.store.upsertCommunity(c);
      }
      stats.communitiesDetected = communities.length;
    }

    return stats;
  }

  /** Unit 4: Create hub nodes for shared tags, categories, and components */
  private async createHubNodes(nodes: ParsedNode[], stats: IndexStats): Promise<void> {
    const hubConfigs: Array<{ field: string; prefix: string; edgeType: EdgeType }> = [
      { field: 'tags', prefix: '_tag', edgeType: 'tag' },
      { field: 'category', prefix: '_category', edgeType: 'category' },
      { field: 'components', prefix: '_component', edgeType: 'component' },
    ];

    for (const { field, prefix, edgeType } of hubConfigs) {
      // Collect values → member node IDs
      const valueToMembers = new Map<string, string[]>();

      for (const node of nodes) {
        const raw = node.frontmatter[field];
        const values: string[] = Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === 'string')
          : typeof raw === 'string' ? [raw] : [];

        for (const val of values) {
          const normalized = val.trim().toLowerCase();
          if (!normalized) continue;
          const members = valueToMembers.get(normalized) ?? [];
          members.push(node.id);
          valueToMembers.set(normalized, members);
        }
      }

      // Create hub nodes and edges
      for (const [value, memberIds] of valueToMembers) {
        const hubId = `${prefix}/${value}`;
        const memberTitles = memberIds
          .map(id => nodes.find(n => n.id === id)?.title ?? id)
          .slice(0, 10);
        const content = `Documents with ${field}: ${value}\n\n${memberTitles.map(t => `- ${t}`).join('\n')}`;

        this.store.upsertNode({
          id: hubId,
          title: `${value} (${field})`,
          content,
          frontmatter: { _hub: true, _hubType: field, _hubValue: value },
        });

        // Embed the hub node
        const text = Embedder.buildEmbeddingText(`${value} (${field})`, [], content);
        const embedding = await this.embedder.embed(text);
        this.store.upsertEmbedding(hubId, embedding);

        // Create edges from each member to the hub
        this.store.deleteAllEdgesFrom(hubId);
        for (const memberId of memberIds) {
          this.store.insertEdge({
            sourceId: memberId,
            targetId: hubId,
            context: `${field}: ${value}`,
            edgeType,
          });
          stats.edgesIndexed++;
        }
      }
    }
  }
}
