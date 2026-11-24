// Tests for the line-exact frontmatter edits: every change must leave the
// rest of the note byte-identical, including line endings, comments, quoting
// and unknown YAML that is only shown as raw text.
import { describe, expect, it } from "vitest";
import {
  addListItem,
  addProperty,
  applyChange,
  formatScalar,
  parseFrontmatter,
  removeListItem,
  removeProperty,
  renameProperty,
  setScalar,
  unquote,
  type Property,
} from "./frontmatter";

const prop = (doc: string, key: string): { doc: string; fm: NonNullable<ReturnType<typeof parseFrontmatter>>; property: Property } => {
  const fm = parseFrontmatter(doc);
  if (!fm) throw new Error("expected frontmatter");
  const property = fm.properties.find((p) => p.key === key);
  if (!property) throw new Error(`expected property ${key}`);
  return { doc, fm, property };
};

const edit = (doc: string, changes: ({ from: number; to: number; insert: string } | null)[]) => {
  let text = doc;
  // Apply from the back so earlier positions stay valid.
  for (const change of changes.filter((c): c is NonNullable<typeof c> => !!c).sort((a, b) => b.from - a.from)) {
    text = applyChange(text, change);
  }
  return text;
};

describe("parseFrontmatter", () => {
  it("returns null without a closed frontmatter", () => {
    expect(parseFrontmatter("# Note")).toBeNull();
    expect(parseFrontmatter("---\ntitle: x\n")).toBeNull();
  });

  it("reads the shapes Obsidian writes into properties", () => {
    const { fm } = prop(
      [
        "---",
        "title: Hello",
        "count: 3",
        "draft: true",
        "date: 2026-11-24",
        "tags: [a, \"b, c\"]",
        "aliases:",
        "  - One",
        "  - 'Two''s'",
        "multi: |",
        "  line one",
        "  line two",
        "---",
        "Body",
      ].join("\n"),
      "title",
    );
    const byKey = Object.fromEntries(fm.properties.map((p) => [p.key, p]));
    expect(byKey.title).toMatchObject({ kind: "text", value: "Hello" });
    expect(byKey.count).toMatchObject({ kind: "number", value: "3" });
    expect(byKey.draft).toMatchObject({ kind: "boolean", value: "true" });
    expect(byKey.date).toMatchObject({ kind: "date", value: "2026-11-24" });
    expect(byKey.tags).toMatchObject({ kind: "list", listStyle: "flow", items: ["a", "b, c"] });
    expect(byKey.aliases).toMatchObject({ kind: "list", listStyle: "block", items: ["One", "Two's"] });
    expect(byKey.multi.kind).toBe("raw");
    expect(byKey.multi.value).toContain("line one");
  });

  it("keeps an empty list key from Obsidian as a block list", () => {
    const { property } = prop("---\ntags:\n---\n", "tags");
    expect(property).toMatchObject({ kind: "list", listStyle: "block", items: [] });
  });

  it("detects CRLF and no final newline", () => {
    const fm = parseFrontmatter("---\r\ntitle: x\r\n---\r\nBody");
    expect(fm?.eol).toBe("\r\n");
    expect(fm?.properties[0].value).toBe("x");
  });
});

describe("setScalar", () => {
  it("replaces only the value and keeps the comment", () => {
    const { doc, property } = prop("---\ntitle: Hello # keep me\n---\n", "title");
    const next = edit(doc, [setScalar(property, "text", "World")]);
    expect(next).toBe("---\ntitle: World # keep me\n---\n");
  });

  it("clears a text value without leaving a space", () => {
    const { doc, property } = prop("---\ntitle: Hello\n---\n", "title");
    expect(edit(doc, [setScalar(property, "text", "")])).toBe("---\ntitle:\n---\n");
  });

  it("writes booleans, numbers and dates unquoted", () => {
    const bool = prop("---\na: x\n---\n", "a");
    expect(edit(bool.doc, [setScalar(bool.property, "boolean", "true")])).toBe("---\na: true\n---\n");
    const number = prop("---\nb: x\n---\n", "b");
    expect(edit(number.doc, [setScalar(number.property, "number", "42")])).toBe("---\nb: 42\n---\n");
    const date = prop("---\nd: x\n---\n", "d");
    expect(edit(date.doc, [setScalar(date.property, "date", "2026-11-24")])).toBe("---\nd: 2026-11-24\n---\n");
  });
});

describe("properties", () => {
  it("renames only the key", () => {
    const { doc, property } = prop("---\ntitle: Hello # x\n---\n", "title");
    expect(edit(doc, [renameProperty(property, "name")])).toBe("---\nname: Hello # x\n---\n");
  });

  it("removes a property with its line break", () => {
    const { doc, fm, property } = prop("---\ntitle: x\nstatus: active\n---\n", "title");
    expect(edit(doc, [removeProperty(fm, property)])).toBe("---\nstatus: active\n---\n");
  });

  it("adds a property in front of the closing line", () => {
    const { doc, fm } = prop("---\ntitle: x\n---\nBody", "title");
    expect(edit(doc, [addProperty(fm, "status")])).toBe("---\ntitle: x\nstatus:\n---\nBody");
  });

  it("uses the file's CRLF when adding and removing lines", () => {
    const { doc, fm, property } = prop("---\r\ntitle: x\r\n---\r\nBody", "title");
    expect(edit(doc, [addProperty(fm, "status")])).toBe("---\r\ntitle: x\r\nstatus:\r\n---\r\nBody");
    expect(edit(doc, [removeProperty(fm, property)])).toBe("---\r\n---\r\nBody");
  });

  it("quotes a key only when YAML needs it", () => {
    const { doc, fm } = prop("---\na: x\n---\n", "a");
    expect(edit(doc, [renameProperty(fm.properties[0], "with space")])).toBe("---\nwith space: x\n---\n");
    expect(edit(doc, [renameProperty(fm.properties[0], "a:b")])).toBe('---\n"a:b": x\n---\n');
  });
});

describe("list items", () => {
  it("appends a block item with the indentation of the list", () => {
    const { doc, fm, property } = prop("---\ntags:\n  - One\n  - Two\n---\n", "tags");
    expect(edit(doc, [addListItem(fm, property, "Three")])).toBe("---\ntags:\n  - One\n  - Two\n  - Three\n---\n");
  });

  it("adds the first item to an empty block list", () => {
    const { doc, fm, property } = prop("---\ntags:\n---\n", "tags");
    expect(edit(doc, [addListItem(fm, property, "One")])).toBe("---\ntags:\n  - One\n---\n");
  });

  it("removes exactly one block line", () => {
    const { doc, fm, property } = prop("---\ntags:\n  - One\n  - Two\n---\n", "tags");
    expect(edit(doc, [removeListItem(fm, property, 0)])).toBe("---\ntags:\n  - Two\n---\n");
  });

  it("rewrites a flow list and escapes values with commas", () => {
    const { doc, fm, property } = prop("---\ntags: [One, Two]\n---\n", "tags");
    expect(edit(doc, [addListItem(fm, property, "a, b")])).toBe('---\ntags: [One, Two, "a, b"]\n---\n');
  });

  it("turns a single-value list into a flow list", () => {
    const { doc, fm, property } = prop("---\ntags: One\n---\n", "tags");
    expect(property).toMatchObject({ listStyle: "scalar", items: ["One"] });
    expect(edit(doc, [addListItem(fm, property, "Two")])).toBe("---\ntags: [One, Two]\n---\n");
  });

  it("removes a flow item without touching the others", () => {
    const { doc, fm, property } = prop('---\ntags: [One, "a, b", Two]\n---\n', "tags");
    expect(edit(doc, [removeListItem(fm, property, 1)])).toBe("---\ntags: [One, Two]\n---\n");
  });
});

describe("formatScalar", () => {
  it("quotes only what YAML would read differently", () => {
    expect(formatScalar("aktiv")).toBe("aktiv");
    expect(formatScalar("Café")).toBe("Café");
    expect(formatScalar("true")).toBe('"true"');
    expect(formatScalar("12")).toBe('"12"');
    expect(formatScalar("a: b")).toBe('"a: b"');
    expect(formatScalar("#tag")).toBe('"#tag"');
    expect(formatScalar("[[Link]]")).toBe('"[[Link]]"');
    expect(formatScalar("")).toBe('""');
    expect(formatScalar("a,b", true)).toBe('"a,b"');
    expect(formatScalar("a,b")).toBe("a,b");
  });

  it("removes YAML quotes", () => {
    expect(unquote('"a\\nb"')).toBe("a\nb");
    expect(unquote("'it''s'")).toBe("it's");
    expect(unquote("plain")).toBe("plain");
  });
});
