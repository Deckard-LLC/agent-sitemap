import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { checkMap } from "../src/check.ts";
import { buildGraph } from "../src/graph.ts";
import { parsePage } from "../src/parse.ts";
import { render } from "../src/render.ts";

const run = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

async function writeMap(links: "absolute" | "relative"): Promise<string> {
  const graph = buildGraph([
    parsePage("https://example.com/", "# Studio\n\nWe build AI agents for company processes, from diagnosis to launch.\n\n## Price\n\nWhat an agent costs and how we estimate it before the work starts. [Price guide](/blog/price/)"),
    parsePage("https://example.com/blog/price/", "# Price guide\n\nWhat an AI agent costs: integrations, data, quality checks and the model itself.\n\n## Model\n\nCloud models charge for the text they read and write, so the volume decides the bill."),
  ]);
  const files = render(graph, {
    base: "https://example.com/ai/",
    site: "https://example.com/",
    name: "Example",
    lang: "en",
    generated: "2026-11-17T10:00:00Z",
    producer: "agent-sitemap/test",
    links,
  });
  const dir = await mkdtemp(join(tmpdir(), "agent-sitemap-check-"));
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

for (const links of ["absolute", "relative"] as const) {
  test(`a freshly built map with ${links} links has no problems`, async () => {
    const report = await checkMap(await writeMap(links));
    assert.deepEqual(report.problems, []);
    assert.ok(report.notes >= 4 && report.links >= 4, JSON.stringify(report));
  });
}

test("finds broken links, notes without a type and a non-OKF index", async () => {
  const dir = await writeMap("relative");
  const note = join(dir, "blog/price.md");
  await writeFile(note, (await readFile(note, "utf8")).replace("type: Web Page\n", "").replace("../index.md", "../missing.md"));
  const index = join(dir, "index.md");
  await writeFile(index, (await readFile(index, "utf8")).replace('okf_version: "0.2"', 'okf_version: "0.2"\ntitle: Map'));

  const { problems } = await checkMap(dir);
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems.join("\n"), /blog\/price\.md: frontmatter has no type/);
  assert.match(problems.join("\n"), /blog\/price\.md: link to \.\.\/missing\.md leads to no note/);
  assert.match(problems.join("\n"), /index\.md: an OKF index may carry only okf_version/);
});

test("build refuses to replace a folder that is not a map, before any request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-sitemap-out-"));
  await writeFile(join(dir, "notes.txt"), "someone's work");
  // An unroutable address: if the guard did not stop the build first, it would try to fetch.
  const result = await run("node", [cli, "https://example.invalid", "--out", dir]).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists and is not an agent-sitemap map/);
  assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "someone's work");
});

test("check exits non-zero on problems and explains a missing map", async () => {
  const dir = await writeMap("absolute");
  const ok = await run("node", [cli, "check", dir]);
  assert.match(ok.stdout, /0 problems/);

  const missing = await run("node", [cli, "check", join(dir, "nope")]).catch((error) => error);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No map in .*Build one with: npx agent-sitemap/);
});
