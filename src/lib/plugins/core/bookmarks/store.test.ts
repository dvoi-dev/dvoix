// Tests for the bookmarks store: persistence, duplicate protection, reorder,
// rename remapping (files and folder trees) and keeping unknown data intact.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../config", () => ({
  readJsonRaw: vi.fn(async () => null),
  writeJson: vi.fn(),
}));

import { readJsonRaw, writeJson } from "../../../config";
import { bookmarks } from "./store.svelte";

function saved(): { items: unknown[]; [key: string]: unknown } {
  const call = vi.mocked(writeJson).mock.calls.at(-1);
  expect(call?.[0]).toBe("bookmarks.json");
  return call?.[1] as { items: unknown[] };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(readJsonRaw).mockResolvedValue(null);
  await bookmarks.load();
});

describe("bookmarks store", () => {
  it("toggles a bookmark on and off and writes the file", () => {
    bookmarks.toggle("file", "Notes/idea.md");
    expect(bookmarks.isBookmarked("Notes/idea.md")).toBe(true);
    expect(saved().items).toEqual([{ type: "file", path: "Notes/idea.md" }]);
    bookmarks.toggle("file", "Notes/idea.md");
    expect(bookmarks.isBookmarked("Notes/idea.md")).toBe(false);
    expect(saved().items).toEqual([]);
  });

  it("does not add the same path twice, ignoring case", () => {
    bookmarks.toggle("file", "Notes/idea.md");
    expect(bookmarks.isBookmarked("notes/IDEA.md")).toBe(true);
    bookmarks.toggle("folder", "Notes");
    expect(bookmarks.items).toHaveLength(2);
  });

  it("loads items and keeps unknown types and fields", async () => {
    vi.mocked(readJsonRaw).mockResolvedValue({
      version: 2,
      items: [
        { type: "file", path: "a.md", title: "A", color: "red" },
        { type: "search", query: "#idea" },
        { type: "file", path: "" },
        null,
        { type: "folder", path: "Notes" },
      ],
    });
    await bookmarks.load();
    expect(bookmarks.items).toEqual([
      { color: "red", type: "file", path: "a.md", title: "A" },
      { type: "folder", path: "Notes" },
    ]);
    bookmarks.toggle("file", "b.md");
    expect(saved()).toEqual({
      version: 2,
      items: [
        { color: "red", type: "file", path: "a.md", title: "A" },
        { type: "folder", path: "Notes" },
        { type: "file", path: "b.md" },
        { type: "search", query: "#idea" },
        { type: "file", path: "" },
      ],
    });
  });

  it("broken JSON leaves an empty list without crashing", async () => {
    vi.mocked(readJsonRaw).mockResolvedValue(undefined);
    await bookmarks.load();
    expect(bookmarks.items).toEqual([]);
    bookmarks.toggle("file", "a.md");
    expect(saved().items).toHaveLength(1);
  });

  it("reorders by drag & drop indices", () => {
    bookmarks.toggle("file", "a.md");
    bookmarks.toggle("file", "b.md");
    bookmarks.toggle("file", "c.md");
    bookmarks.move(2, 0);
    expect(bookmarks.items.map((i) => i.path)).toEqual(["c.md", "a.md", "b.md"]);
    bookmarks.move(0, 2);
    expect(bookmarks.items.map((i) => i.path)).toEqual(["a.md", "b.md", "c.md"]);
    bookmarks.move(0, -1); // out of range: nothing happens
    expect(bookmarks.items.map((i) => i.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("remaps a renamed file exactly, not by prefix", () => {
    bookmarks.toggle("file", "Notes/plan.md");
    bookmarks.toggle("file", "Notes/plan.md.bak");
    bookmarks.remap("Notes/plan.md", "Notes/idea.md", false);
    expect(bookmarks.items.map((i) => i.path)).toEqual(["Notes/idea.md", "Notes/plan.md.bak"]);
  });

  it("remaps a renamed folder and everything below it", () => {
    bookmarks.toggle("folder", "Projects");
    bookmarks.toggle("file", "Projects/alpha.md");
    bookmarks.toggle("file", "Projects/sub/beta.md");
    bookmarks.toggle("file", "Projects-other.md");
    bookmarks.remap("Projects", "Work", true);
    expect(bookmarks.items.map((i) => i.path)).toEqual(["Work", "Work/alpha.md", "Work/sub/beta.md", "Projects-other.md"]);
    expect(saved().items).toHaveLength(4);
  });

  it("an unrelated rename writes nothing", () => {
    bookmarks.toggle("file", "a.md");
    vi.mocked(writeJson).mockClear();
    bookmarks.remap("b.md", "c.md", false);
    expect(writeJson).not.toHaveBeenCalled();
  });

  it("reset drops the state and stops writing (vault switch)", () => {
    bookmarks.toggle("file", "a.md");
    vi.mocked(writeJson).mockClear();
    bookmarks.reset();
    expect(bookmarks.items).toEqual([]);
    bookmarks.toggle("file", "b.md");
    expect(writeJson).not.toHaveBeenCalled();
  });
});
