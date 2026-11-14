// Tests for the folder tree of the file explorer: order, merging and paging.
import { describe, expect, it } from "vitest";
import type { VaultEntry } from "../../api";
import { buildTree, mergeEntries, visibleChildren, FOLDER_PAGE } from "./tree";

function entry(path: string, isDir = false): VaultEntry {
  const name = path.split("/").pop()!;
  return { path, name, extension: isDir || !name.includes(".") ? "" : name.split(".").pop()!, isDir, size: 0, modified: 0 };
}

describe("buildTree", () => {
  it("puts folders first and sorts names naturally", () => {
    const tree = buildTree([entry("10 - Archive", true), entry("z.md"), entry("2 - Notes", true), entry("b.md"), entry("a.md")]);
    expect(tree.map((n) => n.entry.name)).toEqual(["2 - Notes", "10 - Archive", "a.md", "b.md", "z.md"]);
  });

  it("nests entries under their parent folder", () => {
    const tree = buildTree([entry("a", true), entry("a/10.md"), entry("a/2.md"), entry("a/sub", true), entry("a/sub/x.md")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((n) => n.entry.name)).toEqual(["sub", "2.md", "10.md"]);
    expect(tree[0].children[0].children.map((n) => n.entry.name)).toEqual(["x.md"]);
  });

  it("drops entries whose parent folder is not in the list", () => {
    expect(buildTree([entry("x/y.md")])).toEqual([]);
  });
});

describe("mergeEntries", () => {
  it("returns the original list when there is nothing to add", () => {
    const entries = [entry("a.md")];
    expect(mergeEntries(entries, [])).toBe(entries);
  });

  it("adds extra entries without duplicates, sorted by path", () => {
    const merged = mergeEntries([entry("b.md"), entry("a.md")], [entry("a.md"), entry(".hidden", true), entry("c.md")]);
    expect(merged.map((e) => e.path)).toEqual([".hidden", "a.md", "b.md", "c.md"]);
  });
});

describe("visibleChildren", () => {
  it("keeps the list identity below the page size", () => {
    const children = [entry("a.md"), entry("b.md")].map((e) => ({ entry: e, children: [] }));
    expect(visibleChildren(children, FOLDER_PAGE)).toBe(children);
  });

  it("draws only the first page of a big folder", () => {
    const children = Array.from({ length: FOLDER_PAGE + 10 }, (_, i) => ({ entry: entry(`note-${i}.md`), children: [] }));
    const shown = visibleChildren(children, FOLDER_PAGE);
    expect(shown).toHaveLength(FOLDER_PAGE);
    expect(shown[0].entry.path).toBe("note-0.md");
  });
});
