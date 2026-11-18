import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

const text = (topic: string) =>
  `${topic} for people who run a company: what it costs, how long it takes and what to check first.\n\n` +
  `## How it works\n\nThe steps, the numbers and the mistakes that cost the most when ${topic} goes wrong.`;

/** A live site whose sitemap has one post the repository does not: published from somewhere else. */
async function liveSite(): Promise<{ url: string; requests: string[]; close: () => void }> {
  const requests: string[] = [];
  const pages: Record<string, string> = {
    "/blog/kept/": `# Kept post\n\n${text("kept")}`,
    "/blog/only-live/": `# Published from elsewhere\n\n${text("a post that lives only on the server")}`,
  };
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const origin = `http://${req.headers.host}`;
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(`<urlset>${["/blog/kept/", "/blog/only-live/"].map((p) => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>`);
    } else if (pages[req.url!]) {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(pages[req.url!]);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, requests, close: () => server.close() };
}

async function repo(site: string, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-sitemap-live-"));
  const files: Record<string, string> = {
    "blog/kept/post.md": `---\ntitle: Kept post\n---\n\n${text("kept")}`,
    "blog/other/post.md": `---\ntitle: Another post\n---\n\n${text("another")}`,
    "agent-sitemap.config.json": JSON.stringify({ site, out: "public/ai", from: ["blog/*/post.md=/blog/*/"], ...extra }),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

test("takes from the live site the pages the repository does not have", async () => {
  const site = await liveSite();
  try {
    const cwd = await repo(site.url);
    const { stdout } = await run("node", [cli], { cwd });
    assert.match(stdout, /1 page is on the site but not in the repository/);
    assert.match(stdout, /only-live/);
    await access(join(cwd, "public/ai/blog/only-live.md"));
    // What the repository has is read from it, not fetched again.
    assert.ok(!site.requests.includes("/blog/kept/"), site.requests.join(", "));
  } finally {
    site.close();
  }
});

test("--offline and fromSite: false build from the repository only", async () => {
  const site = await liveSite();
  try {
    for (const [args, extra] of [[["--offline"], {}], [[], { fromSite: false }]] as const) {
      const cwd = await repo(site.url, extra);
      const { stdout } = await run("node", [cli, ...args], { cwd });
      assert.doesNotMatch(stdout, /not in the repository/);
      await assert.rejects(access(join(cwd, "public/ai/blog/only-live.md")));
    }
    assert.equal(site.requests.length, 0);
  } finally {
    site.close();
  }
});

test("a site out of reach leaves the map to the repository", async () => {
  const cwd = await repo("http://127.0.0.1:9/");
  const { stdout } = await run("node", [cli], { cwd });
  assert.match(stdout, /the map has the repository's pages only|Every page in/);
  await access(join(cwd, "public/ai/blog/kept.md"));
});
