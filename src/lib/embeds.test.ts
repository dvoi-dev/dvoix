// @vitest-environment happy-dom
// Tests for the transclusion engine: notes and sections embed in place,
// cycles and depth stop with a placeholder, changed sources re-render, and
// links inside an embed resolve from the embedded note.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: {
    readFile: vi.fn(async (path: string) => files[path] ?? Promise.reject(new Error("missing"))),
    renderMarkdown: vi.fn(async (content: string, heading?: string) => ({
      html: render(content, heading),
      frontmatter: {},
    })),
    readBinary: vi.fn(),
  },
}));
vi.mock("./vault.svelte", () => ({
  vault: {
    resolveLink: vi.fn((target: string) => byName[target.toLowerCase()]),
    bufferedContent: vi.fn(() => undefined),
    entryAt: vi.fn(() => undefined),
  },
}));
vi.mock("./filetypes/markdown/codeHighlight", () => ({ highlightCodeBlocks: vi.fn(async () => {}) }));
vi.mock("./filetypes/markdown/enhanceReading", () => ({ enhanceReading: vi.fn() }));

import { api } from "./api";
import { embedContext, hydrateEmbeds, linkTarget, resolveFromContext } from "./embeds";
import { vault } from "./vault.svelte";

/** The vault of the test: path -> markdown text. */
let files: Record<string, string> = {};
/** Lower-cased name or alias -> path, what `vault.resolveLink` answers. */
let byName: Record<string, string> = {};

/** A tiny stand-in for the Rust renderer: headings, paragraphs, embeds, links. */
function render(content: string, heading?: string): string {
  let body = content;
  if (heading) {
    const lines = body.split("\n");
    const start = lines.findIndex((l) => l.replace(/^#+\s*/, "").trim().toLowerCase() === heading.toLowerCase());
    if (start < 0) throw new Error("The note has no such heading.");
    const level = (lines[start].match(/^#+/) ?? ["#"])[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#+)\s/);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
    body = lines.slice(start, end).join("\n");
  }
  return body
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const h = line.match(/^(#+)\s+(.*)$/);
      if (h) return `<h${h[1].length}>${h[2]}</h${h[1].length}>`;
      const html = line.replace(/!\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
        const [targetPart] = inner.split("|");
        const hash = targetPart.indexOf("#");
        const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
        const head = hash >= 0 ? targetPart.slice(hash + 1).trim() : "";
        const attr = head ? ` data-embed-heading="${head}"` : "";
        return `<a class="wikilink embed" href="#" data-wikilink="${target}" data-embed="${target}"${attr}>${target}</a>`;
      });
      return `<p>${html}</p>`;
    })
    .join("");
}

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(vault.bufferedContent).mockImplementation(() => undefined);
  document.body.innerHTML = "";
  files = {};
  byName = {};
});

describe("hydrateEmbeds", () => {
  it("embeds a note as a card with its rendered content", async () => {
    files = { "b.md": "# Beta\n\nsome text" };
    byName = { beta: "b.md" };
    const el = root(render("![[Beta]]"));
    const paths = await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal });
    expect([...paths]).toEqual(["b.md"]);
    const wrapper = el.querySelector<HTMLElement>(".note-embed")!;
    expect(wrapper.dataset.embedSource).toBe("b.md");
    expect(wrapper.querySelector(".note-embed-title")?.textContent).toBe("b");
    expect(wrapper.querySelector(".note-embed-body")?.innerHTML).toContain("<h1>Beta</h1>");
    expect(el.querySelector("a[data-embed]")).toBeNull();
    expect(api.renderMarkdown).toHaveBeenCalledWith("# Beta\n\nsome text", undefined);
  });

  it("embeds only the wanted section", async () => {
    files = { "b.md": "# Beta\n\n## Goals\n\nwant\n\n## Other\n\nout" };
    byName = { beta: "b.md" };
    const el = root(render("![[Beta#Goals]]"));
    await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal });
    expect(api.renderMarkdown).toHaveBeenCalledWith(files["b.md"], "Goals");
    const body = el.querySelector(".note-embed-body")!;
    expect(body.innerHTML).toContain("want");
    expect(body.innerHTML).not.toContain("out");
    expect(el.querySelector(".note-embed-title")?.textContent).toBe("b#Goals");
  });

  it("shows a placeholder for a missing note and a missing section", async () => {
    files = { "b.md": "# Beta" };
    byName = { beta: "b.md" };
    const el = root(render("![[Nowhere]]") + render("![[Beta#Absent]]"));
    await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal });
    const missing = [...el.querySelectorAll(".dvoix-embed-missing")].map((m) => m.textContent);
    expect(missing).toContain("Note not found: Nowhere");
    expect(missing).toContain("Section not found: Absent");
  });

  it("stops a cycle A -> B -> A and a self-embed with a placeholder", async () => {
    files = { "a.md": "![[Beta]]", "b.md": "![[Alpha]]" };
    byName = { alpha: "a.md", beta: "b.md" };
    const el = root(render("![[Beta]]"));
    await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal });
    expect(el.textContent).toContain("Circular embed: Alpha");
    expect(api.readFile).toHaveBeenCalledTimes(1);

    const self = root(render("![[Alpha]]"));
    vi.mocked(api.readFile).mockClear();
    await hydrateEmbeds(self, "a.md", { signal: new AbortController().signal });
    expect(self.textContent).toContain("Circular embed: Alpha");
    expect(api.readFile).not.toHaveBeenCalled();
  });

  it("stops nesting at the depth limit", async () => {
    // A chain a -> b -> c: with maxDepth 1 only b is embedded, c is a placeholder.
    files = { "b.md": "![[Gamma]]", "c.md": "# Gamma" };
    byName = { beta: "b.md", gamma: "c.md" };
    const el = root(render("![[Beta]]"));
    await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal, maxDepth: 1 });
    expect(el.textContent).toContain("Embed depth limit reached");
    expect(el.querySelectorAll(".note-embed")).toHaveLength(1);
  });

  it("embeds the live buffer of an open note instead of the file", async () => {
    files = { "b.md": "old" };
    byName = { beta: "b.md" };
    vi.mocked(vault.bufferedContent).mockImplementation((path) => (path === "b.md" ? "# Live edit" : undefined));
    const el = root(render("![[Beta]]"));
    await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal });
    expect(api.readFile).not.toHaveBeenCalled();
    expect(el.querySelector(".note-embed-body")?.innerHTML).toContain("Live edit");
  });

  it("re-renders only the embeds whose source changed", async () => {
    files = { "b.md": "# Beta", "c.md": "# Gamma" };
    byName = { beta: "b.md", gamma: "c.md" };
    const el = root(render("![[Beta]]") + render("![[Gamma]]"));
    await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal });
    vi.mocked(api.renderMarkdown).mockClear();
    files["b.md"] = "# Beta updated";
    const paths = await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal, changed: new Set(["b.md"]) });
    expect(api.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(api.renderMarkdown).toHaveBeenCalledWith("# Beta updated", undefined);
    expect(el.textContent).toContain("Beta updated");
    // Unchanged embeds are still tracked for the next change batch.
    expect([...paths].sort()).toEqual(["b.md", "c.md"]);
  });

  it("does nothing once the run is aborted", async () => {
    files = { "b.md": "# Beta" };
    byName = { beta: "b.md" };
    const el = root(render("![[Beta]]"));
    const controller = new AbortController();
    controller.abort();
    const paths = await hydrateEmbeds(el, "a.md", { signal: controller.signal });
    expect(paths.size).toBe(0);
    expect(el.querySelector("a[data-embed]")).not.toBeNull();
  });
});

describe("link context inside embeds", () => {
  it("reads the embedded note from the wrapper", async () => {
    files = { "sub/b.md": "# Beta" };
    byName = { beta: "sub/b.md" };
    const el = root(render("![[Beta]]"));
    await hydrateEmbeds(el, "a.md", { signal: new AbortController().signal });
    const title = el.querySelector<HTMLElement>(".note-embed-title")!;
    expect(embedContext(title, "a.md")).toBe("sub/b.md");
    expect(embedContext(el, "a.md")).toBe("a.md");
  });

  it("resolves relative markdown links from the embedded note", () => {
    expect(resolveFromContext("../other.md#h", "sub/b.md")).toBe("other.md");
    expect(resolveFromContext("./sibling.md", "sub/b.md")).toBe("sub/sibling.md");
    expect(resolveFromContext("note.md", "sub/deep/b.md")).toBe("sub/deep/note.md");
    byName = { other: "other.md" };
    expect(linkTarget("../other.md", "sub/b.md")).toBe("other.md");
    expect(linkTarget("Other", "sub/b.md")).toBe("other.md");
  });
});