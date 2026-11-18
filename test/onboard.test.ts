import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;

const text = (topic: string) =>
  `${topic} explained for people who run a company: what it costs, how long it takes and what to check first.\n\n` +
  `## How it works\n\nA short walk through ${topic}, with the steps, the numbers and the mistakes that cost the most.`;

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-sitemap-onboard-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

const posts = {
  "blog/price/post.md": `---\ntitle: How much an agent costs\ndescription: What an agent costs to build and run.\n---\n\n${text("agent cost")}`,
  "blog/payback/post.md": `---\ntitle: Will an agent pay off\n---\n\n${text("payback")}`,
};

/** A fake Claude Code that answers every page with hints, as the real one does with --json-schema. */
async function fakeClaude(signedIn = true): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "agent-sitemap-bin-"));
  await writeFile(
    join(bin, "claude"),
    `#!/usr/bin/env node
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: ${signedIn}, authMethod: ${signedIn ? '"claude.ai"' : '"none"'} }));
  process.exit(0);
}
if (!${signedIn}) {
  console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }));
  process.exit(1);
}
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const page = JSON.parse(input);
  const answer = {
    nodes: [page.page, ...page.sections].map((n) => ({ id: n.id, summary: "About " + n.title, when: "you need " + n.title })),
    edges: page.links.map((l) => ({ key: l.key, why: "adds " + l.toTitle, keep: true })),
  };
  console.log(JSON.stringify({ type: "result", is_error: false, structured_output: answer, usage: { input_tokens: 10, output_tokens: 5 } }));
});
`,
  );
  await chmod(join(bin, "claude"), 0o755);
  return bin;
}

/** Runs the CLI as if in a terminal, typing the given answers one per line. */
function answer(cwd: string, lines: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [cli], { cwd, env: { ...process.env, AGENT_SITEMAP_INTERACTIVE: "1", ANTHROPIC_API_KEY: "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(lines.map((l) => `${l}\n`).join(""));
  });
}

test("asks for the address, the pages and the model, and remembers the choice", async () => {
  const cwd = await repo({ ...posts, "public/robots.txt": "Sitemap: https://studio.example/sitemap.xml\n", "public/llms.txt": "# Studio\n" });
  const bin = await fakeClaude();
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}` };
  // Enter for the found address, Enter for the pages, 2 for Claude Code.
  const run = await answer(cwd, ["", "", "2"], env);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /1\/3 {2}Site address[\s\S]*found https:\/\/studio\.example\/ in public\/robots\.txt/);
  assert.match(run.stdout, /2 Markdown pages blog\/\*\/post\.md → \/blog\/\*\//);
  assert.match(run.stdout, /1\) No model[\s\S]*2\) Claude Code, under your subscription/);
  assert.doesNotMatch(run.stdout, /Codex on this machine|Claude API/); // only what is installed

  const config = JSON.parse(await readFile(join(cwd, "agent-sitemap.config.json"), "utf8"));
  assert.deepEqual(config, { site: "https://studio.example/", out: "public/ai", from: ["blog/*/post.md=/blog/*/"], llmsTxt: "public/llms.txt", llm: "claude" });
  assert.match(run.stdout, /Annotating 2 pages with the claude CLI/);
  const price = await readFile(join(cwd, "public/ai/blog/price.md"), "utf8");
  assert.match(price, /^when: you need How much an agent costs$/m);
  assert.match(price, /^description: What an agent costs to build and run\.$/m); // the author's, not the model's

  // The next run asks nothing and keeps using the model from the settings.
  const again = await answer(cwd, [], env);
  assert.match(again.stdout, /^Settings from agent-sitemap\.config\.json/);
  assert.match(again.stdout, /from cache/);
});

test("with no address, builds a map with relative links", async () => {
  const cwd = await repo({ ...posts, "public/llms.txt": "# Studio\n" });
  const run = await answer(cwd, ["", "", ""]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /not found in the repository\. No address yet\? Leave it empty/);
  assert.equal(JSON.parse(await readFile(join(cwd, "agent-sitemap.config.json"), "utf8")).site, "");

  const note = await readFile(join(cwd, "public/ai/blog/price.md"), "utf8");
  assert.match(note, /^resource: "\/blog\/price\/"$/m);
  assert.match(note, /\]\(\.\.\/index\.md\)/);
  assert.doesNotMatch(note, /site\.invalid/);
  assert.match(await readFile(join(cwd, "public/llms.txt"), "utf8"), /\]\(\/ai\/index\.md\)/);
  assert.match(run.stdout, /the map opens at \/ai\/index\.md on the site/);
});

test("saves nothing when the pages are declined", async () => {
  const cwd = await repo({ ...posts, "public/robots.txt": "Sitemap: https://studio.example/sitemap.xml\n" });
  const run = await answer(cwd, ["", "n"]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Nothing saved/);
  await assert.rejects(access(join(cwd, "agent-sitemap.config.json")));
});

test("an agent that is not signed in is shown but cannot be chosen, and the build says so once", async () => {
  const cwd = await repo({ ...posts, "public/robots.txt": "Sitemap: https://studio.example/sitemap.xml\n" });
  const bin = await fakeClaude(false);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}` };
  // Address, pages, then 2 (not signed in: refused), then Enter for «No model».
  const run = await answer(cwd, ["", "", "2", ""], env);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /2\) Claude Code, under your subscription \(not signed in, run: claude auth login\)/);
  assert.equal(JSON.parse(await readFile(join(cwd, "agent-sitemap.config.json"), "utf8")).llm, "none");
  assert.doesNotMatch(run.stdout, /Annotating/);

  // Settings that ask for Claude while it is signed out: one line, then a map without hints.
  const config = JSON.parse(await readFile(join(cwd, "agent-sitemap.config.json"), "utf8"));
  await writeFile(join(cwd, "agent-sitemap.config.json"), JSON.stringify({ ...config, llm: "claude" }));
  const build = await answer(cwd, [], env);
  assert.match(build.stdout, /Claude Code is installed but not signed in: run `claude auth login`, then build again\. Building without hints for now\./);
  assert.doesNotMatch(build.stdout, /failed {4}/);
});
