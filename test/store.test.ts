import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/lib/store.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates schema on initialization', () => {
    const tables = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name);
    expect(tables).toContain('nodes');
    expect(tables).toContain('edges');
    expect(tables).toContain('communities');
    expect(tables).toContain('sync');
  });

  it('upserts and retrieves nodes', () => {
    store.upsertNode({
      id: 'test.md',
      title: 'Test',
      content: 'Hello world',
      frontmatter: { type: 'test' },
    });
    const node = store.getNode('test.md');
    expect(node).toBeDefined();
    expect(node!.title).toBe('Test');
    expect(node!.frontmatter).toEqual({ type: 'test' });
  });

  it('inserts and retrieves edges', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'A links to B' });
    const edges = store.getEdgesFrom('a.md');
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('b.md');
    expect(edges[0].context).toBe('A links to B');
  });

  it('allows multiple edges between the same pair', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'First mention' });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'Second mention' });
    const edges = store.getEdgesFrom('a.md');
    expect(edges).toHaveLength(2);
  });

  it('retrieves backlinks (edges targeting a node)', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'link' });
    const backlinks = store.getEdgesTo('b.md');
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].sourceId).toBe('a.md');
  });

  it('performs full-text search via FTS5', () => {
    store.upsertNode({
      id: 'test.md',
      title: 'Widget Theory',
      content: 'A framework for understanding component interactions',
      frontmatter: {},
    });
    const results = store.searchFullText('framework component');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].nodeId).toBe('test.md');
  });

  it('tracks sync state', () => {
    store.upsertSync('test.md', 1000);
    expect(store.getSyncMtime('test.md')).toBe(1000);
    store.upsertSync('test.md', 2000);
    expect(store.getSyncMtime('test.md')).toBe(2000);
  });

  it('deletes a node and cascades to edges', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'link' });
    store.deleteNode('a.md');
    expect(store.getNode('a.md')).toBeUndefined();
    expect(store.getEdgesFrom('a.md')).toHaveLength(0);
  });

  it('lists all node IDs', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    expect(store.allNodeIds()).toEqual(expect.arrayContaining(['a.md', 'b.md']));
  });
});
