// Reads the site from files in the repository instead of the web: Markdown sources (with front
// matter) and built HTML or Markdown. Each source is «<path or glob>[=<url pattern>]»:
//   apps/web/dist                    every .md/.html under it, URL from the path (dist/a/index.html → /a/)
//   content/**/*.md                  matched files, URL from the path after the glob's fixed part
//   blog/*/post.md=/blog/*/          each * in the URL takes the text the * in the path matched
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { htmlToMarkdown } from "./fetch.ts";

export interface Source {
  pattern: string;
  /** URL path pattern; without it the URL comes from the file's path. */
  url?: string;
}

export interface LocalPage {
  url: string;
  /** The file, relative to the working directory, for the build log. */
  file: string;
  markdown: string;
  title?: string;
  description?: string;
}

export interface Skipped {
  file: string;
  reason: string;
}

const PAGE_FILE = /\.(?:md|markdown|html?)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** Front-matter states that mean «not on the site». */
const HIDDEN = new Set(["draft", "private", "hidden", "unpublished", "archived", "scheduled"]);

export function parseSource(spec: string): Source {
  const at = spec.indexOf("=");
  if (at < 0) return { pattern: spec };
  const url = spec.slice(at + 1).trim();
  return { pattern: spec.slice(0, at).trim(), url: url.startsWith("/") ? url : `/${url}` };
}

/** Pages from local files, in source order; within a source the newest dated page first. */
export async function readLocal(
  sources: Source[],
  site: URL,
  options: { cwd?: string; now?: Date } = {},
): Promise<{ pages: LocalPage[]; skipped: Skipped[] }> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const pages: LocalPage[] = [];
  const skipped: Skipped[] = [];
  const byUrl = new Map<string, LocalPage>();

  for (const source of sources) {
    const matches = await match(source.pattern, cwd);
    if (!matches.length) {
      const folder = !source.pattern.includes("*") && /^(?:.*\/)?(?:dist|build|out|_site)$/.test(source.pattern);
      throw new Error(folder ? `${source.pattern} not found: build the site first, its pages go into the map` : `--from ${source.pattern}: no files match`);
    }
    const found: (LocalPage & { date: number })[] = [];
    for (const { file, captures, rest } of matches) {
      const shown = relative(cwd, file).split(sep).join("/");
      const path = source.url ? fill(source.url, captures) : urlFromPath(rest);
      const raw = await readFile(file, "utf8");
      if (/\.html?$/i.test(file)) {
        const markdown = htmlToMarkdown(raw);
        // Search-console verification files and redirects: a page with next to no text.
        if (markdown.replace(/[^\p{L}\p{N}]+/gu, "").length < 80) {
          skipped.push({ file: shown, reason: "almost no text" });
          continue;
        }
        found.push({ url: new URL(path, site).href, file: shown, markdown, date: 0 });
        continue;
      }
      const { meta, body } = frontMatter(raw);
      const hidden = hiddenReason(meta, now);
      if (hidden) {
        skipped.push({ file: shown, reason: hidden });
        continue;
      }
      const title = text(meta.title);
      found.push({
        url: new URL(path, site).href,
        file: shown,
        // A title kept in front matter becomes the page heading the parser looks for.
        markdown: title && !/^#\s+\S/m.test(body) ? `# ${title}\n\n${body}` : body,
        title,
        description: text(meta.description),
        date: Date.parse(text(meta.publishAt) ?? text(meta.date) ?? "") || 0,
      });
    }
    found.sort((a, b) => b.date - a.date || a.file.localeCompare(b.file));
    for (const { date: _date, ...page } of found) {
      const earlier = byUrl.get(page.url);
      if (earlier) {
        // The same page built as both HTML and Markdown: keep the Markdown, the cleaner source.
        const html = (file: string) => /\.html?$/i.test(file);
        const [kept, dropped] = html(earlier.file) && !html(page.file) ? [page, { ...earlier }] : [earlier, page];
        if (kept === page) Object.assign(earlier, page);
        skipped.push({ file: dropped.file, reason: `same URL as ${kept.file}` });
        continue;
      }
      byUrl.set(page.url, page);
      pages.push(page);
    }
  }
  return { pages, skipped };
}

interface Match {
  file: string;
  /** What each * or ** in the pattern matched, in order. */
  captures: string[];
  /** The path after the pattern's fixed part, for URLs taken from paths. */
  rest: string;
}

async function match(pattern: string, cwd: string): Promise<Match[]> {
  const parts = pattern.split(/[\\/]+/);
  const fixed = parts.findIndex((part) => part.includes("*"));
  if (fixed < 0) {
    const path = join(cwd, pattern);
    const info = await stat(path).catch(() => null);
    if (!info) return [];
    if (info.isFile()) return [{ file: path, captures: [], rest: parts.at(-1)! }];
    return (await walk(path)).filter((file) => PAGE_FILE.test(file)).map((file) => ({ file, captures: [], rest: relative(path, file).split(sep).join("/") }));
  }
  const root = join(cwd, ...parts.slice(0, fixed));
  // * matches within one path segment, ** any number of whole segments (including none).
  let source = "";
  parts.slice(fixed).forEach((part, i, all) => {
    if (part === "**") source += "(?:(.*)/)?";
    else source += part.split("*").map(escapeRegex).join("([^/]*)") + (i < all.length - 1 ? "/" : "");
  });
  const regex = new RegExp(`^${source}$`);
  const files = await walk(root).catch(() => [] as string[]);
  return files.flatMap((file) => {
    const rest = relative(root, file).split(sep).join("/");
    const found = regex.exec(rest);
    return found ? [{ file, captures: found.slice(1).map((c) => c ?? ""), rest }] : [];
  });
}

async function walk(dir: string, top = true): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // A map built earlier and copied into the build (dist/ai) is not a page of the site.
  if (!top && entries.some((e) => e.name === "graph.json") && entries.some((e) => e.name === "index.md")) return [];
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      // .well-known and other dot folders hold files for machines, not pages.
      if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") ? [] : walk(path, false);
      return entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

/** a/index.html → /a/, a/b.md → /a/b, index.md → / */
function urlFromPath(rest: string): string {
  const path = rest.replace(PAGE_FILE, "");
  if (path === "index") return "/";
  return path.endsWith("/index") ? `/${path.slice(0, -"index".length)}` : `/${path}`;
}

function fill(url: string, captures: string[]): string {
  let i = 0;
  return url.replace(/\*\*|\*/g, () => captures[i++] ?? "").replace(/\/{2,}/g, "/");
}

function frontMatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const text = raw.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const found = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!found) return { meta: {}, body: text };
  let meta: unknown;
  try {
    meta = parseYaml(found[1]);
  } catch {
    meta = {};
  }
  return { meta: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}, body: text.slice(found[0].length) };
}

function hiddenReason(meta: Record<string, unknown>, now: Date): string | null {
  if (meta.draft === true) return "draft";
  if (meta.noindex === true) return "noindex";
  const status = text(meta.status)?.toLowerCase();
  if (status && HIDDEN.has(status)) return status;
  const at = text(meta.publishAt) ?? text(meta.publishDate);
  if (at && Date.parse(at) > now.getTime()) return `scheduled for ${at}`;
  return null;
}

function text(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const escapeRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
