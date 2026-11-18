// Collects the site: page URLs from the sitemap, each page as Markdown. Prefers the site's own
// Markdown (Accept: text/markdown or <link rel="alternate" type="text/markdown">) and falls back
// to converting the HTML's main content.
import TurndownService from "turndown";

const USER_AGENT = "agent-sitemap (map builder for AI agents; +https://github.com/Laplace-LLC/agent-sitemap)";

export interface FetchedPage {
  url: string;
  markdown: string;
  /** Where the Markdown came from, for the build log. */
  via: "markdown" | "alternate" | "html";
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove((node) =>
  ["SCRIPT", "STYLE", "SVG", "NAV", "HEADER", "FOOTER", "FORM", "BUTTON", "NOSCRIPT", "TEMPLATE"].includes(node.nodeName) ||
  node.getAttribute?.("aria-hidden") === "true",
);

async function get(url: string, accept: string): Promise<Response> {
  return fetch(url, {
    headers: { Accept: accept, "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
}

/** Page URLs from sitemap.xml (or a sitemap index), same host only, in sitemap order. */
export async function discover(site: URL, limit: number): Promise<string[]> {
  const found: string[] = [];
  const queue = [new URL("/sitemap.xml", site).href];
  const seen = new Set<string>();
  while (queue.length && found.length < limit) {
    const sitemap = queue.shift()!;
    if (seen.has(sitemap)) continue;
    seen.add(sitemap);
    const response = await get(sitemap, "application/xml, text/xml;q=0.9");
    if (!response.ok) continue;
    const xml = await response.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decodeXml(m[1]));
    if (/<sitemapindex\b/.test(xml)) queue.push(...locs);
    else for (const loc of locs) if (sameHost(loc, site) && !found.includes(loc)) found.push(loc);
  }
  return found.length ? found.slice(0, limit) : [site.href];
}

export async function fetchPage(url: string): Promise<FetchedPage | null> {
  const response = await get(url, "text/markdown, text/html;q=0.8");
  if (!response.ok) return null;
  const type = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (/markdown/i.test(type)) return { url, markdown: body, via: "markdown" };
  if (!/html/i.test(type)) return null;

  const alternate = body.match(/<link\b[^>]*type=["']text\/markdown["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i)?.[1];
  if (alternate) {
    const md = await get(new URL(alternate, url).href, "text/markdown, text/plain;q=0.9");
    if (md.ok) return { url, markdown: await md.text(), via: "alternate" };
  }
  const main = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? body;
  return { url, markdown: turndown.turndown(main), via: "html" };
}

/** Fetches with a small pool so a big site does not get hammered. */
export async function fetchAll(urls: string[], concurrency = 4, log = (_: string) => {}): Promise<FetchedPage[]> {
  const results: (FetchedPage | null)[] = new Array(urls.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      try {
        results[i] = await fetchPage(urls[i]);
        log(results[i] ? `  ${results[i]!.via.padEnd(9)} ${urls[i]}` : `  skipped   ${urls[i]}`);
      } catch (error) {
        log(`  failed    ${urls[i]}: ${(error as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results.filter((page): page is FetchedPage => page !== null);
}

function sameHost(url: string, site: URL): boolean {
  try {
    return new URL(url).host === site.host;
  } catch {
    return false;
  }
}

function decodeXml(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
