#!/usr/bin/env node
// agent-sitemap                                      in a site's repository: build the map from its files
// agent-sitemap <site-url> [options]                 build the map of any site from the web
// agent-sitemap <site-url> --from <files> [options]  build it from the given files
// agent-sitemap init | check [dir]                   find the settings again | check a built map
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentAnnotator, installedAgents, type Agent } from "./agents.ts";
import { annotate, claudeAnnotator, DEFAULT_MODEL } from "./annotate.ts";
import { checkMap } from "./check.ts";
import { builtAgo, CONFIG_FILE, detect, loadConfig, saveConfig, type Config } from "./detect.ts";
import { discover, fetchAll } from "./fetch.ts";
import { parseSource, readLocal } from "./local.ts";
import { buildGraph } from "./graph.ts";
import { pageKey, parsePage, type Page } from "./parse.ts";
import { OKF_VERSION, render } from "./render.ts";
import { isCyrillic } from "./text.ts";
import { writeMap } from "./write.ts";

const DEFAULT_OUT = "ai";

const USAGE = `agent-sitemap: a linked Markdown map of your site that AI agents can walk.

Usage:
  agent-sitemap                      in a site's repository: build the map from the site's files
  agent-sitemap <site-url>           build the map of any site from the web, through its sitemap.xml
  agent-sitemap init                 find the settings again and save them to ${CONFIG_FILE}
  agent-sitemap check [dir]          check a built map

With no arguments, the first run finds the site's address, its pages (the built site and Markdown
with a title) and the folder it serves as is, saves them to ${CONFIG_FILE} and builds the map
there. Later runs read that file; edit it to change what goes into the map.

Options:
  --from <files>     read pages from files instead of the web; repeatable. A folder (built .html/.md,
                     URL from the path), a glob, or a glob with its URL: "blog/*/post.md=/blog/*/".
                     Markdown front matter gives the title and description; drafts, «status: draft»
                     and future «publishAt» are skipped
  --out <dir>        where to write the map (default: from ${CONFIG_FILE}, else ./${DEFAULT_OUT})
  --base <url>       absolute URL the map will be served from (default: <site>/ai/)
  --name <name>      site name for the map title (default: host name)
  --max-pages <n>    stop after this many pages from the sitemap (default: 500)
  --exclude <path>   skip pages under this path; repeatable (e.g. --exclude /privacy)
  --lang <ru|en>     language of the map's own labels (default: detected from the content)
  --links <style>    absolute: URLs under --base, for agents on the web (default)
                     relative: paths inside the folder, a self-contained OKF bundle for git and OKF tools
  --llm              let a model write «when to read» for notes and «why follow» for links, and drop
                     similarity links that only share words (one request per page)
  --llm-with <how>   api: the Claude API (needs ANTHROPIC_API_KEY)
                     claude, codex: the Claude Code or Codex CLI on this machine, signed in as you
                     default: api when ANTHROPIC_API_KEY is set, else claude, else codex
  --model <id>       model for --llm (default: ${DEFAULT_MODEL} for the API, the agent's own default otherwise)
  --cache <file>     LLM results by content hash; unchanged pages cost nothing (default: .agent-sitemap-cache.json)
  -v, --version      print the version
  -h, --help         print this help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    from: { type: "string", multiple: true, default: [] },
    base: { type: "string" },
    name: { type: "string" },
    "max-pages": { type: "string", default: "500" },
    exclude: { type: "string", multiple: true, default: [] },
    lang: { type: "string" },
    links: { type: "string", default: "absolute" },
    llm: { type: "boolean", default: false },
    "llm-with": { type: "string" },
    model: { type: "string" },
    cache: { type: "string", default: ".agent-sitemap-cache.json" },
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
const command = first === "build" || first === "check" || first === "init" ? first : "build";
const args = command === first ? rest : positionals;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (command === "check") await check(resolve(args[0] ?? (await loadConfig(process.cwd()).catch(() => null))?.out ?? DEFAULT_OUT));
else if (command === "init") await settings(true);
else await build(args[0] ? fromArguments(args[0]) : await settings(false));

/** What a build needs, from the command line or from the repository. */
interface Settings {
  site: URL;
  /** Page sources for --from; none means the live site. */
  from: string[];
  out: string;
  exclude: string[];
  name?: string;
  llmsTxt?: string;
}

function fromArguments(siteArg: string): Settings {
  return {
    site: new URL(/^https?:\/\//.test(siteArg) ? siteArg : `https://${siteArg}`),
    from: values.from!,
    out: values.out ?? DEFAULT_OUT,
    exclude: values.exclude!,
    name: values.name,
  };
}

/** Settings of the repository in the working directory: the saved config, or found and saved now. */
async function settings(again: boolean): Promise<Settings> {
  const cwd = process.cwd();
  let config: Config | null = again ? null : await loadConfig(cwd).catch((error: Error) => fail(error.message));
  if (config) {
    console.log(`Settings from ${CONFIG_FILE}`);
  } else {
    console.log(`Looking at this repository for the site and its pages`);
    const found = await detect(cwd);
    for (const note of found.notes) console.log(`  found  ${note}`);
    if (!found.config) {
      for (const item of found.missing) console.log(`  missing  ${item}`);
      fail(`\nCould not set up the map on my own. Pass the site's address (agent-sitemap https://example.com --from <files>) or write ${CONFIG_FILE}.`);
    }
    config = found.config;
    await saveConfig(cwd, config);
    console.log(`Saved to ${CONFIG_FILE}: edit it to change what goes into the map.\n`);
    if (command === "init") process.exit(0);
  }
  for (const source of config.from) {
    const folder = !source.includes("*") && !source.includes("=") ? source : null;
    const ago = folder && (await builtAgo(resolve(cwd, folder)));
    if (ago) console.log(`  ${folder} was built ${ago}`);
  }
  return {
    site: new URL(config.site),
    from: values.from!.length ? values.from! : config.from,
    out: values.out ?? config.out,
    exclude: [...(config.exclude ?? []), ...values.exclude!],
    name: values.name ?? config.name,
    llmsTxt: config.llmsTxt,
  };
}

async function check(dir: string): Promise<void> {
  const report = await checkMap(dir).catch((error: NodeJS.ErrnoException) => {
    fail(error.code === "ENOENT" ? `No map in ${dir}. Build one with: npx agent-sitemap <site-url>` : error.message);
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

async function build(settings: Settings): Promise<void> {
  const { site } = settings;
  const base = values.base ? (values.base.endsWith("/") ? values.base : `${values.base}/`) : new URL("/ai/", site).href;
  const out = resolve(settings.out);
  if (values.links !== "absolute" && values.links !== "relative") fail(`--links must be «absolute» or «relative», got «${values.links}»`);
  // Checked before any request: a mistyped --out must not cost a crawl, let alone someone's folder.
  await assertReplaceable(out);
  const excluded = settings.exclude.map((path) => path.replace(/\/+$/, "") || "/");

  const isExcluded = (url: string) => excluded.some((path) => pageKey(url) === path || pageKey(url).startsWith(`${path}/`));
  const local = settings.from.length > 0;

  let pages: Page[];
  if (local) {
    const sources = settings.from.map(parseSource);
    console.log(`Reading ${sources.map((s) => s.pattern).join(", ")}`);
    const { pages: found, skipped } = await readLocal(sources, site).catch((error: Error) => fail(error.message));
    for (const { file, reason } of skipped) console.log(`  skipped   ${file} (${reason})`);
    const kept = found.filter((page) => !isExcluded(page.url)).slice(0, Number(values["max-pages"]));
    for (const page of kept) console.log(`  ${page.file.padEnd(40)} → ${new URL(page.url).pathname}`);
    if (!kept.length) fail("No pages to map: every file matched was skipped or excluded.");
    pages = kept.map((page) => parsePage(page.url, page.markdown, { summary: page.description }));
  } else {
    console.log(`Sitemap of ${site.origin}`);
    const urls = (await discover(site, Number(values["max-pages"]))).filter((url) => !isExcluded(url));
    console.log(`Fetching ${urls.length} pages`);
    const fetched = await fetchAll(urls, 4, console.log);
    if (!fetched.length) fail(`No pages could be read from ${site.origin}. Is the address right, and does the site answer?`);
    pages = fetched.map((page) => parsePage(page.url, page.markdown));
  }
  const graph = buildGraph(pages);

  let llmSummary = "";
  let hintsBy: string | undefined;
  if (values.llm) {
    const how = await chooseLlm(values["llm-with"]);
    hintsBy = how === "api" ? (values.model ?? DEFAULT_MODEL) : values.model ? `${how}/${values.model}` : how;
    console.log(`\nAnnotating ${[...graph.nodes.values()].filter((n) => n.type === "page").length} pages with ${how === "api" ? `the Claude API (${hintsBy})` : `the ${how} CLI`}`);
    const report = await annotate(graph, how === "api" ? claudeAnnotator(values.model ?? DEFAULT_MODEL) : agentAnnotator(how, values.model), {
      cachePath: resolve(values.cache!),
      model: hintsBy,
      // Agent CLIs are whole processes with their own limits: two at a time is plenty.
      concurrency: how === "api" ? 4 : 2,
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
    name: settings.name ?? site.host,
    lang,
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    producer: `agent-sitemap/${version}`,
    links: values.links as "absolute" | "relative",
    model: hintsBy,
  });

  const written = await writeMap(out, files);

  // Agents do not look for maps on their own: llms.txt is where they look.
  const line =
    `- [${lang === "ru" ? "Карта сайта для ИИ-агентов" : "Site map for AI agents"}](${base}index.md): ` +
    (lang === "ru" ? "связанные заметки по страницам и разделам, с размером в токенах" : "linked notes for every page and section, with their size in tokens");
  let llmsAdded = false;
  if (settings.llmsTxt) {
    const path = resolve(settings.llmsTxt);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null && !text.includes(`${base}index.md`)) {
      await appendFile(path, `${text.endsWith("\n") ? "" : "\n"}\n${line}\n`);
      llmsAdded = true;
    }
  }

  const count = (kind: string) => graph.edges.filter((e) => e.kind === kind).length;
  const shown = display(out);
  console.log(
    `\nMap: ${files.size - 1} notes in ${shown} ` +
      `(${written.written} written, ${written.unchanged} unchanged, ${written.removed} removed)\n` +
      `  pages ${[...graph.nodes.values()].filter((n) => n.type === "page").length}, ` +
      `sections ${[...graph.nodes.values()].filter((n) => n.type === "section").length}\n` +
      `  edges: links ${count("links")}, lists ${count("lists")}, related ${count("related")}, next ${count("next")}\n` +
      `  dropped as repeated template: ${graph.boilerplate.join("; ") || "nothing"}\n` +
      `  OKF ${OKF_VERSION} bundle, ${values.links} links` +
      llmSummary +
      (llmsAdded ? `\n  added a line pointing to the map to ${display(resolve(settings.llmsTxt!))}` : ""),
  );
  if (local) {
    const changed = written.written + written.removed + Number(llmsAdded);
    console.log(
      changed
        ? `\nCommit ${shown}${llmsAdded ? " and llms.txt" : ""} and deploy with the site: the map opens at ${base}index.md`
        : `\nNothing changed since the last build.`,
    );
  } else {
    console.log(
      `\nNext steps\n` +
        `  1. Upload ${shown} so that ${base}index.md opens. Rebuild it when the site changes.\n` +
        `  2. Tell agents where it is: add this line to ${new URL("/llms.txt", site).href}\n       ${line}\n` +
        `  3. Check the map any time: npx agent-sitemap check ${shown}`,
    );
  }
}

/** Inside the working directory as ./path, elsewhere as an absolute path. */
function display(path: string): string {
  const near = relative(process.cwd(), path) || ".";
  return near.startsWith("..") ? path : `./${near}`;
}

/** How to reach a model for --llm: as asked, or the API with a key, else an agent CLI found on PATH. */
async function chooseLlm(asked: string | undefined): Promise<"api" | Agent> {
  if (asked && asked !== "api" && asked !== "claude" && asked !== "codex") fail(`--llm-with must be api, claude or codex, got «${asked}»`);
  const agents = await installedAgents();
  if (asked === "claude" || asked === "codex") {
    if (!agents.includes(asked)) fail(`--llm-with ${asked}: the ${asked} command is not on PATH`);
    return asked;
  }
  if (asked === "api" || process.env.ANTHROPIC_API_KEY) return "api";
  if (agents.length) return agents[0];
  fail("--llm needs a model: set ANTHROPIC_API_KEY, or install and sign in to Claude Code (claude) or Codex (codex).");
}

/** Notes missing from a new build are deleted from the output folder, so it must be empty or an earlier map. */
async function assertReplaceable(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  if (!entries.length) return;
  const graph = await readFile(join(dir, "graph.json"), "utf8").catch(() => "");
  if (entries.includes("index.md") && /"edges"\s*:/.test(graph)) return;
  fail(`${dir} already exists and is not an agent-sitemap map; it would be replaced. Pass another --out.`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
