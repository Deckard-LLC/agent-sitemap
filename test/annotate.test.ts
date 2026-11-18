import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { annotate, edgeKey, type Annotator, type PageInput } from "../src/annotate.ts";
import { buildGraph } from "../src/graph.ts";
import { parsePage } from "../src/parse.ts";
import { render } from "../src/render.ts";

const pages = () =>
  buildGraph([
    parsePage(
      "https://example.com/blog/a/",
      "# Локальная нейросеть\n\nКогда компании нужна локальная нейросеть и сколько стоит свой сервер для модели.\n\n" +
        "## Свой сервер\n\nЛокальная модель на своём сервере: данные компании остаются внутри контура, облако не нужно.\n\n" +
        "## Цена\n\nСервер и видеокарты стоят денег, сопровождение требует инженеров. [Подробнее о цене](/blog/b/).",
    ),
    parsePage(
      "https://example.com/blog/b/",
      "# Стоимость агента\n\nИз чего складывается стоимость агента: интеграции, качество, сопровождение и сервер.\n\n" +
        "## Сопровождение\n\nИнженеры разбирают ошибки и следят за качеством, сервер и модель требуют сопровождения.\n\n" +
        "## Сервер для модели\n\nСвой сервер с видеокартами для локальной модели: данные остаются внутри контура компании.",
    ),
  ]);

/** Answers like the model would: a hint per node, «why» per link, every «related» link but one kept. */
function stub(calls: string[]): Annotator {
  return async (input: PageInput) => {
    calls.push(input.page.id);
    const firstRelated = input.links.find((l) => l.kind === "related")?.key;
    return {
      result: {
        nodes: [input.page, ...input.sections].map((n) => ({ id: n.id, summary: `Кратко: ${n.title}`, when: `нужно про «${n.title}».` })),
        edges: input.links.map((l) => ({ key: l.key, why: `дополняет: ${l.toTitle}`, keep: l.key !== firstRelated })),
      },
      usage: { input: 100, output: 20 },
    };
  };
}

test("applies hints, drops weak similarity links and reuses the cache", async () => {
  const cachePath = join(await mkdtemp(join(tmpdir(), "agent-sitemap-")), "cache.json");
  const calls: string[] = [];
  const graph = pages();
  const relatedBefore = graph.edges.filter((e) => e.kind === "related").length;

  const report = await annotate(graph, stub(calls), { cachePath, model: "test" });
  assert.deepEqual(calls.sort(), ["blog/a", "blog/b"]);
  assert.equal(report.usage.input, 200);
  assert.equal(report.dropped, 2); // the first «related» link of each page
  assert.equal(graph.edges.filter((e) => e.kind === "related").length, relatedBefore - 2);
  assert.equal(graph.nodes.get("blog/a/tsena")!.when, "нужно про «Цена»");
  const written = graph.edges.find((e) => e.kind === "links" && e.from === "blog/a/tsena")!;
  assert.equal(written.why, "дополняет: Стоимость агента");

  const files = render(graph, { base: "https://example.com/ai/", site: "https://example.com/", name: "Example", lang: "ru", generated: "2026-11-16T10:00:00Z", producer: "agent-sitemap/test", model: "test" });
  assert.match(files.get("blog/a.md")!, /2\. \[Цена\]\([^)]+\) — читать, если нужно про «Цена» ·/);
  assert.match(files.get("blog/a/tsena.md")!, /\[Стоимость агента\]\([^)]+\) — дополняет: Стоимость агента ·/);
  assert.match(files.get("blog/a/tsena.md")!, /^when: "нужно про «Цена»"$/m);
  assert.match(files.get("blog/a/tsena.md")!, /^hints_by: test$/m);

  // Same content again: everything comes from the cache, no requests.
  const again = await annotate(pages(), stub(calls), { cachePath, model: "test" });
  assert.equal(again.cached, 2);
  assert.equal(calls.length, 2);
});

test("a failed page keeps the plain map", async () => {
  const cachePath = join(await mkdtemp(join(tmpdir(), "agent-sitemap-")), "cache.json");
  const graph = pages();
  const before = graph.nodes.get("blog/b")!.summary;
  const report = await annotate(graph, async () => { throw new Error("rate limited"); }, { cachePath, model: "test" });
  assert.deepEqual(report.failed.sort(), ["blog/a", "blog/b"]);
  assert.equal(graph.nodes.get("blog/b")!.summary, before);
  assert.ok(graph.edges.some((e) => e.kind === "related"));
  assert.equal(edgeKey("a", "b"), "a -> b");
});
