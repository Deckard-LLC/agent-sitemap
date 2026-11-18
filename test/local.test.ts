import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseSource, readLocal } from "../src/local.ts";

const run = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const site = new URL("https://example.com/");

const post = (front: string, body: string) => `---\n${front}\n---\n\n${body}\n`;
const price =
  "Integrations drive the price of an agent: one system with a good API is cheap, three without one cost more.\n\n" +
  "## What the model costs\n\nCloud models charge for the text they read and write, so the volume of requests decides the bill.\n\n" +
  "## Pay in stages\n\nPay for diagnosis, then a pilot, then the rollout. See [whether it pays off](/blog/payback/).";
const payback =
  "A simple calculation tells whether an agent saves money before anyone builds it.\n\n" +
  "## The calculation\n\nMonthly saving is operations times minutes saved, divided by sixty, times the hourly cost of the work.\n\n" +
  "## When not to build\n\nIf the process runs a few times a month, a checklist beats an agent and costs nothing to run.";

/** A repository with blog sources (one draft, one scheduled) and a built landing page. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-sitemap-local-"));
  const files: Record<string, string> = {
    "blog/price/post.md": post('title: "How much an agent costs"\ndescription: What an agent costs to build and run.\nstatus: published\npublishAt: 2026-10-29 10:00', price),
    "blog/payback/post.md": post("title: Will an agent pay off?\nstatus: published\ndate: 2026-10-30", payback),
    "blog/payback/habr.md": "A copy for another platform, not a page of the site.",
    "blog/secret/post.md": post("title: Not yet\nstatus: draft", "Draft text that must not reach the map, however long it is."),
    "blog/later/post.md": post("title: Later\nstatus: published\npublishAt: 2999-01-01 10:00", "Scheduled text that must not reach the map yet."),
    "dist/index.html": "<html><body><nav>Menu</nav><main><h1>Studio</h1><p>We build AI agents into company processes, from diagnosis to launch.</p><h2>How we work</h2><p>We start with one process and the data behind it, then a pilot on real cases.</p></main></body></html>",
    "dist/index.md": "# Studio\n\nWe build AI agents into company processes, from diagnosis to launch.\n\n## How we work\n\nWe start with one process and the data behind it, then a pilot on real cases.",
    "dist/assets/app.js": "console.log('not a page')",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

test("parses sources with and without a URL pattern", () => {
  assert.deepEqual(parseSource("blog/*/post.md=/blog/*/"), { pattern: "blog/*/post.md", url: "/blog/*/" });
  assert.deepEqual(parseSource("dist"), { pattern: "dist" });
  assert.deepEqual(parseSource("docs/**/*.md=docs/**"), { pattern: "docs/**/*.md", url: "/docs/**" });
});

test("reads Markdown sources and built pages, skipping drafts, scheduled posts and duplicates", async () => {
  const cwd = await repo();
  const { pages, skipped } = await readLocal(
    [parseSource("dist"), parseSource("blog/*/post.md=/blog/*/")],
    site,
    { cwd, now: new Date("2026-11-18T12:00:00Z") },
  );
  assert.deepEqual(
    pages.map((p) => [p.file, p.url]),
    [
      ["dist/index.md", "https://example.com/"],
      ["blog/payback/post.md", "https://example.com/blog/payback/"], // newest first
      ["blog/price/post.md", "https://example.com/blog/price/"],
    ],
  );
  assert.deepEqual(
    skipped.map((s) => `${s.file}: ${s.reason}`).sort(),
    ["blog/later/post.md: scheduled for 2999-01-01 10:00", "blog/secret/post.md: draft", "dist/index.html: same URL as dist/index.md"],
  );
  const priceDoc = pages.find((p) => p.file === "blog/price/post.md")!;
  assert.match(priceDoc.markdown, /^# How much an agent costs\n/);
  assert.equal(priceDoc.description, "What an agent costs to build and run.");
});

test("--from builds the map offline, and a rebuild without changes rewrites nothing", async () => {
  const cwd = await repo();
  const args = [cli, "https://example.com", "--from", "dist/index.md=/", "--from", "blog/*/post.md=/blog/*/", "--out", "public/ai"];
  const first = await run("node", args, { cwd });
  assert.match(first.stdout, /Map: \d+ notes in \.\/public\/ai \((\d+) written, 0 unchanged, 0 removed\)/);
  assert.match(first.stdout, /Commit \.\/public\/ai and deploy it with the site/);

  const note = join(cwd, "public/ai/blog/price.md");
  const text = await readFile(note, "utf8");
  assert.match(text, /^description: What an agent costs to build and run\.$/m); // the author's description
  assert.match(text, /^resource: "https:\/\/example\.com\/blog\/price\/"$/m);
  const before = (await stat(note)).mtimeMs;

  const second = await run("node", args, { cwd });
  assert.match(second.stdout, /\(0 written, \d+ unchanged, 0 removed\)/);
  assert.equal((await stat(note)).mtimeMs, before);

  // A post goes back to draft: its page note and both section notes are removed with their folder.
  await writeFile(join(cwd, "blog/payback/post.md"), post("title: Will an agent pay off?\nstatus: draft", payback));
  const third = await run("node", args, { cwd });
  assert.match(third.stdout, /, 3 removed\)/);
  await assert.rejects(stat(join(cwd, "public/ai/blog/payback")));
  assert.equal((await run("node", [cli, "check", "public/ai"], { cwd })).stdout.match(/(\d+) problems/)?.[1], "0");
});

test("--from reports a pattern that matches nothing", async () => {
  const cwd = await repo();
  const result = await run("node", [cli, "https://example.com", "--from", "content/*.md"], { cwd }).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--from content\/\*\.md: no files match/);
});
