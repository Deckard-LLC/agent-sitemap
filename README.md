<p align="center">
  <img src="docs/agent-path.svg" width="100%" alt="An agent answers “How much does an AI agent cost, and when does it pay off?” by opening four small notes in turn: the site map, the page on agent cost, its section on model cost, and a similar section on payback from another page. Other pages and sections it saw listed stay closed.">
</p>

<h1 align="center">agent-sitemap</h1>

<p align="center">
  <b>Turns your website into a linked Markdown map that AI agents can walk,<br>opening only the pages they need.</b>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#in-your-repository">In your repository</a> ·
  <a href="#what-an-agent-reads">What an agent reads</a> ·
  <a href="#how-the-links-are-made">How the links are made</a> ·
  <a href="#publish-the-map">Publish the map</a> ·
  <a href="#hints-from-claude">Hints from Claude</a>
</p>

---

An agent that lands on a website has two poor choices: read whole pages and fill its context,
or guess from titles and miss. `agent-sitemap` gives it a third one. It cuts the site into small
notes, one per page and one per section, and links them the way an Obsidian vault is linked.
Every link says what is behind it and how many tokens it costs, so the agent reads a short note,
picks the next step and goes deeper only where the question needs it.

The map is plain Markdown with absolute links. Any agent that can fetch a URL can walk it; it
needs no SDK, no plugin and no server-side search.

## Quick start

```bash
npx agent-sitemap https://example.com
```

This reads the site through its `sitemap.xml`, writes the map to `./ai` and prints the next
steps. You need Node 20 or newer; no API key unless you want [hints from Claude](#hints-from-claude).

```text
Map: 115 notes in ./ai
  pages 15, sections 99
  edges: links 24, lists 13, related 219, next 85
  dropped as repeated template: разберём ваш процесс за 1–2 дня; ещё в блоге; с чего начать
  OKF 0.2 bundle, absolute links

Next steps
  1. Upload ./ai so that https://deckardlab.tech/ai/index.md opens. Rebuild it when the site changes.
  2. Tell agents where it is: add this line to https://deckardlab.tech/llms.txt
  3. Check the map any time: npx agent-sitemap check ./ai
```

<sub>Output of a real build of <a href="https://deckardlab.tech">deckardlab.tech</a>, a Russian-language site.</sub>

## In your repository

The map can also be built from the site's own files, with no requests to the web. Install it in
the site's repository, run it, and commit the result with the site:

```bash
pnpm add -D agent-sitemap
```

```json
{
  "scripts": {
    "sitemap": "agent-sitemap https://example.com --from dist --from \"content/blog/*.md=/blog/*/\" --out public/ai"
  }
}
```

```bash
pnpm run sitemap   # writes public/ai/; commit it, deploy as usual
```

`<site-url>` then only sets the address the links point to. Each `--from` is one of:

| `--from` | Reads | URL of a page |
| --- | --- | --- |
| `dist` | every `.md` and `.html` in a folder: a built site | from the path: `dist/a/index.html` → `/a/`, `dist/a/b.md` → `/a/b` |
| `content/**/*.md` | the files a glob matches (`*` within a folder, `**` across folders) | from the path after the glob's fixed part |
| `blog/*/post.md=/blog/*/` | the same, with the URL given | each `*` in the URL takes what the `*` in the path matched |

From Markdown front matter it takes `title` and `description` (the author's summary is used
as is) and skips pages that are not public: `draft: true`, `status: draft` (also `private`,
`hidden`, `unpublished`, `archived`, `scheduled`), `noindex: true`, and a `publishAt` or
`publishDate` in the future. When a page exists both as `.html` and `.md`, the Markdown wins.

A rebuild rewrites only the notes whose content changed and deletes the notes of pages that are
gone, so the diff shows exactly what changed on the site.

## What an agent reads

The map has three levels:

| Note | What it holds |
| --- | --- |
| `index.md` | The entry point: every page in one line, grouped by section of the site, with a summary, the number of sections and the size in tokens. |
| `<page>.md` | The page's summary and intro, its sections, the pages it links to, the pages that link to it, and similar pages. |
| `<page>/<section>.md` | The full text of one section (split on `##`), then **Where next**: the next section, links from the text and similar sections on other pages. |

A section note, as an agent sees it:

```markdown
---
type: Web Page Section
title: What the model costs to run
description: "Cloud models charge for the text they read and write, measured in tokens."
resource: "https://example.com/blog/agent-cost/"
page: "https://example.com/ai/blog/agent-cost.md"
tokens: 60
---

# What the model costs to run

Section 2 of 3 of [How much an AI agent costs](https://example.com/ai/blog/agent-cost.md) · ≈60 tokens

Cloud models charge for the text they read and write, measured in tokens. Monthly cost = …

## Where next

- Next section: [Why pay in stages](https://example.com/ai/blog/agent-cost/why-pay-in-stages.md) — A fixed price for a turnkey agent before the vendor has seen your data is a warning sign. · ≈50 tokens
- Similar on other pages:
  - [Will an AI agent pay off? → A simple payback calculation](https://example.com/ai/blog/payback/a-simple-payback-calculation.md) — Monthly saving = operations × (minutes now − minutes with the agent) ÷ 60 × hourly cost. · ≈40 tokens
```

Labels follow the language of the site (Russian and English for now; `--lang` overrides it).
Next to the notes, `graph.json` holds the same nodes and typed edges for tools.

## How the links are made

The base build uses no language model and gives the same map for the same site.

| Edge | Source |
| --- | --- |
| `contains` | a page → its sections |
| `next` | a section → the section that follows it |
| `links` | a same-site link written in the section text |
| `lists` | a listing page, such as a blog index, → the pages it lists as `## [Title](/url)` cards |
| `related` | similar content on another page: TF-IDF cosine over stemmed words, at most one section per page |

Sections whose heading repeats across the site (on 3 pages or more, and on at least a quarter
of them) are template parts such as “More from the blog” or a call to action. The build drops
them, and the cards inside them.

Pages are read as Markdown when the site offers it, and converted from HTML otherwise:

1. `Accept: text/markdown`
2. `<link rel="alternate" type="text/markdown">`
3. the page's `<main>`, converted with Turndown

## Publish the map

1. **Upload** `./ai` so that `https://example.com/ai/index.md` opens. To serve it elsewhere,
   build with `--base <url>`.
2. **Point agents at it.** Agents do not look for maps on their own, so add a line to
   `llms.txt`. The build prints it, in the language of the site:

   ```markdown
   - [Site map for AI agents](https://example.com/ai/index.md): linked notes for every page and section, with their size in tokens
   ```

3. **Rebuild** when the site changes, for example after each deploy.
4. **Check** the map at any time. `check` exits with code 1 on problems, so it fits CI:

   ```bash
   npx agent-sitemap check ./ai
   # 115 notes, 901 links between them: 0 problems, 0 warnings — a valid OKF 0.2 map
   ```

The build replaces `--out` completely, so it refuses to write into a folder that is not an
earlier map.

## Hints from Claude

```bash
npx agent-sitemap https://example.com --llm
```

Without a model, the text next to a link is the first sentence of the target. With `--llm`, the
build sends one request per page, with the page's sections and the links that leave it. It
reaches a model in one of three ways (`--llm-with`):

| `--llm-with` | Model | You need |
| --- | --- | --- |
| `api` | the Claude API, `claude-opus-5-5` unless `--model` says otherwise | `ANTHROPIC_API_KEY` |
| `claude` | [Claude Code](https://claude.com/claude-code) on this machine (`claude -p`) | `claude` installed and signed in |
| `codex` | [Codex](https://github.com/openai/codex) on this machine (`codex exec`) | `codex` installed and signed in |

Without `--llm-with`, the build uses the API when `ANTHROPIC_API_KEY` is set, else Claude Code,
else Codex. The agents run with no tools, in a read-only sandbox for Codex: they read the page
they are given and answer with the same JSON schema as the API. The model writes:

- **when to read** each page and section, shown next to every link to it:
  “read if you need to estimate the monthly budget”;
- **why follow** each link: what the target adds for a reader of this note;
- **a factual summary** for each note;
- **which similarity links to drop**: those that only share words. Links written by the site's
  authors are always kept.

Answers are cached in `.agent-sitemap-cache.json` by a hash of each page's content, so a rebuild
pays only for pages that changed. If a request fails, that page keeps its plain annotations and
the build goes on.

## Options

| Option | Default | |
| --- | --- | --- |
| `--from <files>` | | read pages from files instead of the web; repeatable, see [In your repository](#in-your-repository) |
| `--out <dir>` | `./ai` | where to write the map |
| `--base <url>` | `<site>/ai/` | absolute URL the map is served from |
| `--name <name>` | host name | site name in the map title |
| `--max-pages <n>` | `500` | stop after this many pages from the sitemap |
| `--exclude <path>` | | skip pages under this path; repeatable |
| `--lang <ru\|en>` | detected | language of the map's own labels |
| `--links <style>` | `absolute` | `absolute` URLs for agents on the web, or `relative` paths for a self-contained bundle |
| `--llm` | off | hints from a model, see above |
| `--llm-with <how>` | auto | `api`, `claude` or `codex` |
| `--model <id>` | per `--llm-with` | model for `--llm`: `claude-opus-5-5` for the API, the agent's own default otherwise |
| `--cache <file>` | `.agent-sitemap-cache.json` | where `--llm` keeps its answers |

## Open Knowledge Format

The map is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
(OKF v0.2) bundle, so tools that read OKF can open it as is.

- Every note's frontmatter carries the OKF fields `type` (`Web Page` or `Web Page Section`),
  `title`, `description`, `resource` (the page URL) and `generated`, plus this tool's own keys:
  `tokens`, `sections`, `page`, and `when` and `hints_by` after `--llm`.
- `index.md` follows the OKF index format: only `okf_version` in its frontmatter and
  `* [Title](url) - description` entries under headings.
- With `--links relative`, links are paths inside the folder, so OKF tools see the graph and the
  backlinks, and the bundle can live in git. The default absolute URLs suit agents on the web;
  OKF tools read them as external links.

## Status

An early version. On small sites the navigation in each note can cost as much as the text
itself, so the map pays off on larger sites and narrow questions. Next:

- an eval: questions to a site, and the hops and tokens an agent needs with and without the map;
- leaner notes, and token labels that count the whole note, not only its text;
- a GitHub Action that rebuilds the map on every deploy;
- a library API, for building the map from code;
- topic hubs that gather sections across pages.

## Development

The sources are TypeScript that Node 24 runs directly:

```bash
pnpm install
node src/cli.ts https://example.com   # build a map from source
pnpm test                             # tests
pnpm build                            # compile dist/ (runs on npm pack and npm publish)
```

## License

MIT. Made by [Deckard](https://deckardlab.tech), a studio that builds AI agents into company
processes and keeps people in the loop.
