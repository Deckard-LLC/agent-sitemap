// Checks a built map: the OKF structure, links between notes, and notes an agent cannot judge.
import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CheckReport {
  notes: number;
  /** Links from one note to another that were checked. */
  links: number;
  /** The map is broken: not OKF, or a link leads nowhere. */
  problems: string[];
  /** The map works, but an agent gets less help: e.g. a note without a description. */
  warnings: string[];
}

export async function checkMap(dir: string): Promise<CheckReport> {
  const paths = (await walk(dir)).map((path) => relative(dir, path).split(sep).join("/"));
  const notes = new Set(paths.filter((path) => path.endsWith(".md")));
  const report: CheckReport = { notes: notes.size, links: 0, problems: [], warnings: [] };
  if (!notes.has("index.md")) report.problems.push("index.md is missing: agents have no entry point");

  // graph.json knows the URL the map is served from, so absolute links can be checked too.
  let base: string | undefined;
  if (paths.includes("graph.json")) {
    try {
      base = (JSON.parse(await readFile(join(dir, "graph.json"), "utf8")) as { base?: string }).base;
    } catch {
      report.problems.push("graph.json is not valid JSON");
    }
  }

  for (const path of notes) {
    const text = await readFile(join(dir, path), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    let fields: Record<string, unknown> | null = null;
    try {
      fields = match ? ((parseYaml(match[1]) ?? {}) as Record<string, unknown>) : null;
    } catch (error) {
      report.problems.push(`${path}: frontmatter is not valid YAML (${(error as Error).message.split("\n")[0]})`);
      continue;
    }

    if (posix.basename(path) === "index.md") {
      const extra = Object.keys(fields ?? {}).filter((key) => key !== "okf_version");
      if (extra.length) report.problems.push(`${path}: an OKF index may carry only okf_version in its frontmatter, found ${extra.join(", ")}`);
    } else if (!fields) {
      report.problems.push(`${path}: no frontmatter; every OKF note needs one with a type`);
    } else {
      if (typeof fields.type !== "string" || !fields.type.trim()) report.problems.push(`${path}: frontmatter has no type`);
      if (!fields.description) report.warnings.push(`${path}: no description, so links to it say only the title`);
    }

    for (const [, url] of text.matchAll(/\]\(<?([^)\s>]+\.md)(?:#[^)\s>]*)?>?\)/g)) {
      let target: string;
      if (base && url.startsWith(base)) target = url.slice(base.length);
      else if (/^[a-z][a-z\d+.-]*:/i.test(url)) continue; // another site
      else if (url.startsWith("/")) target = url.slice(1); // OKF bundle-relative
      else target = posix.normalize(posix.join(posix.dirname(path), decodeURI(url)));
      report.links++;
      if (!notes.has(decodeURI(target))) report.problems.push(`${path}: link to ${url} leads to no note`);
    }
  }
  return report;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : Promise.resolve([join(dir, entry.name)]))),
  );
  return nested.flat();
}
