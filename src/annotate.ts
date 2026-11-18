// Optional LLM pass (Claude). One request per page: the model writes, for the page and each of its
// sections, what the note holds and when to open it. For each outgoing link it says what following
// it adds, and it marks similarity links that only share words. Results are cached by content, so
// a rebuild pays only for pages that changed.
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Graph } from "./graph.ts";

/** Bump when the prompt or schema changes: old cache entries then stop matching. */
const PROMPT_VERSION = "1";
export const DEFAULT_MODEL = "claude-opus-5-5";

export interface NodeNote {
  id: string;
  summary: string;
  when: string;
}

export interface EdgeNote {
  key: string;
  why: string;
  keep: boolean;
}

export interface PageAnnotation {
  nodes: NodeNote[];
  edges: EdgeNote[];
}

export interface PageInput {
  page: { id: string; title: string; url: string; intro: string };
  sections: { id: string; title: string; text: string }[];
  links: { key: string; from: string; kind: "links" | "related"; to: string; toTitle: string; toSummary: string }[];
}

/** Whatever answers one page: the Claude client in production, a stub in tests. */
export type Annotator = (input: PageInput) => Promise<{ result: PageAnnotation; usage?: Usage }>;

export interface Usage {
  input: number;
  output: number;
}

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["nodes", "edges"],
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "summary", "when"],
        properties: { id: { type: "string" }, summary: { type: "string" }, when: { type: "string" } },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "why", "keep"],
        properties: { key: { type: "string" }, why: { type: "string" }, keep: { type: "boolean" } },
      },
    },
  },
} as const;

export const SYSTEM = `You annotate a map of a website for AI agents. The map splits each page into small notes (the page itself and its sections) and links them. An agent reading the map sees only a title and your short texts next to each link, and must decide whether opening the note is worth the tokens. Your texts are that decision aid.

You get one page: its intro, the full text of every section, and the links that leave this page or its sections, with the target's title and a rough summary.

Write in the language of the page content. Be factual and specific: name the concrete things a note covers (numbers, steps, options, criteria). No marketing tone, no praise, no «this section describes». Do not invent anything that is not in the text.

For the page and for every section return:
- summary: what the note contains, one sentence, at most 160 characters.
- when: the situation or question for which an agent should open it, written so that it continues «Read if …» (in Russian: «Читать, если …»), without that prefix, lowercase start, at most 110 characters. Example: «нужно оценить бюджет на интеграции и сопровождение».

For every link return:
- why: what the target adds for a reader of the source note, at most 100 characters, same language, lowercase start.
- keep: false when the link is «related» and the two notes only share vocabulary without a connection useful to a reader of the source; true otherwise. Links of kind «links» were written by the site's authors: always keep them.

Return every page, section and link id you were given, exactly as given.`;

export function claudeAnnotator(model = DEFAULT_MODEL): Annotator {
  const client = new Anthropic();
  return async (input) => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(input) }],
    });
    if (response.stop_reason === "refusal") throw new Error(`model declined page ${input.page.id}`);
    if (response.stop_reason === "max_tokens") throw new Error(`answer for page ${input.page.id} was cut off`);
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return {
      result: JSON.parse(text) as PageAnnotation,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  };
}

/** What one page sends to the model: its own text and where its links lead. */
export function pageInputs(graph: Graph): PageInput[] {
  const inputs: PageInput[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type !== "page") continue;
    const sections = graph.edges
      .filter((e) => e.from === node.id && e.kind === "contains")
      .map((e) => graph.nodes.get(e.to)!);
    const own = new Set([node.id, ...sections.map((s) => s.id)]);
    const links = graph.edges
      .filter((e) => own.has(e.from) && (e.kind === "links" || e.kind === "related"))
      .map((e) => {
        const target = graph.nodes.get(e.to)!;
        const targetPage = graph.nodes.get(target.page)!;
        return {
          key: edgeKey(e.from, e.to),
          from: e.from,
          kind: e.kind as "links" | "related",
          to: e.to,
          toTitle: target.type === "section" ? `${targetPage.title} → ${target.title}` : target.title,
          toSummary: target.summary,
        };
      });
    inputs.push({
      page: { id: node.id, title: node.title, url: node.url, intro: node.body ?? "" },
      sections: sections.map((s) => ({ id: s.id, title: s.title, text: s.body ?? "" })),
      links,
    });
  }
  return inputs;
}

export const edgeKey = (from: string, to: string) => `${from} -> ${to}`;

interface CacheFile {
  [hash: string]: PageAnnotation;
}

export interface AnnotateReport {
  pages: number;
  cached: number;
  failed: string[];
  dropped: number;
  usage: Usage;
}

/**
 * Annotates every page (cached by content hash) and applies the result to the graph in place:
 * summaries and «when» on nodes, «why» on edges, weak similarity edges removed.
 */
export async function annotate(
  graph: Graph,
  annotator: Annotator,
  options: { cachePath: string; model: string; concurrency?: number; log?: (line: string) => void },
): Promise<AnnotateReport> {
  const log = options.log ?? (() => {});
  const cache: CacheFile = await readFile(options.cachePath, "utf8").then(JSON.parse, () => ({}));
  const inputs = pageInputs(graph);
  const report: AnnotateReport = { pages: inputs.length, cached: 0, failed: [], dropped: 0, usage: { input: 0, output: 0 } };
  const results: PageAnnotation[] = [];
  const used = new Set<string>();

  let next = 0;
  async function worker() {
    while (next < inputs.length) {
      const input = inputs[next++];
      const hash = createHash("sha256").update(`${PROMPT_VERSION}\n${options.model}\n${JSON.stringify(input)}`).digest("hex");
      used.add(hash);
      if (cache[hash]) {
        report.cached++;
        results.push(cache[hash]);
        continue;
      }
      try {
        const { result, usage } = await annotator(input);
        cache[hash] = result;
        results.push(result);
        if (usage) {
          report.usage.input += usage.input;
          report.usage.output += usage.output;
        }
        log(`  annotated ${input.page.id}`);
      } catch (error) {
        report.failed.push(input.page.id);
        log(`  failed    ${input.page.id}: ${(error as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, inputs.length) }, worker));

  // Keep only entries of the current site, so the cache does not grow forever.
  await writeFile(options.cachePath, `${JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([h]) => used.has(h))), null, 1)}\n`);

  for (const result of results) {
    for (const note of result.nodes ?? []) {
      const node = graph.nodes.get(note.id);
      if (!node) continue;
      // An author's description says what the author wants said: the model only fills in the rest.
      if (note.summary?.trim() && !node.authored) node.summary = note.summary.trim();
      if (note.when?.trim()) node.when = note.when.trim().replace(/[.;]$/, "");
    }
    const byKey = new Map((result.edges ?? []).map((e) => [e.key, e]));
    graph.edges = graph.edges.filter((edge) => {
      const note = byKey.get(edgeKey(edge.from, edge.to));
      if (!note || (edge.kind !== "links" && edge.kind !== "related")) return true;
      if (edge.kind === "related" && note.keep === false) {
        report.dropped++;
        return false;
      }
      if (note.why?.trim()) edge.why = note.why.trim().replace(/[.;]$/, "");
      return true;
    });
  }
  return report;
}
