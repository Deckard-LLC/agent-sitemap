// Pages → graph: page and section nodes, and typed edges between them.
//   contains  page → its sections            next     section → following section
//   links     a link written in the content  lists    a listing page → the pages it lists
//   related   similar content on another page (TF-IDF cosine, no model involved)
import type { Page } from "./parse.ts";
import { estimateTokens, plain, summarize, terms } from "./text.ts";

export type EdgeKind = "contains" | "next" | "links" | "lists" | "related";

export interface GraphNode {
  /** Path of the note inside the map, without .md: «blog/slug» or «blog/slug/section». */
  id: string;
  type: "page" | "section";
  title: string;
  summary: string;
  /** Canonical human URL of the page (sections share their page's URL). */
  url: string;
  /** Estimated tokens of the content the note carries (a page: the whole page). */
  tokens: number;
  page: string;
  body?: string;
  /** From the LLM pass: when an agent should open this note («нужно оценить бюджет…»). */
  when?: string;
  /** The summary is the author's own: the LLM pass leaves it as is. */
  authored?: boolean;
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Similarity for «related» edges. */
  score?: number;
  /** From the LLM pass: what following the link adds for a reader of the source note. */
  why?: string;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Edge[];
  pages: Page[];
  /** Page key → node id. */
  pageIds: Map<string, string>;
  /** Section headings dropped because they repeat across pages (navigation, CTAs). */
  boilerplate: string[];
}

export interface GraphOptions {
  relatedPerSection?: number;
  relatedPerPage?: number;
  minScore?: number;
}

export function pageId(key: string): string {
  if (key === "/") return "home";
  return key.replace(/^\/+/, "").replace(/[^\p{L}\p{N}/_-]+/gu, "-");
}

/** Section headings found on many pages are template parts, not content. */
export function findBoilerplate(pages: Page[]): Set<string> {
  const count = new Map<string, number>();
  for (const page of pages) {
    for (const title of new Set(page.sections.map((s) => normalize(s.title)))) count.set(title, (count.get(title) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.25));
  return new Set([...count].filter(([, n]) => n >= threshold).map(([title]) => title));
}

const normalize = (title: string) => title.toLowerCase().replace(/\s+/g, " ").trim();

export function buildGraph(input: Page[], options: GraphOptions = {}): Graph {
  const { relatedPerSection = 3, relatedPerPage = 4, minScore = 0.12 } = options;
  const boilerplate = findBoilerplate(input);
  const pages = input.map((page) => ({
    ...page,
    sections: page.sections.filter((s) => !boilerplate.has(normalize(s.title)) && plain(s.body).length >= 40),
  }));

  const nodes = new Map<string, GraphNode>();
  const edges: Edge[] = [];
  const pageIds = new Map(pages.map((page) => [page.key, pageId(page.key)]));

  for (const page of pages) {
    const id = pageIds.get(page.key)!;
    const full = [page.title, page.intro, ...page.sections.map((s) => `${s.title}\n${s.body}`)].join("\n\n");
    nodes.set(id, {
      id,
      type: "page",
      title: page.title,
      summary: page.summary,
      ...(page.authoredSummary ? { authored: true } : {}),
      url: page.url,
      tokens: estimateTokens(full),
      page: id,
      body: page.intro,
    });
    let previous: string | null = null;
    for (const section of page.sections) {
      const sid = `${id}/${section.slug}`;
      nodes.set(sid, {
        id: sid,
        type: "section",
        title: section.title,
        summary: summarize(section.body),
        url: page.url,
        tokens: estimateTokens(section.body),
        page: id,
        body: section.body,
      });
      edges.push({ from: id, to: sid, kind: "contains" });
      if (previous) edges.push({ from: previous, to: sid, kind: "next" });
      previous = sid;
      for (const key of section.links) {
        const target = pageIds.get(key);
        if (target && target !== id) edges.push({ from: sid, to: target, kind: "links" });
      }
    }
    for (const { key, under } of page.lists) {
      if (under && boilerplate.has(normalize(under))) continue; // «More from the blog» on every post
      const target = pageIds.get(key);
      if (target && target !== id) edges.push({ from: id, to: target, kind: "lists" });
    }
  }

  // Similar sections on other pages, and similar pages overall.
  const sections = [...nodes.values()].filter((n) => n.type === "section");
  const sectionVectors = vectors(sections.map((n) => `${n.title} ${n.title} ${n.body}`));
  sections.forEach((node, i) => {
    const scored = sections
      .map((other, j) => ({ other, score: other.page === node.page ? 0 : cosine(sectionVectors[i], sectionVectors[j]) }))
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score);
    const seenPages = new Set<string>();
    for (const { other, score } of scored) {
      if (seenPages.has(other.page)) continue; // one section per page keeps the choice varied
      seenPages.add(other.page);
      edges.push({ from: node.id, to: other.id, kind: "related", score: round(score) });
      if (seenPages.size >= relatedPerSection) break;
    }
  });

  const pageNodes = [...nodes.values()].filter((n) => n.type === "page");
  const pageVectors = vectors(pageNodes.map((n) => [n.title, n.title, n.summary, ...sectionsOf(n.id, nodes).map((s) => `${s.title} ${s.body}`)].join(" ")));
  pageNodes.forEach((node, i) => {
    const linked = new Set(edges.filter((e) => e.from === node.id && e.kind === "lists").map((e) => e.to));
    pageNodes
      .map((other, j) => ({ other, score: other.id === node.id ? 0 : cosine(pageVectors[i], pageVectors[j]) }))
      .filter((s) => s.score >= minScore && !linked.has(s.other.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, relatedPerPage)
      .forEach(({ other, score }) => edges.push({ from: node.id, to: other.id, kind: "related", score: round(score) }));
  });

  return { nodes, edges: dedupe(edges), pages, pageIds, boilerplate: [...boilerplate] };
}

function sectionsOf(pageId: string, nodes: Map<string, GraphNode>): GraphNode[] {
  return [...nodes.values()].filter((n) => n.type === "section" && n.page === pageId);
}

type Vector = Map<string, number>;

/** TF-IDF with log term frequency; vectors are L2-normalised so cosine is a dot product. */
function vectors(texts: string[]): Vector[] {
  const docs = texts.map((text) => {
    const tf = new Map<string, number>();
    for (const term of terms(text)) tf.set(term, (tf.get(term) ?? 0) + 1);
    return tf;
  });
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  return docs.map((doc) => {
    const v: Vector = new Map();
    let norm = 0;
    for (const [term, n] of doc) {
      const d = df.get(term)!;
      if (d < 2) continue; // a word on one page cannot connect anything
      const w = (1 + Math.log(n)) * Math.log(docs.length / d);
      if (w <= 0) continue;
      v.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, w] of v) v.set(term, w / norm);
    return v;
  });
}

function cosine(a: Vector, b: Vector): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, w] of small) sum += w * (large.get(term) ?? 0);
  return sum;
}

const round = (n: number) => Math.round(n * 100) / 100;

function dedupe(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function outgoing(graph: Graph, id: string, kind?: EdgeKind): Edge[] {
  return graph.edges.filter((e) => e.from === id && (!kind || e.kind === kind));
}

/** Who points here by content: links, listings and similarity (not structure). */
export function incoming(graph: Graph, id: string): Edge[] {
  return graph.edges.filter((e) => e.to === id && (e.kind === "links" || e.kind === "lists"));
}
