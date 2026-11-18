#!/usr/bin/env node
// agent-sitemap                                      in a site's repository: build the map from its files
// agent-sitemap <site-url> [options]                 build the map of any site from the web
// agent-sitemap <site-url> --from <files> [options]  build it from the given files
// agent-sitemap init | check [dir]                   find the settings again | check a built map
import { appendFile, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentAnnotator, installedAgents, login, signIn, type Agent } from "./agents.ts";
import { annotate, claudeAnnotator, DEFAULT_MODEL, stopOnFatal } from "./annotate.ts";
import { isPreset, PRESETS, presetAnnotator, saveToken, tokenFor } from "./openai.ts";
import { checkMap } from "./check.ts";
import { builtAgo, CONFIG_FILE, configOf, detect, loadConfig, saveConfig, type Config } from "./detect.ts";
import { onboard, type LlmOption } from "./onboard.ts";
import { discover, fetchAll } from "./fetch.ts";
import { parseSource, readLocal } from "./local.ts";
import { buildGraph } from "./graph.ts";
import { pageKey, parsePage, type Page } from "./parse.ts";
import { OKF_VERSION, render } from "./render.ts";
import { isCyrillic } from "./text.ts";
import { writeMap } from "./write.ts";

const DEFAULT_OUT = "ai";
/** Ways to reach a model for --llm-with. Up here: the top-level code below runs before later declarations. */
const HOWS = ["api", "claude", "codex", "deepseek", "kimi", "openrouter"] as const;
/** Stands in for the address of a site that has none yet; removed from everything written. */
const NO_SITE = "https://site.invalid";

const USAGE = `agent-sitemap: a linked Markdown map of your site that AI agents can walk.

Usage:
  agent-sitemap                      in a site's repository: build the map from the site's files
  agent-sitemap <site-url>           build the map of any site from the web, through its sitemap.xml
  agent-sitemap init                 find the settings again and save them to ${CONFIG_FILE}
  agent-sitemap check [dir]          check a built map

With no arguments, the first run finds the site's address, its pages (the built site and Markdown
with a title) and the folder it serves as is. In a terminal it asks three questions with those
answers filled in (address, pages, model for hints); elsewhere, or with --yes, it takes them as
found. It saves them to ${CONFIG_FILE} and builds the map; later runs read that file.

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
  --llm-with <how>   claude, codex: the Claude Code or Codex CLI on this machine, signed in as you
                     api: the Claude API (ANTHROPIC_API_KEY)
                     deepseek, kimi, openrouter: their APIs (DEEPSEEK_API_KEY, MOONSHOT_API_KEY,
                     OPENROUTER_API_KEY, or the token entered on the first run)
                     default: the one set on the first run; with --llm alone, the first one available
  --model <id>       model for --llm (default: ${DEFAULT_MODEL} for the API, the agent's own default otherwise)
  --cache <file>     LLM results by content hash; unchanged pages cost nothing (default: .agent-sitemap-cache.json)
  --offline          build from the repository only: do not fill in pages from the live site
  -y, --yes          first run: take what was found, ask nothing
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
    yes: { type: "boolean", short: "y" },
    offline: { type: "boolean", default: false },
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
  /** The model chosen in the settings; --llm on the command line wins. */
  llm?: How;
  /** Fill in from the live site's sitemap.xml the pages the files do not have. */
  fromSite?: boolean;
  /** No address: links inside the map are relative, pages are named by their path. */
  siteless?: boolean;
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
    const found = await detect(cwd);
    const interactive =
      (Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI && !values.yes) || process.env.AGENT_SITEMAP_INTERACTIVE === "1";
    if (interactive) {
      config = await onboard(found, await modelsHere());
      if (!config) process.exit(1);
      console.log("");
    } else {
      console.log(`Looking at this repository for the site and its pages`);
      for (const note of found.notes) console.log(`  found  ${note}`);
      if (found.missing.length) {
        for (const item of found.missing) console.log(`  missing  ${item}`);
        fail(`\nCould not set up the map on my own. Run it in a terminal to answer a few questions, pass the site's address (agent-sitemap https://example.com --from <files>) or write ${CONFIG_FILE}.`);
      }
      config = configOf(found);
    }
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
    site: new URL(config.site || `${NO_SITE}/`),
    siteless: !config.site,
    from: values.from!.length ? values.from! : config.from,
    out: values.out ?? config.out,
    exclude: [...(config.exclude ?? []), ...values.exclude!],
    name: values.name ?? config.name ?? (config.site ? undefined : basename(cwd)),
    llmsTxt: config.llmsTxt,
    fromSite: Boolean(config.site) && config.fromSite !== false && !values.offline,
    llm: config.llm && config.llm !== "none" ? config.llm : undefined,
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
  // Without an address there is nothing to make links absolute with.
  const links = settings.siteless ? "relative" : (values.links as "absolute" | "relative");
  const mapUrl = settings.siteless ? new URL(base).pathname : base;
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
    if (settings.fromSite) pages.push(...(await fromLiveSite(site, new Set(pages.map((p) => p.key)), isExcluded)));
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
  // --llm asks for it now; otherwise the model chosen on the first run, if it can be reached here.
  let how: How | null = values.llm ? await chooseLlm(values["llm-with"]) : (settings.llm ?? null);
  if (how) {
    const problem = await unreachable(how);
    if (problem) {
      if (values.llm) fail(`\n${problem}`);
      console.log(`\n${problem} Building without hints for now.`);
      how = null;
    }
  }
  if (how) {
    const preset = isPreset(how) ? PRESETS[how] : null;
    const model = values.model ?? (how === "api" ? DEFAULT_MODEL : preset?.model);
    hintsBy = how === "api" ? model : model ? `${how}/${model}` : how;
    const label = how === "api" ? `the Claude API (${model})` : preset ? `${preset.label} (${model})` : `the ${how} CLI`;
    const annotator =
      how === "api"
        ? stopOnFatal(claudeAnnotator(model))
        : preset
          ? stopOnFatal(presetAnnotator(preset, (await tokenFor(preset))!, model))
          : agentAnnotator(how as Agent, values.model);
    const total = [...graph.nodes.values()].filter((n) => n.type === "page").length;
    console.log(`\nAnnotating ${total} pages with ${label}`);
    const bar = progressBar(total);
    const report = await annotate(graph, annotator, {
      cachePath: resolve(values.cache!),
      model: hintsBy!,
      // Agent CLIs are whole processes with their own limits: two at a time is plenty.
      concurrency: how === "claude" || how === "codex" ? 2 : 4,
      log: bar.log,
      progress: bar.update,
    });
    bar.finish();
    llmSummary =
      `\n  llm: ${report.pages - report.cached - report.failed.length} pages annotated, ${report.cached} from cache, ` +
      `${report.failed.length} failed; ${report.dropped} weak links dropped; tokens in ${report.usage.input}, out ${report.usage.output}`;
  }
  const lang = values.lang === "en" || values.lang === "ru" ? values.lang : isCyrillic(pages.map((p) => p.fullText).join(" ")) ? "ru" : "en";
  const files = render(graph, {
    base,
    site: site.origin + "/",
    name: settings.name ?? site.host,
    lang,
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    producer: `agent-sitemap/${version}`,
    links,
    model: hintsBy,
  });
  if (settings.siteless) for (const [path, text] of files) files.set(path, text.replaceAll(NO_SITE, ""));

  const written = await writeMap(out, files);

  // Agents do not look for maps on their own: llms.txt is where they look.
  const line =
    `- [${lang === "ru" ? "Карта сайта для ИИ-агентов" : "Site map for AI agents"}](${mapUrl}index.md): ` +
    (lang === "ru" ? "связанные заметки по страницам и разделам, с размером в токенах" : "linked notes for every page and section, with their size in tokens");
  let llmsAdded = false;
  if (settings.llmsTxt) {
    const path = resolve(settings.llmsTxt);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null && !text.includes(`${mapUrl}index.md`)) {
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
      `  OKF ${OKF_VERSION} bundle, ${links} links` +
      llmSummary +
      (llmsAdded ? `\n  added a line pointing to the map to ${display(resolve(settings.llmsTxt!))}` : ""),
  );
  if (local) {
    const changed = written.written + written.removed + Number(llmsAdded);
    console.log(
      changed
        ? `\nCommit ${shown}${llmsAdded ? " and llms.txt" : ""} and deploy with the site: the map opens at ${settings.siteless ? `${mapUrl}index.md on the site` : `${base}index.md`}`
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

type How = Exclude<Config["llm"], "none" | undefined>;

/**
 * Pages the live site has and the repository does not: its sitemap.xml against the files. They are
 * read from the site (as Markdown when it offers it). A site out of reach leaves the map as it is.
 */
async function fromLiveSite(site: URL, have: Set<string>, isExcluded: (url: string) => boolean): Promise<Page[]> {
  let urls: string[];
  try {
    urls = await discover(site, Number(values["max-pages"]));
  } catch (error) {
    console.log(`\nCould not read ${site.origin}/sitemap.xml (${(error as Error).message}): the map has the repository's pages only.`);
    return [];
  }
  const missing = urls.filter((url) => !have.has(pageKey(url)) && !isExcluded(url));
  if (!missing.length) {
    console.log(`\nEvery page in ${site.origin}/sitemap.xml is in the repository.`);
    return [];
  }
  console.log(`\nFrom ${site.origin}: ${missing.length} ${missing.length === 1 ? "page is" : "pages are"} on the site but not in the repository`);
  const fetched = await fetchAll(missing, 4, console.log);
  if (fetched.length < missing.length) console.log(`  ${missing.length - fetched.length} could not be read: they stay out of the map`);
  return fetched.map((page) => parsePage(page.url, page.markdown));
}

/** Models for the first-run question: agents found here (signed in or not), the Claude API with a key, the presets. */
async function modelsHere(): Promise<LlmOption[]> {
  const options: LlmOption[] = [];
  for (const agent of await installedAgents()) {
    const status = await signIn(agent);
    options.push({
      value: agent,
      label: agent === "claude" ? "Claude Code, under your subscription" : "Codex, under your subscription",
      ...(status.signedIn ? {} : { signIn: { hint: status.hint, run: () => login(agent) } }),
    });
  }
  if (process.env.ANTHROPIC_API_KEY) options.push({ value: "api", label: "Claude API with ANTHROPIC_API_KEY, paid per page" });
  for (const preset of Object.values(PRESETS)) {
    const token = await tokenFor(preset);
    options.push({
      value: preset.id,
      label: `${preset.label}, ${preset.model}`,
      ...(token ? {} : { token: { env: preset.keyEnv, url: preset.keyUrl, save: (value: string) => saveToken(preset, value) } }),
    });
  }
  return options;
}

/** Why the chosen model cannot be used on this machine right now, or null when it can. */
async function unreachable(how: How): Promise<string | null> {
  if (how === "api") return process.env.ANTHROPIC_API_KEY ? null : "Hints from the Claude API need ANTHROPIC_API_KEY.";
  if (isPreset(how)) {
    const preset = PRESETS[how];
    return (await tokenFor(preset))
      ? null
      : `${preset.label} needs a token: set ${preset.keyEnv} or run agent-sitemap init to enter it (get one at ${preset.keyUrl}).`;
  }
  const name = how === "claude" ? "Claude Code" : "Codex";
  if (!(await installedAgents()).includes(how)) return `${name} is set in ${CONFIG_FILE}, but the ${how} command is not installed here.`;
  const status = await signIn(how);
  return status.signedIn ? null : `${name} is installed but not signed in: run \`${status.hint}\`, then build again.`;
}

/** How to reach a model for --llm: as asked, else the API with a key, an agent found here, a preset with a token. */
async function chooseLlm(asked: string | undefined): Promise<How> {
  if (asked) {
    if (!(HOWS as readonly string[]).includes(asked)) fail(`--llm-with must be one of ${HOWS.join(", ")}, got «${asked}»`);
    return asked as How;
  }
  if (process.env.ANTHROPIC_API_KEY) return "api";
  const agents = await installedAgents();
  if (agents.length) return agents[0];
  for (const preset of Object.values(PRESETS)) if (await tokenFor(preset)) return preset.id;
  fail("--llm needs a model: install Claude Code or Codex, or set ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY or OPENROUTER_API_KEY.");
}

/**
 * Progress of the hints: in a terminal one line that redraws (spinner, bar, count, time, the page
 * just done) and failures grouped at the end; elsewhere one line per page, as logs want.
 */
function progressBar(total: number): {
  log?: (line: string) => void;
  update: (step: { done: number; page: string; status: string; error?: string }) => void;
  finish: () => void;
} {
  if (!process.stdout.isTTY) return { log: console.log, update: () => {}, finish: () => {} };
  const started = Date.now();
  const failures = new Map<string, string[]>();
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let done = 0;
  let last = "starting";
  let frame = 0;
  const draw = () => {
    const width = 24;
    const filled = Math.round((done / total) * width);
    const seconds = Math.round((Date.now() - started) / 1000);
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const page = last.length > 40 ? `${last.slice(0, 39)}…` : last;
    const mark = last === "done" ? (failures.size ? "!" : "✓") : frames[frame++ % frames.length];
    process.stdout.write(`\r  ${mark} ▕${"█".repeat(filled)}${"░".repeat(width - filled)}▏ ${done}/${total} · ${time} · ${page}\x1b[K`);
  };
  draw();
  const timer = setInterval(draw, 100);
  return {
    update(step) {
      done = step.done;
      last = step.status === "failed" ? `${step.page} (failed)` : step.page;
      if (step.status === "failed") failures.set(step.error ?? "unknown error", [...(failures.get(step.error ?? "unknown error") ?? []), step.page]);
      draw();
    },
    finish() {
      clearInterval(timer);
      last = "done";
      draw();
      process.stdout.write("\n");
      for (const [error, pages] of failures) {
        console.log(`  ${pages.length} ${pages.length === 1 ? "page" : "pages"} without hints: ${error}${pages.length <= 3 ? ` (${pages.join(", ")})` : ""}`);
      }
    },
  };
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
