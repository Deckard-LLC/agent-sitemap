# site-graph

Turns a website into a map of small linked Markdown notes that an AI agent can walk like an
Obsidian vault. The agent no longer has to read a whole page. It reads a short note, sees where
each link leads, why it might follow it and how many tokens that costs, and goes deeper only
where the question needs it.

```bash
npx site-graph https://example.com
# → ai/index.md, ai/<page>.md, ai/<page>/<section>.md, ai/graph.json
```

Upload `ai/` so that `https://example.com/ai/index.md` opens (or pass `--base` for another
place), and point agents at it from `llms.txt`. The build prints the exact line to add. Rebuild
the map when the site changes.

```bash
npx site-graph check ai    # OKF structure, links between notes, notes without a description
```

`--out` is wiped before writing, so the build refuses a folder that is not an earlier map.

The output is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
(OKF v0.2) bundle, so tools that read OKF can open the map as is.

## What it builds

- **`index.md`** is the entry point. It lists pages grouped by the first segment of their path,
  each with a one-line summary, its section count and its size in tokens.
- **One note per page** holds the summary, the intro and the list of sections. It also lists the
  pages it links to, the pages that link to it (backlinks) and similar pages.
- **One note per section** (split on `##`) holds the full text of the section. Below it,
  «Where next» gives the next section, the links from the text and similar sections on other
  pages.
- **`graph.json`** holds the same nodes and typed edges for tools.

By default every link is an absolute URL under `--base`, so the notes work with any plain web
fetch and need no special client. `--links relative` writes paths inside the folder instead (see
below).

## OKF

Each note is an OKF concept. Its frontmatter carries:

- the OKF fields: `type` (`Web Page` or `Web Page Section`), `title`, `description`, `resource`
  (the page URL) and `generated` (`by: site-graph/<version>`, `at: <build time>`);
- this tool's own keys, which OKF allows: `tokens`, `sections`, `page` (the section's page note),
  and `when` and `hints_by` after `--llm`.

`index.md` follows the OKF index format: only `okf_version` in its frontmatter, and
`* [Title](url) - description` entries under headings.

Links between notes are ordinary Markdown links, as OKF expects. Two styles:

- `--links absolute` (default): URLs under `--base`. Use this to serve the map on the site for
  agents on the web. OKF consumers accept the bundle but see the links as external.
- `--links relative`: paths such as `../b.md`. The folder is a self-contained bundle for git and
  OKF tools, which then see the graph and backlinks. It still works when served on the site,
  but the agent has to resolve each path against the note's URL.

## How links are made

The base build uses no language model and is fully deterministic.

| Edge       | Source                                                                          |
| ---------- | ------------------------------------------------------------------------------- |
| `contains` | page → its sections                                                             |
| `next`     | section → the following section                                                 |
| `links`    | a same-site link written in the section text                                    |
| `lists`    | a listing page (`## [Title](/url)` cards, such as a blog index) → listed pages  |
| `related`  | TF-IDF cosine similarity over stemmed words, at most one section per page       |

The build drops sections whose heading repeats on many pages (≥3 pages and ≥25 % of the site).
These are template parts such as «More from the blog» or a CTA, and so are the cards inside them.

## Input

Page URLs come from `sitemap.xml`, including sitemap indexes. The build reads each page as
Markdown in this order:

1. `Accept: text/markdown`
2. `<link rel="alternate" type="text/markdown">`
3. the HTML `<main>` converted with Turndown

## Optional: hints from Claude (`--llm`)

```bash
ANTHROPIC_API_KEY=... npx site-graph https://example.com --llm
```

The build sends one request per page to Claude (`claude-opus-5-5` by default, `--model` to
change it). Each request carries the page's sections and the links that leave the page. The
model writes:

- **when** for every page and section: the question for which an agent should open the note.
  It is shown next to every link to that note («читать, если нужно оценить бюджет…»).
- **summary** for every note: a factual one-liner that replaces the first-sentence summary.
- **why** for every link: what following it adds for a reader of the source note.
- **keep**: similarity links that only share words are dropped. Links written by the site's
  authors are always kept.

Answers are cached in `.site-graph-cache.json` by a hash of the page's input. A rebuild pays only
for pages that changed. If a page fails (rate limit, refusal), it keeps the plain annotations and
the build goes on.

## Status

This is an early prototype. Next steps:

- topic hubs
- an eval: questions to the site, and how many hops and tokens the agent needs with and without
  the map

Requires Node 20+.

## Development

The sources are TypeScript that Node 24 runs directly: `node src/cli.ts https://example.com`.
`npm test` runs the tests, `npm run build` compiles `dist/` for the npm package (done
automatically on `npm pack` and `npm publish`).
