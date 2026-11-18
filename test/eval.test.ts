import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { report, type Run } from "../src/eval.ts";

const run = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

const text = (topic: string) =>
  `${topic} for people who run a company: what it costs, how long it takes and what to check first.\n\n` +
  `## How it works\n\nThe steps, the numbers and the mistakes that cost the most when ${topic} goes wrong.`;

test("the report compares the two starts", () => {
  const base: Omit<Run, "condition" | "fetches" | "inputTokens" | "costUsd" | "seconds"> = {
    question: "q", run: 1, answer: "", verdict: "correct", why: "", foundPage: true, fetched: [], chars: 1000, outputTokens: 10, turns: 4,
  };
  const out = report([
    { ...base, condition: "no map", fetches: 6, inputTokens: 60_000, costUsd: 0.08, seconds: 20 },
    { ...base, condition: "map", fetches: 3, inputTokens: 30_000, costUsd: 0.04, seconds: 10 },
  ]);
  assert.match(out, /Correct answers: 1\/1 without the map, 1\/1 with it\./);
  assert.match(out, /tokens -50%, pages fetched -50%, text read 0%, time -50%, cost -50%/);
  assert.match(out, /«Text read» is the site the agent read/);
});

test("eval runs an agent from the home page and from the map, grades and reports", async () => {
  // The live site.
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(`<urlset><url><loc>${origin}/blog/kept/</loc></url></urlset>`);
    } else if (req.url === "/" || req.url === "/blog/kept/") {
      res.writeHead(200, { "Content-Type": "text/markdown" });
      res.end(req.url === "/" ? `# Studio\n\n[Blog post](${origin}/blog/kept/)` : `# Kept post\n\n${text("kept")}`);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  const cwd = await mkdtemp(join(tmpdir(), "agent-sitemap-eval-"));
  for (const [path, content] of Object.entries({
    "blog/kept/post.md": `---\ntitle: Kept post\n---\n\n${text("kept")}`,
    "blog/other/post.md": `---\ntitle: Another post\n---\n\n${text("another")}`,
    "agent-sitemap.config.json": JSON.stringify({ site, out: "public/ai", from: ["blog/*/post.md=/blog/*/"], fromSite: false }),
    "agent-sitemap.eval.json": JSON.stringify({ questions: [{ id: "steps", question: "What are the steps?", answer: "The steps and numbers", page: "/blog/kept/" }] }),
  })) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }

  // A fake Claude Code: signed in, an agent that walks the stand, a judge that says «correct».
  const bin = await mkdtemp(join(tmpdir(), "agent-sitemap-bin-"));
  await writeFile(
    join(bin, "claude"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  if (args.includes("--json-schema")) {
    console.log(JSON.stringify({ is_error: false, structured_output: { verdict: "correct", why: "same facts" }, usage: { input_tokens: 5 } }));
    return;
  }
  const start = input.match(/Start at (\\S+)/)[1];
  const origin = new URL(start).origin;
  const paths = start.endsWith("/ai/index.md") ? ["/ai/index.md", "/ai/blog/kept.md", "/ai/blog/kept/how-it-works.md"] : ["/", "/blog/kept/", "/blog/kept/", "/sitemap.xml"];
  let chars = 0;
  for (const p of paths) chars += (await (await fetch(origin + p)).text()).length;
  console.log(JSON.stringify({ is_error: false, result: "The steps and the numbers. " + origin + paths.at(-1), num_turns: paths.length + 1, total_cost_usd: chars / 100000, usage: { input_tokens: chars * 3 } }));
});
`,
  );
  await chmod(join(bin, "claude"), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: join(cwd, ".config-home") };

  try {
    await run("node", [cli], { cwd, env });
    const { stdout } = await run("node", [cli, "eval", "--yes"], { cwd, env });
    assert.match(stdout, /1 questions × 2 starts \(home page, map\) × 1 = 2 agent runs/);
    assert.match(stdout, /steps · no map: correct, 4 pages/);
    assert.match(stdout, /steps · map: correct, 3 pages/);
    assert.match(stdout, /Correct answers: 1\/1 without the map, 1\/1 with it\./);
    assert.match(stdout, /pages fetched -25%/);

    const saved = JSON.parse(await readFile(join(cwd, "agent-sitemap.eval.results.json"), "utf8"));
    const map = saved.runs.find((r: Run) => r.condition === "map");
    assert.deepEqual(map.fetched, ["/ai/index.md", "/ai/blog/kept.md", "/ai/blog/kept/how-it-works.md"]);
    assert.equal(map.foundPage, true);
    assert.ok(saved.runs.every((r: Run) => r.foundPage === true));
  } finally {
    server.close();
  }
});

test("eval writes a template when there are no questions yet", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-sitemap-eval-"));
  const { stdout } = await run("node", [cli, "eval"], { cwd });
  assert.match(stdout, /Created \.\/agent-sitemap\.eval\.json\. Put 10–30 questions/);
  assert.ok(JSON.parse(await readFile(join(cwd, "agent-sitemap.eval.json"), "utf8")).questions.length);
});
