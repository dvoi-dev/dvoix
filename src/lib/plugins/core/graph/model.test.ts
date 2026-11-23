// Tests for the graph model's link resolution: frontmatter aliases point at
// real note nodes, and ambiguous names go to the closest note. Pure logic, no DOM.
import { describe, expect, it } from "vitest";
import type { GraphData, VaultEntry } from "../../../api";
import { buildGraph, type ModelSettings } from "./model";

function entry(path: string): VaultEntry {
  const name = path.split("/").pop()!;
  return { path, name, extension: name.split(".").pop() ?? "", isDir: false, size: 10, modified: 1000 };
}

function note(path: string, aliases: string[] = []): GraphData["notes"][number] {
  return { path, title: path, tags: [], aliases };
}

const settings: ModelSettings = {
  links: true,
  folders: false,
  tags: false,
  tagMode: "shared",
  filter: "",
  orphans: true,
  attachments: false,
  unresolved: true,
};

describe("graph link resolution", () => {
  it("connects a [[Alias]] link to the note that owns the alias", () => {
    const data: GraphData = {
      notes: [note("a.md"), note("projects/b.md", ["Bee"])],
      links: [{ source: "a.md", target: "bee" }],
    };
    const model = buildGraph(data, [entry("a.md"), entry("projects/b.md")], settings, "vault");
    expect(model.edges).toEqual([{ source: "a.md", target: "projects/b.md", kind: "link" }]);
    expect(model.nodes.some((n) => n.kind === "unresolved")).toBe(false);
  });

  it("prefers a file name over an alias and keeps unknown targets unresolved", () => {
    const data: GraphData = {
      notes: [note("a.md"), note("Bee.md"), note("projects/c.md", ["Bee"])],
      links: [
        { source: "a.md", target: "bee" },
        { source: "a.md", target: "nowhere" },
      ],
    };
    const model = buildGraph(data, [entry("a.md"), entry("Bee.md"), entry("projects/c.md")], settings, "vault");
    expect(model.edges).toContainEqual({ source: "a.md", target: "Bee.md", kind: "link" });
    expect(model.edges).toContainEqual({ source: "a.md", target: "unresolved:nowhere", kind: "link" });
  });

  it("answers an ambiguous alias by path proximity to the linking note", () => {
    const data: GraphData = {
      notes: [note("a/here.md"), note("a/one.md", ["Shared"]), note("b/two.md", ["Shared"])],
      links: [{ source: "a/here.md", target: "shared" }],
    };
    const entries = [entry("a/here.md"), entry("a/one.md"), entry("b/two.md")];
    const model = buildGraph(data, entries, settings, "vault");
    expect(model.edges).toEqual([{ source: "a/here.md", target: "a/one.md", kind: "link" }]);
  });
});