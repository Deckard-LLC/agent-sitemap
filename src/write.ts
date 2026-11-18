// Writes the map so that a rebuild touches only what changed: a note whose content is the same
// keeps its file (and its old `generated` time), notes that are gone are removed. A map kept in
// git then shows in the diff exactly the pages that changed.
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export interface WriteReport {
  written: number;
  unchanged: number;
  removed: number;
}

export async function writeMap(out: string, files: Map<string, string>): Promise<WriteReport> {
  const report: WriteReport = { written: 0, unchanged: 0, removed: 0 };
  const existing = new Set((await walk(out).catch(() => [] as string[])).map((file) => relative(out, file).split(sep).join("/")));

  for (const [path, content] of files) {
    const target = join(out, path);
    if (existing.has(path)) {
      const old = await readFile(target, "utf8");
      if (withoutBuildTime(old) === withoutBuildTime(content)) {
        report.unchanged++;
        continue;
      }
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    report.written++;
  }

  for (const path of existing) {
    if (files.has(path)) continue;
    await rm(join(out, path), { force: true });
    report.removed++;
    await removeEmptyParents(out, dirname(join(out, path)));
  }
  return report;
}

/** The build time and producer are not content: «generated» in note front matter and graph.json. */
function withoutBuildTime(text: string): string {
  return text.replace(/^generated: .*$/m, "").replace(/^ {2}"generated": .*$/m, "");
}

async function removeEmptyParents(root: string, dir: string): Promise<void> {
  while (dir.startsWith(root) && dir !== root) {
    if ((await readdir(dir).catch(() => ["?"])).length) return;
    await rmdir(dir);
    dir = dirname(dir);
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : Promise.resolve([join(dir, entry.name)]))),
  );
  return nested.flat();
}
