// One page of Markdown → title, summary, sections (split on ##) and outgoing links.
import { isCyrillic, isShout, plain, slugify, summarize } from "./text.ts";

export interface Section {
  title: string;
  slug: string;
  /** Cleaned Markdown of the section, without its own heading. */
  body: string;
  /** Same-site page keys this section links to. */
  links: string[];
}

export interface Page {
  key: string;
  url: string;
  title: string;
  summary: string;
  /** Text between the title and the first section. */
  intro: string;
  sections: Section[];
  /** Pages this one lists as cards (a «## [Title](/url)» heading): blog indexes, catalogues. */
  lists: Listing[];
  /** Whole cleaned page, to estimate the cost of reading it in full. */
  fullText: string;
  /** The summary was written by the page's author (front-matter description), not taken from the text. */
  authoredSummary?: boolean;
}

export interface Listing {
  key: string;
  /** Title of the section the card sits in, null before the first section. */
  under: string | null;
}

/** Removes the trailing, still open list item (indented lines and its «* » first line). */
function dropOpenListItem(lines: string[]): void {
  while (lines.length && (!lines.at(-1)!.trim() || /^\s+\S/.test(lines.at(-1)!))) lines.pop();
  if (lines.length && /^\s*[*+-]\s/.test(lines.at(-1)!)) lines.pop();
}

/** Same-site URL → stable key: path without trailing slash or .html, «/» for the home page. */
export function pageKey(url: string): string {
  const path = new URL(url).pathname.replace(/\/index\.html?$/, "/").replace(/\.html?$/, "").replace(/\/+$/, "");
  return path || "/";
}

const LINK = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export interface PageMeta {
  /** A summary written by the author (front-matter description), used instead of the first sentence. */
  summary?: string;
}

export function parsePage(url: string, raw: string, meta: PageMeta = {}): Page {
  const lines = raw.replace(/\r\n?/g, "\n").replace(/^﻿/, "").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const h1 = lines.findIndex((line) => /^#\s+\S/.test(line));
  let title = "";
  let start = 0;
  if (h1 >= 0) {
    const joined = joinHeading(lines, h1);
    title = joined.text;
    start = joined.next;
  }

  // A heading that is itself a link to another page is a card in a listing, not content.
  // Cards come as headings nested in list items, hence the optional indent.
  const CARD = /^\[([^\]]+)\]\(([^)]+)\)$/;
  const blocks: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  const lists: Listing[] = [];
  let owner: string | null = null;
  let inCard = false;
  for (let i = start; i < lines.length; i++) {
    if (/^\s{0,8}(?:[*+-]\s+)?##\s+\S/.test(lines[i])) {
      const joined = joinHeading(lines, i);
      i = joined.next - 1;
      const card = joined.text.match(CARD);
      if (card) {
        // The card's list item (cover, byline) opened before its heading: drop it from the text.
        if (!inCard) dropOpenListItem(blocks.at(-1)!.lines);
        const key = resolve(card[2], url);
        if (key && !lists.some((l) => l.key === key)) lists.push({ key, under: owner });
        inCard = true;
        continue;
      }
      blocks.push({ heading: joined.text, lines: [] });
      owner = plain(joined.text);
      inCard = false;
    } else if (!inCard) {
      blocks.at(-1)!.lines.push(lines[i]);
    } else if (/^\S/.test(lines[i]) && !/^[*+-]\s/.test(lines[i])) {
      // Text back at the left margin, not another card: the listing is over.
      inCard = false;
      blocks.at(-1)!.lines.push(lines[i]);
    }
  }

  const sections: Section[] = [];
  const slugs = new Set<string>();
  for (const block of blocks.slice(1)) {
    const heading = block.heading!;
    const body = clean(block.lines.join("\n"));
    let slug = slugify(heading);
    for (let n = 2; slugs.has(slug); n++) slug = `${slugify(heading)}-${n}`;
    slugs.add(slug);
    sections.push({ title: plain(heading), slug, body, links: linksIn(body, url) });
  }

  const lead = clean(blocks[0].lines.join("\n"));
  const summary = meta.summary?.replace(/\s+/g, " ").trim() || summarize(lead || sections[0]?.body || "");
  // The summary is shown above the intro; do not print the same paragraph twice.
  const intro = lead
    .split(/\n\s*\n/)
    .filter((p) => plain(p).replace(/\s+/g, " ").trim() !== summary)
    .join("\n\n");
  return {
    key: pageKey(url),
    url,
    title: plain(title) || pageKey(url),
    summary,
    intro,
    sections,
    lists,
    fullText: [title, intro, ...sections.map((s) => `${s.title}\n${s.body}`)].join("\n\n"),
    ...(meta.summary?.trim() ? { authoredSummary: true } : {}),
  };
}

/**
 * A heading with a hard line break («## Технологии сложные␠␠» + «_Польза — понятная_»)
 * is one visual heading split over two Markdown lines; glue the parts back together.
 */
function joinHeading(lines: string[], at: number): { text: string; next: number } {
  let text = lines[at].replace(/^\s*(?:[*+-]\s+)?#+\s+/, "");
  let next = at + 1;
  while (/\s{2}$|\\$/.test(text) && next < lines.length && lines[next].trim() && !/^#/.test(lines[next])) {
    const head = text.replace(/\s+$|\\$/g, "");
    const tail = plain(lines[next]).trim();
    // «Расскажите» + «о вашей задаче» reads on; «Технологии сложные» + «Польза — понятная» is a new sentence.
    text = /[,:;—–?!.…-]$/.test(head) || /^\p{Ll}/u.test(tail) ? `${head} ${tail}` : `${head}. ${tail}`;
    next++;
  }
  return { text: text.trim(), next };
}

/** Drops widget blocks, images-as-links, eyebrow labels and runs of blank lines; images keep their alt text. */
function clean(markdown: string): string {
  const text = markdown
    // ```widget name``` blocks are mount points for scripts on the page: nothing for a reader.
    .replace(/^```widget\b[^\n]*\n[\s\S]*?\n```[ \t]*$/gm, "")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt.trim() ? `_(${imageLabel(alt)}: ${alt.trim()})_` : ""))
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !isShout(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

const imageLabel = (alt: string) => (isCyrillic(alt) ? "Иллюстрация" : "Image");

function linksIn(markdown: string, base: string): string[] {
  const keys: string[] = [];
  for (const match of markdown.matchAll(LINK)) {
    const key = resolve(match[2], base);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** A same-site page link → page key; anchors, other hosts, files and the API are ignored. */
function resolve(href: string, base: string): string | null {
  if (href.startsWith("#")) return null;
  try {
    const target = new URL(href, base);
    if (target.host !== new URL(base).host) return null;
    if (/\.(?:png|jpe?g|webp|gif|svg|pdf|xml|json|txt)$/i.test(target.pathname)) return null;
    if (target.pathname.startsWith("/api/")) return null;
    return pageKey(target.href);
  } catch {
    return null;
  }
}
