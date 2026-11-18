// Graph → files: index.md (the map), one note per page and per section, graph.json.
// The output is an Open Knowledge Format (OKF v0.2) bundle: every note has YAML frontmatter with
// a `type`, and index.md follows the OKF index structure. Links are absolute URLs by default, so
// the notes work with any plain web fetch; relative links keep the bundle self-contained for OKF tools.
import { posix } from "node:path";
import { incoming, outgoing, type Graph, type GraphNode } from "./graph.ts";

export const OKF_VERSION = "0.2";

export interface RenderOptions {
  /** Absolute URL the map is served from, ending with «/», e.g. https://example.com/ai/ */
  base: string;
  site: string;
  name: string;
  lang: "ru" | "en";
  /** ISO 8601 datetime of the build, with a UTC offset. */
  generated: string;
  /** OKF actor that produced the notes, e.g. «site-graph/0.1.0». */
  producer: string;
  /** «absolute»: URLs under `base`, for agents on the web. «relative»: paths inside the bundle. */
  links?: "absolute" | "relative";
  /** The model that wrote the hints, when the LLM pass ran. */
  model?: string;
}

const TYPES = { page: "Web Page", section: "Web Page Section" } as const;

const LABELS = {
  ru: {
    mapTitle: (name: string) => `Карта сайта ${name} для ИИ-агентов`,
    howTo:
      "Каждая ссылка ведёт на короткую заметку в Markdown: страницу или её раздел. " +
      "Рядом указано, о чём там и сколько примерно токенов займёт чтение. " +
      "Начните со страницы по теме вопроса, открывайте только нужные разделы и переходите по связям в «Куда дальше».",
    tokens: (n: number) => `≈${n} токенов`,
    readIf: (when: string) => `читать, если ${when}`,
    sectionsCount: (n: number) => `${n} ${plural(n, "раздел", "раздела", "разделов")}`,
    original: "Оригинал",
    fullPage: (n: number) => `вся страница ≈${n} токенов`,
    sections: "Разделы",
    listed: "Перечислено на странице",
    linksTo: "Ссылается на",
    linkedFrom: "Ссылаются сюда",
    similarPages: "Похожие страницы",
    fromSection: (title: string) => `из раздела «${title}»`,
    sectionOf: (i: number, n: number) => `Раздел ${i} из ${n} страницы`,
    whereNext: "Куда дальше",
    next: "Следующий раздел",
    previous: "Предыдущий раздел",
    linksInText: "Ссылки из текста",
    similar: "Похожее на других страницах",
    toPage: "К странице",
    toMap: "Карта сайта",
    more: "Полный текст — в разделах ниже.",
  },
  en: {
    mapTitle: (name: string) => `${name} site map for AI agents`,
    howTo:
      "Every link leads to a short Markdown note: a page or one of its sections. " +
      "Next to it: what is there and roughly how many tokens it costs to read. " +
      "Start with the page closest to the question, open only the sections you need and follow «Where next».",
    tokens: (n: number) => `≈${n} tokens`,
    readIf: (when: string) => `read if ${when}`,
    sectionsCount: (n: number) => `${n} section${n === 1 ? "" : "s"}`,
    original: "Original",
    fullPage: (n: number) => `whole page ≈${n} tokens`,
    sections: "Sections",
    listed: "Listed on this page",
    linksTo: "Links to",
    linkedFrom: "Linked from",
    similarPages: "Similar pages",
    fromSection: (title: string) => `from «${title}»`,
    sectionOf: (i: number, n: number) => `Section ${i} of ${n} of`,
    whereNext: "Where next",
    next: "Next section",
    previous: "Previous section",
    linksInText: "Links in the text",
    similar: "Similar on other pages",
    toPage: "Back to page",
    toMap: "Site map",
    more: "The full text is in the sections below.",
  },
};

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

const INTRO_LIMIT = 1200;

export function render(graph: Graph, options: RenderOptions): Map<string, string> {
  const t = LABELS[options.lang];
  const files = new Map<string, string>();
  // The file being written: relative links are resolved from its directory.
  let current = "index.md";
  const target = (path: string) =>
    options.links === "relative" ? posix.relative(posix.dirname(current), path) : `${options.base}${path}`;
  const href = (id: string) => target(`${id}.md`);
  const node = (id: string) => graph.nodes.get(id)!;
  const link = (n: GraphNode, label = n.title) => `[${escape(label)}](${href(n.id)})`;
  // The text next to a link: why to follow it (from the LLM pass), else when to read the target,
  // else what the target holds.
  const details = (n: GraphNode, extra = "", why?: string) => {
    const hint = why ?? (n.when ? t.readIf(n.when) : n.summary);
    return [hint && oneLine(hint), extra, t.tokens(n.tokens)].filter(Boolean).join(" · ");
  };
  const entry = (n: GraphNode, extra = "", why?: string) => `${link(n)} — ${details(n, extra, why)}`;
  // OKF fields first (type, title, description, resource, generated), then this tool's own keys.
  const concept = (n: GraphNode, extra: Record<string, FrontValue>) =>
    frontMatter({
      type: TYPES[n.type],
      title: n.title,
      description: n.summary && oneLine(n.summary),
      resource: n.url,
      generated: { by: options.producer, at: options.generated },
      ...extra,
      when: n.when,
      hints_by: n.when ? options.model : undefined,
      tokens: n.tokens,
    });
  const sectionsOf = (id: string) => outgoing(graph, id, "contains").map((e) => node(e.to));

  // index.md: pages grouped by the first segment of their path.
  const groups = new Map<string, GraphNode[]>();
  for (const page of graph.pages) {
    const id = graph.pageIds.get(page.key)!;
    if (!graph.nodes.has(id)) continue;
    const segments = page.key.split("/").filter(Boolean);
    // A top-level page that heads a group («/blog» for «/blog/*») opens that group instead.
    if (segments.length === 1 && graph.pages.some((p) => p.key.startsWith(`${page.key}/`))) continue;
    const group = segments.length > 1 ? segments[0] : "";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(node(id));
  }
  const groupTitle = (group: string) => graph.nodes.get(group)?.title ?? group;
  // OKF index: no frontmatter but okf_version, and «* [Title](url) - description» entries under headings.
  // Top-level pages sit under the map title; a group's listing page («/blog») opens its group.
  const home = graph.nodes.get("home");
  const item = (n: GraphNode) => {
    const count = sectionsOf(n.id).length;
    return `* ${link(n)} - ${details(n, count ? t.sectionsCount(count) : "")}`;
  };
  const items = (group: string, nodes: GraphNode[]) => {
    const hub = group ? graph.nodes.get(group) : undefined;
    return [...(hub ? [hub] : []), ...nodes].map(item).join("\n");
  };
  const index = [
    frontMatter({ okf_version: OKF_VERSION }),
    `# ${t.mapTitle(options.name)}`,
    home?.summary ? `> ${oneLine(home.summary)}` : "",
    t.howTo,
    groups.has("") ? items("", groups.get("")!) : "",
    ...[...groups]
      .filter(([group]) => group)
      .map(([group, nodes]) => [`# ${escape(groupTitle(group))} (${nodes.length})`, items(group, nodes)].join("\n\n")),
  ];
  files.set("index.md", join(index));

  for (const n of graph.nodes.values()) {
    current = `${n.id}.md`;
    files.set(current, n.type === "page" ? renderPage(n) : renderSection(n));
  }

  function renderPage(n: GraphNode): string {
    const sections = sectionsOf(n.id);
    const intro = n.body ?? "";
    const parts = [
      concept(n, { sections: sections.length }),
      `# ${n.title}`,
      n.summary ? `> ${oneLine(n.summary)}` : "",
      `${t.original}: <${n.url}> · ${t.fullPage(n.tokens)}`,
      intro.length <= INTRO_LIMIT ? intro : `${intro.slice(0, INTRO_LIMIT).replace(/\s+\S*$/, "")}…\n\n${t.more}`,
    ];
    if (sections.length) parts.push(`## ${t.sections}`, sections.map((s, i) => `${i + 1}. ${entry(s)}`).join("\n"));

    const listed = outgoing(graph, n.id, "lists").map((e) => node(e.to));
    if (listed.length) parts.push(`## ${t.listed}`, listed.map((p) => `- ${entry(p)}`).join("\n"));

    // Content links from this page's sections, grouped by target page.
    const targets = new Map<string, { from: string; why?: string }>();
    for (const s of sections) {
      for (const e of outgoing(graph, s.id, "links")) {
        if (!targets.has(e.to)) targets.set(e.to, { from: s.title, why: e.why });
      }
    }
    if (targets.size) {
      parts.push(`## ${t.linksTo}`, [...targets].map(([id, { from, why }]) => `- ${entry(node(id), t.fromSection(from), why)}`).join("\n"));
    }

    const sources = new Map<string, string | null>();
    for (const e of [...incoming(graph, n.id)]) {
      const from = node(e.from);
      const pageNode = node(from.page);
      if (pageNode.id === n.id || sources.has(pageNode.id)) continue;
      sources.set(pageNode.id, from.type === "section" ? from.title : null);
    }
    if (sources.size) {
      parts.push(
        `## ${t.linkedFrom}`,
        [...sources].map(([id, section]) => `- ${link(node(id))}${section ? ` — ${t.fromSection(section)}` : ""}`).join("\n"),
      );
    }

    const similar = outgoing(graph, n.id, "related").filter((e) => !targets.has(e.to));
    if (similar.length) parts.push(`## ${t.similarPages}`, similar.map((e) => `- ${entry(node(e.to), "", e.why)}`).join("\n"));

    parts.push(`[${t.toMap}](${target("index.md")})`);
    return join(parts);
  }

  function renderSection(n: GraphNode): string {
    const page = node(n.page);
    const siblings = sectionsOf(page.id);
    const i = siblings.findIndex((s) => s.id === n.id);
    const next = siblings[i + 1];
    const previous = siblings[i - 1];
    const linked = outgoing(graph, n.id, "links");
    const related = outgoing(graph, n.id, "related");

    const nav: string[] = [];
    if (next) nav.push(`- ${t.next}: ${entry(next)}`);
    if (previous) nav.push(`- ${t.previous}: ${link(previous)}`);
    if (linked.length) nav.push(`- ${t.linksInText}:`, ...linked.map((e) => `  - ${entry(node(e.to), "", e.why)}`));
    if (related.length) {
      nav.push(
        `- ${t.similar}:`,
        ...related.map((e) => {
          const s = node(e.to);
          return `  - ${entry(s, "", e.why).replace(link(s), link(s, `${node(s.page).title} → ${s.title}`))}`;
        }),
      );
    }

    return join([
      concept(n, { page: href(page.id) }),
      `# ${n.title}`,
      `${t.sectionOf(i + 1, siblings.length)} ${link(page)} · ${t.tokens(n.tokens)}`,
      n.body ?? "",
      "---",
      nav.length ? `## ${t.whereNext}\n\n${nav.join("\n")}` : "",
      `[↑ ${t.toPage}](${href(page.id)}) · [${t.toMap}](${target("index.md")})`,
    ]);
  }

  files.set(
    "graph.json",
    `${JSON.stringify(
      {
        site: options.site,
        base: options.base,
        okf_version: OKF_VERSION,
        generated: options.generated,
        nodes: [...graph.nodes.values()].map(({ body: _body, ...rest }) => ({ ...rest, note: `${rest.id}.md` })),
        edges: graph.edges,
        boilerplate: graph.boilerplate,
      },
      null,
      2,
    )}\n`,
  );
  return files;
}

type FrontValue = string | number | Record<string, string> | undefined;

/** YAML frontmatter; empty values are left out, nested maps are written in flow style. */
function frontMatter(fields: Record<string, FrontValue>): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${yamlValue(value!)}`);
  return `---\n${lines.join("\n")}\n---`;
}

function yamlValue(value: string | number | Record<string, string>): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return yamlString(value);
  return `{ ${Object.entries(value).map(([key, v]) => `${key}: ${JSON.stringify(v)}`).join(", ")} }`;
}

/** Plain scalar when it is unambiguous text, otherwise a double-quoted (JSON-compatible) string. */
function yamlString(value: string): string {
  const plain = /^\p{L}[\p{L}\p{N} ._/-]*$/u.test(value) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const escape = (text: string) => text.replace(/([[\]])/g, "\\$1");
const join = (parts: string[]) => `${parts.filter((p) => p && p.trim()).join("\n\n")}\n`;
