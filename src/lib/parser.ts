import { readdir, readFile } from 'fs/promises';
import { join, basename, dirname, resolve, relative } from 'path';
import matter from 'gray-matter';
import {
  extractWikiLinks,
  buildStemLookup,
  resolveLink,
} from './wiki-links.js';
import type { ParsedNode, ParsedEdge, EdgeType } from './types.js';

const EXCLUDED_DIRS = new Set(['.obsidian', '_FileOrganizer2000', 'attachments']);

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  stubIds: Set<string>;
}

export async function parseVault(vaultPath: string): Promise<ParseResult> {
  const mdPaths = await collectMarkdownFiles(vaultPath);
  const stemLookup = buildStemLookup(mdPaths);
  const allPathsSet = new Set(mdPaths);
  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];
  const stubIds = new Set<string>();

  for (const relPath of mdPaths) {
    const absPath = join(vaultPath, relPath);
    const raw = await readFile(absPath, 'utf-8');

    let fm: Record<string, unknown>;
    let content: string;
    try {
      const parsed = matter(raw);
      fm = parsed.data;
      content = parsed.content;
    } catch {
      // Malformed YAML frontmatter — treat entire file as content
      console.warn(`Malformed frontmatter in ${relPath}, treating as plain markdown`);
      fm = {};
      content = raw;
    }

    const title = (fm.title as string)
      ?? basename(relPath, '.md');

    const inlineTags = extractInlineTags(content);
    const frontmatter = { ...fm };
    if (inlineTags.length > 0) {
      frontmatter.inline_tags = inlineTags;
    }

    nodes.push({ id: relPath, title, content, frontmatter });

    const links = extractWikiLinks(content);
    const paragraphs = content.split(/\n\n+/);

    for (const link of links) {
      const targetId = resolveLink(link.raw, stemLookup, allPathsSet);
      const resolvedTarget = targetId ?? `_stub/${link.raw}.md`;

      if (!targetId) {
        stubIds.add(resolvedTarget);
      }

      const context = paragraphs.find(p => p.includes(`[[${link.raw}`))
        ?? paragraphs.find(p => p.includes(link.display ?? link.raw))
        ?? '';

      edges.push({
        sourceId: relPath,
        targetId: resolvedTarget,
        context: context.trim(),
        edgeType: 'wiki-link',
      });
    }

    // Unit 2: Extract frontmatter `related` and `origin` edges
    for (const edge of extractFrontmatterEdges(relPath, fm, allPathsSet)) {
      edges.push(edge);
    }

    // Unit 3: Extract inline markdown link edges (skip daily-log.md)
    if (basename(relPath) !== 'daily-log.md') {
      for (const edge of extractMarkdownLinkEdges(relPath, content, allPathsSet)) {
        edges.push(edge);
      }
    }
  }

  return { nodes, edges, stubIds };
}

/** Unit 2: Extract edges from frontmatter `related` and `origin` fields */
function extractFrontmatterEdges(
  sourceId: string,
  fm: Record<string, unknown>,
  allPaths: Set<string>,
): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const sourceDir = dirname(sourceId);

  // related: array of paths
  const related = fm.related;
  if (Array.isArray(related)) {
    for (const ref of related) {
      if (typeof ref !== 'string') continue;
      const targetId = resolveVaultPath(ref, sourceDir, allPaths);
      if (targetId) {
        edges.push({ sourceId, targetId, context: `related: ${ref}`, edgeType: 'related' });
      }
    }
  }

  // origin: single path
  const origin = fm.origin;
  if (typeof origin === 'string' && origin.trim()) {
    const targetId = resolveVaultPath(origin, sourceDir, allPaths);
    if (targetId) {
      edges.push({ sourceId, targetId, context: `origin: ${origin}`, edgeType: 'origin' });
    }
  }

  return edges;
}

/** Unit 3: Extract edges from inline markdown links [text](path) between vault files */
function extractMarkdownLinkEdges(
  sourceId: string,
  content: string,
  allPaths: Set<string>,
): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const sourceDir = dirname(sourceId);
  const paragraphs = content.split(/\n\n+/);

  // Strip code blocks before scanning for links
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');

  // Match [text](path) — skip external URLs and anchor-only links
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(stripped)) !== null) {
    const path = match[2];
    // Skip external URLs, anchor-only, and mailto links
    if (/^(https?:|mailto:|#)/.test(path)) continue;

    // Strip anchor fragment from path
    const cleanPath = path.split('#')[0];
    if (!cleanPath) continue;

    const targetId = resolveVaultPath(cleanPath, sourceDir, allPaths);
    if (targetId) {
      const ctx = paragraphs.find(p => p.includes(match![0])) ?? '';
      edges.push({ sourceId, targetId, context: ctx.trim(), edgeType: 'markdown-link' });
    }
  }

  return edges;
}

/** Resolve a path reference to a vault-relative node ID */
function resolveVaultPath(
  ref: string,
  sourceDir: string,
  allPaths: Set<string>,
): string | undefined {
  // Clean up the reference
  let cleaned = ref.trim();

  // Strip ~/wp/ or similar vault root prefixes
  cleaned = cleaned.replace(/^~\/wp\//, '');

  // Resolve relative paths against the source file's directory
  let candidate: string;
  if (cleaned.startsWith('/') || cleaned.startsWith('~')) {
    // Absolute-ish path — treat as vault-relative after stripping prefix
    candidate = cleaned.replace(/^[~/]+/, '');
  } else {
    // Relative path — resolve from source directory
    const resolved = resolve('/', sourceDir, cleaned);
    candidate = resolved.startsWith('/') ? resolved.slice(1) : resolved;
  }

  // Try with and without .md extension
  if (allPaths.has(candidate)) return candidate;
  if (!candidate.endsWith('.md') && allPaths.has(candidate + '.md')) return candidate + '.md';
  if (candidate.endsWith('.md')) {
    const without = candidate.slice(0, -3);
    if (allPaths.has(without)) return without;
  }

  return undefined;
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const pattern = /(?<!\w)#([a-zA-Z][\w-\/]*)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

async function collectMarkdownFiles(
  vaultPath: string,
  subdir = '',
): Promise<string[]> {
  const results: string[] = [];
  const dirPath = join(vaultPath, subdir);
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await collectMarkdownFiles(vaultPath, relPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(relPath);
    }
  }

  return results;
}
