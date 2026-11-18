#!/usr/bin/env node
// npx site-graph <site-url> [options]   build the map
// npx site-graph check [dir]            check a built map
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { annotate, claudeAnnotator, DEFAULT_MODEL } from "./annotate.ts";
import { checkMap } from "./check.ts";
import { discover, fetchAll } from "./fetch.ts";
import { buildGraph } from "./graph.ts";
import { pageKey, parsePage } from "./parse.ts";
import { OKF_VERSION, render } from "./render.ts";
import { isCyrillic } from "./text.ts";

const DEFAULT_OUT = "ai";

const USAGE = `site-graph: a linked Markdown map of your site that AI agents can walk.

Usage:
  npx site-graph <site-url> [options]   build the map (also: site-graph build <site-url>)
  npx site-graph check [dir]            check a built map (default dir: ./${DEFAULT_OUT})

Options:
  --out <dir>        where to write the map (default: ./${DEFAULT_OUT})
  --base <url>       absolute URL the map will be served from (default: <site>/ai/)
  --name <name>      site name for the map title (default: host name)
  --max-pages <n>    stop after this many pages from the sitemap (default: 500)
  --exclude <path>   skip pages under this path; repeatable (e.g. --exclude /privacy)
  --lang <ru|en>     language of the map's own labels (default: detected from the content)
  --links <style>    absolute: URLs under --base, for agents on the web (default)
                     relative: paths inside the folder, a self-contained OKF bundle for git and OKF tools
  --llm              let Claude write «when to read» for notes and «why follow» for links, and drop
                     similarity links that only share words (needs ANTHROPIC_API_KEY; one request per page)
  --model <id>       Claude model for --llm (default: ${DEFAULT_MODEL})
  --cache <file>     LLM results by content hash; unchanged pages cost nothing (default: .site-graph-cache.json)
  -v, --version      print the version
  -h, --help         print this help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: DEFAULT_OUT },
    base: { type: "string" },
    name: { type: "string" },
    "max-pages": { type: "string", default: "500" },
    exclude: { type: "string", multiple: true, default: [] },
    lang: { type: "string" },
    links: { type: "string", default: "absolute" },
    llm: { type: "boolean", default: false },
    model: { type: "string", default: DEFAULT_MODEL },
    cache: { type: "string", default: ".site-graph-cache.json" },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
if (values.version) {
  console.log(version);
  process.exit(0);
}

const [first, ...rest] = positionals;
const command = first === "build" || first === "check" ? first : "build";
const args = command === first ? rest : positionals;
if (values.help || (command === "build" && !args[0])) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

if (command === "check") await check(resolve(args[0] ?? DEFAULT_OUT));
else await build(args[0]);

async function check(dir: string): Promise<void> {
  const report = await checkMap(dir).catch((error: NodeJS.ErrnoException) => {
    fail(error.code === "ENOENT" ? `No map in ${dir}. Build one with: npx site-graph <site-url>` : error.message);
  });
  for (const warning of report.warnings) console.log(`  warning  ${warning}`);
  for (const problem of report.problems) console.log(`  problem  ${problem}`);
  console.log(
    `\n${report.notes} notes, ${report.links} links between them: ` +
      `${report.problems.length} problems, ${report.warnings.length} warnings` +
      (report.problems.length ? "" : ` — a valid OKF ${OKF_VERSION} map`),
  );
  process.exit(report.problems.length ? 1 : 0);
}

async function build(siteArg: string): Promise<void> {
  const site = new URL(/^https?:\/\//.test(siteArg) ? siteArg : `https://${siteArg}`);
  const base = values.base ? (values.base.endsWith("/") ? values.base : `${values.base}/`) : new URL("/ai/", site).href;
  const out = resolve(values.out!);
  if (values.links !== "absolute" && values.links !== "relative") fail(`--links must be «absolute» or «relative», got «${values.links}»`);
  // Checked before any request: a mistyped --out must not cost a crawl, let alone someone's folder.
  await assertReplaceable(out);
  const excluded = values.exclude!.map((path) => path.replace(/\/+$/, "") || "/");

  console.log(`Sitemap of ${site.origin}`);
  const urls = (await discover(site, Number(values["max-pages"])))
    .filter((url) => !excluded.some((path) => pageKey(url) === path || pageKey(url).startsWith(`${path}/`)));
  console.log(`Fetching ${urls.length} pages`);
  const fetched = await fetchAll(urls, 4, console.log);
  if (!fetched.length) fail(`No pages could be read from ${site.origin}. Is the address right, and does the site answer?`);

  const pages = fetched.map((page) => parsePage(page.url, page.markdown));
  const graph = buildGraph(pages);

  let llmSummary = "";
  if (values.llm) {
    if (!process.env.ANTHROPIC_API_KEY) console.log("\nNote: ANTHROPIC_API_KEY is not set; the SDK will look for other credentials.");
    console.log(`\nAnnotating ${[...graph.nodes.values()].filter((n) => n.type === "page").length} pages with ${values.model}`);
    const report = await annotate(graph, claudeAnnotator(values.model), {
      cachePath: resolve(values.cache!),
      model: values.model!,
      log: console.log,
    });
    llmSummary =
      `\n  llm: ${report.pages - report.cached - report.failed.length} pages annotated, ${report.cached} from cache, ` +
      `${report.failed.length} failed${report.failed.length ? ` (${report.failed.join(", ")})` : ""}; ` +
      `${report.dropped} weak links dropped; tokens in ${report.usage.input}, out ${report.usage.output}`;
  }
  const lang = values.lang === "en" || values.lang === "ru" ? values.lang : isCyrillic(pages.map((p) => p.fullText).join(" ")) ? "ru" : "en";
  const files = render(graph, {
    base,
    site: site.origin + "/",
    name: values.name ?? site.host,
    lang,
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    producer: `site-graph/${version}`,
    links: values.links as "absolute" | "relative",
    model: values.llm ? values.model : undefined,
  });

  await rm(out, { recursive: true, force: true });
  for (const [path, content] of files) {
    const target = join(out, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const count = (kind: string) => graph.edges.filter((e) => e.kind === kind).length;
  const shown = relative(process.cwd(), out) || ".";
  const llms = new URL("/llms.txt", site).href;
  console.log(
    `\nMap: ${files.size - 1} notes in ./${shown}\n` +
      `  pages ${[...graph.nodes.values()].filter((n) => n.type === "page").length}, ` +
      `sections ${[...graph.nodes.values()].filter((n) => n.type === "section").length}\n` +
      `  edges: links ${count("links")}, lists ${count("lists")}, related ${count("related")}, next ${count("next")}\n` +
      `  dropped as repeated template: ${graph.boilerplate.join("; ") || "nothing"}\n` +
      `  OKF ${OKF_VERSION} bundle, ${values.links} links` +
      llmSummary +
      `\n\nNext steps\n` +
      `  1. Upload ./${shown} so that ${base}index.md opens. Rebuild it when the site changes.\n` +
      `  2. Tell agents where it is: add this line to ${llms}\n` +
      `       - [${lang === "ru" ? "Карта сайта для ИИ-агентов" : "Site map for AI agents"}](${base}index.md): ` +
      `${lang === "ru" ? "связанные заметки по страницам и разделам, с размером в токенах" : "linked notes for every page and section, with their size in tokens"}\n` +
      `  3. Check the map any time: npx site-graph check ./${shown}`,
  );
}

/** The output folder is wiped before writing, so it must be empty or an earlier map. */
async function assertReplaceable(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  if (!entries.length) return;
  const graph = await readFile(join(dir, "graph.json"), "utf8").catch(() => "");
  if (entries.includes("index.md") && /"edges"\s*:/.test(graph)) return;
  fail(`${dir} already exists and is not a site-graph map; it would be replaced. Pass another --out.`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
