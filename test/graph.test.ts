import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { buildGraph } from "../src/graph.ts";
import { parsePage } from "../src/parse.ts";
import { summarize } from "../src/text.ts";
import { OKF_VERSION, render } from "../src/render.ts";

const cta = "## Запишитесь на диагностику\n\nПосмотрим на один процесс и данные, которые за ним стоят, и скажем прямо.\n";
const more = "## Ещё в блоге\n\n*   [![](/m/a.webp)](/blog/a/)\n\n    **Команда**1 ноября\n\n    ## [Статья A](/blog/a/)\n\n    Описание статьи A.\n";

const post = (slug: string, title: string, body: string) =>
  parsePage(
    `https://example.com/blog/${slug}/`,
    `ГАЗЕТА · 1 НОЯБРЯ\n\n# ${title}\n\nВступление к статье про ${title.toLowerCase()}, достаточно длинное для описания.\n\n${body}\n\n${cta}\n${more}`,
  );

const pages = [
  parsePage(
    "https://example.com/",
    "# Отдаём рутину ИИ  \nРешения оставляем людям\n\nВстраиваем ИИ-агентов в рабочие процессы компании — от диагностики до запуска.\n\n" +
      "## Расскажите  \nо вашей задаче\n\nНе обязательно приходить с готовым техническим заданием, хватит описания процесса.\n\n" +
      "## Данные остаются у вас\n\nЛокальная модель, локальный сервер, данные компании не уходят во внешнее облако и остаются внутри контура.\n",
  ),
  parsePage(
    "https://example.com/blog/",
    "# Блог\n\nРазбираем новости об ИИ и бизнесе и объясняем, что это значит для компаний.\n\n" +
      "*   [![](/m/a.webp)](/blog/a/)\n\n    ## [Статья A](/blog/a/)\n\n    Описание.\n\n*   ## [Статья B](/blog/b/)\n\n    Описание.\n",
  ),
  post("a", "Локальная нейросеть", "## Локальный сервер\n\nЛокальная модель на своём сервере: данные компании остаются внутри контура, облако не нужно.\n\n## Цена\n\nСервер и видеокарты стоят денег, а сопровождение требует инженеров. [Смотрите также](/blog/b/)."),
  post("b", "Стоимость агента", "## Из чего цена\n\nИнтеграции, проверка качества и сопровождение стоят больше самой модели в бюджете проекта.\n\n## Сопровождение\n\nИнженеры разбирают ошибки, обновляют правила и следят за качеством ответов модели."),
  post("c", "Профессии и ИИ", "## Кого заменит\n\nАвтономные суда и экипажи: какие задачи на борту уходят автоматике, а какие остаются людям."),
];

test("parses titles, hard-break headings and listing cards", () => {
  const [home, blog, a] = pages;
  assert.equal(home.title, "Отдаём рутину ИИ. Решения оставляем людям");
  assert.deepEqual(home.sections.map((s) => s.title), ["Расскажите о вашей задаче", "Данные остаются у вас"]);
  assert.deepEqual(blog.lists.map((l) => l.key), ["/blog/a", "/blog/b"]);
  assert.equal(blog.sections.length, 0);
  assert.doesNotMatch(blog.intro, /Команда|webp/);
  assert.equal(a.title, "Локальная нейросеть");
  assert.deepEqual(a.sections[1].links, ["/blog/b"]);
});

test("drops repeated template sections and their cards, links similar content", () => {
  const graph = buildGraph(pages);
  assert.ok(graph.boilerplate.includes("ещё в блоге"));
  assert.ok(![...graph.nodes.keys()].some((id) => id.includes("zapishites")));
  const lists = graph.edges.filter((e) => e.kind === "lists");
  assert.deepEqual(lists.map((e) => `${e.from}→${e.to}`), ["blog→blog/a", "blog→blog/b"]);
  assert.ok(graph.edges.some((e) => e.kind === "links" && e.from === "blog/a/tsena" && e.to === "blog/b"));
  const related = graph.edges.filter((e) => e.kind === "related" && e.from === "home/dannye-ostayutsya-u-vas");
  assert.equal(related[0]?.to, "blog/a/lokalnyy-server");
});

const options = {
  base: "https://example.com/ai/",
  site: "https://example.com/",
  name: "Example",
  lang: "ru" as const,
  generated: "2026-11-16T10:00:00Z",
  producer: "agent-sitemap/test",
};

test("renders absolute links and a backlink", () => {
  const files = render(buildGraph(pages), options);
  assert.ok(files.has("index.md") && files.has("blog/a/lokalnyy-server.md") && files.has("graph.json"));
  assert.match(files.get("index.md")!, /^# Блог \(3\)\n\n\* \[Блог\]\(https:\/\/example\.com\/ai\/blog\.md\) - /m);
  assert.match(files.get("blog/b.md")!, /## Ссылаются сюда[\s\S]*blog\/a\.md\) — из раздела «Цена»/);
  assert.match(files.get("blog/a/lokalnyy-server.md")!, /Следующий раздел: \[Цена\]\(https:\/\/example\.com\/ai\/blog\/a\/tsena\.md\)/);
});

/** Frontmatter of a note, or null when there is none. */
function front(text: string): Record<string, unknown> | null {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match ? (parseYaml(match[1]) as Record<string, unknown>) : null;
}

for (const links of ["absolute", "relative"] as const) {
  test(`is a conformant OKF ${OKF_VERSION} bundle with ${links} links`, () => {
    const files = render(buildGraph(pages), { ...options, links });
    const notes = [...files].filter(([path]) => path.endsWith(".md") && path !== "index.md");
    assert.ok(notes.length > 5);

    // Every concept: parseable frontmatter with a non-empty type and the recommended fields.
    for (const [path, text] of notes) {
      const fields = front(text);
      assert.ok(fields, `${path} has frontmatter`);
      assert.match(String(fields.type), /^Web Page( Section)?$/, path);
      assert.ok(fields.title && fields.description && fields.resource, path);
      assert.deepEqual(fields.generated, { by: "agent-sitemap/test", at: "2026-11-16T10:00:00Z" }, path);
    }

    // index.md: frontmatter carries only okf_version; entries are «* [Title](url) - description».
    const index = files.get("index.md")!;
    assert.deepEqual(front(index), { okf_version: OKF_VERSION });
    const entries = index.split("\n").filter((line) => line.startsWith("* "));
    assert.ok(entries.length >= 3 && entries.every((line) => /^\* \[[^\]]+\]\([^)]+\.md\) - \S/.test(line)), entries.join("\n"));

    // Links between notes resolve to notes of the bundle, from the file they are written in.
    for (const [path, text] of [...notes, ["index.md", index] as const]) {
      for (const [, url] of text.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
        const inBundle = links === "relative"
          ? posix.normalize(posix.join(posix.dirname(path), url))
          : url.replace(options.base, "");
        assert.ok(links === "relative" ? !/^[a-z]+:/.test(url) : url.startsWith(options.base), `${path} → ${url}`);
        assert.ok(files.has(inBundle), `${path} → ${url} resolves to ${inBundle}`);
      }
    }
  });
}

test("a section summary skips tables", () => {
  const body = "| Фактор | Дешевле, если… | Дороже, если… |\n| --- | --- | --- |\n| Интеграции | Одна система с API | Много систем без API |\n\n" +
    "Самый сильный фактор почти всегда — интеграции, и он меняет цену агента в разы.";
  assert.equal(summarize(body), "Самый сильный фактор почти всегда — интеграции, и он меняет цену агента в разы.");
});
