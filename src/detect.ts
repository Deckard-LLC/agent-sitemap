// Finds in a site's repository what a build needs, so that `agent-sitemap` runs with no arguments:
// the site's address, the pages (Markdown with a title, and the built site), where the map goes
// and the llms.txt that should point to it. The result is saved as agent-sitemap.config.json,
// which the user can edit; detection runs only when there is no config yet.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const CONFIG_FILE = "agent-sitemap.config.json";

export type LlmChoice = "none" | "claude" | "codex" | "api" | "deepseek" | "kimi" | "openrouter";

export interface Config {
  /** The site's public address: links in the map point under it. Empty: links inside the map are relative. */
  site: string;
  /** Where the map is written, inside the folder the site serves as is. */
  out: string;
  /** Page sources, as for --from. */
  from: string[];
  /** URL paths left out of the map. */
  exclude?: string[];
  name?: string;
  /** llms.txt that gets one line pointing to the map. */
  llmsTxt?: string;
  /** Who writes the hints: a model reached through the API or an agent CLI, or none. */
  llm?: LlmChoice;
}

export interface Detection {
  /** The site's address and the file it was read from. */
  site: { url: string; from: string } | null;
  /** Page sources, each with what it stands for. */
  sources: { source: string; note: string }[];
  out: string;
  /** The folder served as is, if there is one. */
  staticDir: string | null;
  llmsTxt?: string;
  /** What was found and why, for the build log. */
  notes: string[];
  /** What a build cannot go without, in words for the user. */
  missing: string[];
}

/** A detection as settings, once nothing is missing. */
export function configOf(found: Detection, site = found.site?.url ?? ""): Config {
  return {
    site,
    out: found.out,
    from: found.sources.map((s) => s.source),
    ...(found.llmsTxt ? { llmsTxt: found.llmsTxt } : {}),
  };
}

const BUILD_DIRS = ["dist", "build", "out", "_site"];
const STATIC_DIRS = ["public", "static"];
/** Where web apps live in a monorepo, besides the repository root. */
const APP_PARENTS = ["apps", "packages", "sites", "web", "site", "www", "frontend"];
/** Folder names whose Markdown is not a page of the site. */
const NOT_PAGES = new Set(["node_modules", "revisions", "drafts", "archive", "old", "backup", "templates", "examples", "fixtures", "test", "tests", "__tests__", "vendor", "docs-internal"]);
const NOT_PAGE_FILES = /^(readme|changelog|license|agents|claude|contributing|code_of_conduct|security|todo)\.md$/i;
/** Folders that hold content but are not part of its URL: src/content/blog/x.md → /blog/x/. */
const CONTENT_ROOTS = new Set(["src", "content", "pages", "app"]);
/** Page files that stand for their folder: blog/x/index.md → /blog/x/. */
const FOLDER_PAGES = new Set(["index", "post", "page", "_index"]);

export async function loadConfig(cwd: string): Promise<Config | null> {
  const text = await readFile(join(cwd, CONFIG_FILE), "utf8").catch(() => null);
  if (text === null) return null;
  const config = JSON.parse(text) as Config;
  if (typeof config.site !== "string" || !config.out || !config.from?.length) throw new Error(`${CONFIG_FILE} needs "site", "out" and "from"`);
  return config;
}

export async function saveConfig(cwd: string, config: Config): Promise<void> {
  await writeFile(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export async function detect(cwd: string): Promise<Detection> {
  const notes: string[] = [];
  const missing: string[] = [];
  const files = await repositoryFiles(cwd);

  // The web app: a folder with a static folder or a build, at the root or under apps/ and the like.
  const apps = await webApps(cwd);
  const app = apps[0] ?? null;
  const staticDir = app?.static ?? null;
  const buildDir = app?.build ?? null;

  const site = await siteAddress(cwd, apps);
  if (site) notes.push(`site address ${site.url} (from ${site.from})`);
  else missing.push(`the site's address: put it in ${CONFIG_FILE} as "site", or add a sitemap.xml, robots.txt with Sitemap: or CNAME to the static folder`);

  const sources: Detection["sources"] = [];
  if (buildDir) sources.push({ source: buildDir, note: `built pages in ${buildDir}` });
  for (const group of markdownGroups(await pagesWithTitles(cwd, files))) {
    sources.push({ source: `${group.pattern}=${group.url}`, note: `${group.count} Markdown pages ${group.pattern} → ${group.url}` });
  }
  notes.push(...sources.map((s) => s.note));
  if (!sources.length) missing.push("pages: no built site (dist, build, out) and no Markdown files with a title in front matter");

  const out = staticDir ? `${staticDir}/ai` : "ai";
  notes.push(staticDir ? `map goes to ${out}, served with the site from ${staticDir}` : `map goes to ./${out}: no public or static folder found`);
  const llms = staticDir && files.has(`${staticDir}/llms.txt`) ? `${staticDir}/llms.txt` : undefined;
  if (llms) notes.push(`llms.txt at ${llms} will point to the map`);

  return { site, sources, out, staticDir, ...(llms ? { llmsTxt: llms } : {}), notes, missing };
}

interface WebApp {
  dir: string;
  static: string | null;
  build: string | null;
}

async function webApps(cwd: string): Promise<WebApp[]> {
  const candidates = ["."];
  for (const parent of APP_PARENTS) {
    const entries = await readdir(join(cwd, parent), { withFileTypes: true }).catch(() => []);
    candidates.push(parent, ...entries.filter((e) => e.isDirectory()).map((e) => `${parent}/${e.name}`));
  }
  const apps: WebApp[] = [];
  for (const dir of candidates) {
    const rel = (name: string) => (dir === "." ? name : `${dir}/${name}`);
    let build: string | null = null;
    for (const name of BUILD_DIRS) {
      if ((await exists(join(cwd, rel(name), "index.html"))) || (await exists(join(cwd, rel(name), "index.md")))) {
        build = rel(name);
        break;
      }
    }
    let staticDir: string | null = null;
    for (const name of STATIC_DIRS) {
      if (await isDir(join(cwd, rel(name)))) {
        staticDir = rel(name);
        break;
      }
    }
    // At the root a public folder counts only when it holds files of a site: plenty of repositories
    // have one for other reasons.
    const siteFolder = staticDir && (dir !== "." || (await holdsSiteFiles(join(cwd, staticDir))));
    if (build || siteFolder) apps.push({ dir, static: siteFolder ? staticDir : null, build });
  }
  // The app with both a build and a static folder first: that is the site.
  return apps.sort((a, b) => Number(!!b.build && !!b.static) - Number(!!a.build && !!a.static));
}

async function siteAddress(cwd: string, apps: WebApp[]): Promise<{ url: string; from: string } | null> {
  const places = [...new Set(apps.flatMap((app) => [app.static, app.build]).filter((d): d is string => !!d))];
  for (const dir of places) {
    const cname = (await readFile(join(cwd, dir, "CNAME"), "utf8").catch(() => "")).trim();
    if (cname) return { url: `https://${cname.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/`, from: `${dir}/CNAME` };
    const robots = await readFile(join(cwd, dir, "robots.txt"), "utf8").catch(() => "");
    const sitemapLine = robots.match(/^\s*sitemap:\s*(https?:\/\/\S+)/im)?.[1];
    if (sitemapLine) return { url: `${new URL(sitemapLine).origin}/`, from: `${dir}/robots.txt` };
    const sitemap = await readFile(join(cwd, dir, "sitemap.xml"), "utf8").catch(() => "");
    const loc = sitemap.match(/<loc>\s*(https?:\/\/[^<\s]+)/)?.[1];
    if (loc) return { url: `${new URL(loc).origin}/`, from: `${dir}/sitemap.xml` };
  }
  for (const dir of [".", ...apps.map((app) => app.dir)]) {
    const pkg = await readFile(join(cwd, dir, "package.json"), "utf8").catch(() => "");
    const homepage = pkg && (JSON.parse(pkg) as { homepage?: string }).homepage;
    if (homepage && /^https?:\/\//.test(homepage) && !/github\.com|npmjs\.com/.test(homepage)) {
      return { url: `${new URL(homepage).origin}/`, from: `${dir === "." ? "" : `${dir}/`}package.json homepage` };
    }
  }
  return null;
}

/**
 * Files in the folder, including ones git ignores: content is often kept out of git (posts that live
 * on a server, generated pages). Hidden folders, dependencies, builds and caches are skipped.
 */
async function repositoryFiles(cwd: string): Promise<Set<string>> {
  return new Set(await walk(cwd, cwd));
}

const SKIP_WALK = new Set(["node_modules", "bower_components", "vendor", "coverage", "tmp", "temp", ...BUILD_DIRS]);

async function walk(root: string, dir: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      if (entry.name.startsWith(".") || SKIP_WALK.has(entry.name)) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(root, path, depth + 1);
      return entry.isFile() ? [path.slice(root.length + 1).split("\\").join("/")] : [];
    }),
  );
  return nested.flat();
}

/** Markdown files that are pages: a title in front matter, outside folders of non-pages. */
async function pagesWithTitles(cwd: string, files: Set<string>): Promise<string[]> {
  const pages: string[] = [];
  // Maps built earlier (a folder with graph.json and index.md) are not content.
  const maps = [...files].filter((f) => /(^|\/)graph\.json$/.test(f) && files.has(f.replace(/graph\.json$/, "index.md"))).map((f) => f.replace(/graph\.json$/, ""));
  for (const file of files) {
    if (!/\.md$/i.test(file) || maps.some((dir) => file.startsWith(dir))) continue;
    const parts = file.split("/");
    if (NOT_PAGE_FILES.test(parts.at(-1)!) || parts.slice(0, -1).some((p) => NOT_PAGES.has(p.toLowerCase()) || p.startsWith("."))) continue;
    const text = await readFile(join(cwd, file), "utf8").catch(() => "");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!front) continue;
    try {
      const meta = parseYaml(front) as { title?: unknown } | null;
      if (typeof meta?.title === "string" && meta.title.trim()) pages.push(file);
    } catch {
      // not front matter after all
    }
  }
  return pages;
}

interface Group {
  pattern: string;
  url: string;
  count: number;
}

/** blog/a/post.md + blog/b/post.md → blog/*\/post.md=/blog/*\/ ; one stray page is not a section of the site. */
export function markdownGroups(files: string[]): Group[] {
  const groups = new Map<string, Group>();
  for (const file of files) {
    const parts = file.split("/");
    const name = parts.at(-1)!.replace(/\.md$/i, "");
    let pattern: string;
    let prefix: string[];
    if (FOLDER_PAGES.has(name.toLowerCase()) && parts.length >= 3) {
      prefix = parts.slice(0, -2);
      pattern = [...prefix, "*", parts.at(-1)!].join("/");
    } else {
      prefix = parts.slice(0, -1);
      pattern = [...prefix, "*.md"].join("/");
    }
    let urlParts = prefix;
    while (urlParts.length && CONTENT_ROOTS.has(urlParts[0].toLowerCase())) urlParts = urlParts.slice(1);
    const url = `/${[...urlParts, "*"].join("/")}/`;
    const group = groups.get(pattern) ?? { pattern, url, count: 0 };
    group.count++;
    groups.set(pattern, group);
  }
  return [...groups.values()].filter((g) => g.count >= 2).sort((a, b) => b.count - a.count);
}

/** How long ago a folder was last built, for the build log. */
export async function builtAgo(dir: string): Promise<string | null> {
  const info = await stat(dir).catch(() => null);
  if (!info) return null;
  const hours = (Date.now() - info.mtimeMs) / 3_600_000;
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const SITE_FILES = ["robots.txt", "sitemap.xml", "llms.txt", "CNAME", "favicon.ico", "favicon.svg", "index.html", "manifest.json", "site.webmanifest"];

async function holdsSiteFiles(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return SITE_FILES.some((name) => names.includes(name));
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}
