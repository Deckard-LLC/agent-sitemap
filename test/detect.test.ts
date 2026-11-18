import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { markdownGroups } from "../src/detect.ts";

const run = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

test("groups Markdown pages into patterns with their URLs", () => {
  assert.deepEqual(markdownGroups(["blog/a/post.md", "blog/b/post.md", "notes/x.md"]), [
    { pattern: "blog/*/post.md", url: "/blog/*/", count: 2 },
  ]);
  assert.deepEqual(markdownGroups(["src/content/blog/a.md", "src/content/blog/b.md"]), [
    { pattern: "src/content/blog/*.md", url: "/blog/*/", count: 2 },
  ]);
  assert.deepEqual(markdownGroups(["docs/a/index.md", "docs/b/index.md", "docs/c/index.md"]), [
    { pattern: "docs/*/index.md", url: "/docs/*/", count: 3 },
  ]);
});

const text = (topic: string) =>
  `${topic} explained for people who run a company: what it costs, how long it takes and what to check first.\n\n` +
  `## How it works\n\nA short walk through ${topic}, with the steps, the numbers and the mistakes that cost the most.`;

/** A monorepo of a site nobody configured: a web app with a build and a public folder, posts in blog/. */
async function site(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-sitemap-site-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "studio", private: true }),
    "README.md": "---\ntitle: Not a page\n---\nThe repository readme.",
    "apps/web/public/robots.txt": "User-agent: *\nAllow: /\nSitemap: https://studio.example/sitemap.xml\n",
    "apps/web/public/llms.txt": "# Studio\n\n> AI agents for company processes.\n",
    "apps/web/dist/index.html": `<html><body><main><h1>Studio</h1>${text("AI agents").replace(/\n\n## (.*)\n\n/, "<h2>$1</h2>")}</main></body></html>`,
    "apps/web/dist/yandex_123.html": "<html><body>Verification: 123</body></html>",
    "apps/web/dist/.well-known/skill/SKILL.md": "---\nname: skill\n---\nFor machines.",
    "blog/price/post.md": `---\ntitle: How much an agent costs\ndescription: What an agent costs to build and run.\n---\n\n${text("agent cost")}`,
    "blog/payback/post.md": `---\ntitle: Will an agent pay off\n---\n\n${text("payback")}`,
    "blog/payback/revisions/old.md": `---\ntitle: Old version\n---\n\n${text("old")}`,
    "blog/draft/post.md": `---\ntitle: Draft\nstatus: draft\n---\n\n${text("drafts")}`,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

test("with no arguments, finds the site, saves the settings and builds the map", async () => {
  const cwd = await site();
  const first = await run("node", [cli], { cwd });
  assert.match(first.stdout, /found {2}site address https:\/\/studio\.example\/ \(from apps\/web\/public\/robots\.txt\)/);
  assert.match(first.stdout, /Saved to agent-sitemap\.config\.json/);

  const config = JSON.parse(await readFile(join(cwd, "agent-sitemap.config.json"), "utf8"));
  assert.deepEqual(config, {
    site: "https://studio.example/",
    out: "apps/web/public/ai",
    from: ["apps/web/dist", "blog/*/post.md=/blog/*/"],
    llmsTxt: "apps/web/public/llms.txt",
  });
  assert.match(first.stdout, /skipped {3}apps\/web\/dist\/yandex_123\.html \(almost no text\)/);
  assert.match(first.stdout, /skipped {3}blog\/draft\/post\.md \(draft\)/);
  assert.doesNotMatch(first.stdout, /revisions|SKILL|README/);

  const index = await readFile(join(cwd, "apps/web/public/ai/index.md"), "utf8");
  assert.match(index, /How much an agent costs\]\(https:\/\/studio\.example\/ai\/blog\/price\.md\)/);
  const llms = await readFile(join(cwd, "apps/web/public/llms.txt"), "utf8");
  assert.match(llms, /\n\n- \[Site map for AI agents\]\(https:\/\/studio\.example\/ai\/index\.md\): /);

  // The next build copies public/ai into dist/ai: the map must not map itself, nor touch llms.txt again.
  await cp(join(cwd, "apps/web/public/ai"), join(cwd, "apps/web/dist/ai"), { recursive: true });
  const second = await run("node", [cli], { cwd });
  assert.match(second.stdout, /^Settings from agent-sitemap\.config\.json/);
  assert.match(second.stdout, /\(0 written, \d+ unchanged, 0 removed\)/);
  assert.match(second.stdout, /Nothing changed since the last build/);
  assert.equal(await readFile(join(cwd, "apps/web/public/llms.txt"), "utf8"), llms);
});

test("says what is missing when the repository does not show the site", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-sitemap-empty-"));
  const result = await run("node", [cli], { cwd }).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /missing {2}the site's address/);
  assert.match(result.stderr, /Could not set up the map on my own/);
});
