// Tests for the template picker list: which notes are offered, their labels
// below the template folder, the fuzzy order and the name of a new note.
import { describe, expect, it } from "vitest";
import type { VaultEntry } from "../../../api";
import { PICKER_LIMIT, freeNoteName, templateOptions } from "./picker";

function entry(path: string, isDir = false): VaultEntry {
  const name = path.split("/").pop()!;
  return { path, name, extension: isDir ? "" : name.split(".").pop()!, isDir, size: 10, modified: 1000 };
}

const entries = [
  entry("Templates", true),
  entry("Templates/Meeting.md"),
  entry("Templates/Meeting-Planning.md"),
  entry("Templates/sub/Weekly.md"),
  entry("Templates/photo.png"),
  entry("Other/Meeting.md"),
  entry("Idea.md"),
];

describe("templateOptions", () => {
  it("lists the notes of the folder with labels relative to it", () => {
    expect(templateOptions(entries, "Templates", "")).toEqual([
      { path: "Templates/Meeting.md", label: "Meeting", indices: [] },
      { path: "Templates/Meeting-Planning.md", label: "Meeting-Planning", indices: [] },
      { path: "Templates/sub/Weekly.md", label: "sub/Weekly", indices: [] },
    ]);
  });

  it("filters fuzzily and puts the best match first", () => {
    const found = templateOptions(entries, "Templates", "mtg plan");
    expect(found.map((o) => o.path)).toEqual(["Templates/Meeting-Planning.md"]);
    expect(found[0].indices.length).toBeGreaterThan(0);
    expect(templateOptions(entries, "Templates", "weekly").map((o) => o.label)).toEqual(["sub/Weekly"]);
    expect(templateOptions(entries, "Templates", "nothing here")).toEqual([]);
  });

  it("ignores surrounding whitespace and matches everything for a blank query", () => {
    expect(templateOptions(entries, "Templates", "   ")).toHaveLength(3);
    expect(templateOptions(entries, "Templates", " meeting ")).toHaveLength(2);
  });

  it("an empty folder means the vault root", () => {
    expect(templateOptions(entries, "", "").map((o) => o.label)).toEqual([
      "Idea",
      "Other/Meeting",
      "Templates/Meeting",
      "Templates/Meeting-Planning",
      "Templates/sub/Weekly",
    ]);
  });

  it("cleans the folder setting and never offers non-notes", () => {
    expect(templateOptions(entries, "/Templates/", "").map((o) => o.label)).toEqual(["Meeting", "Meeting-Planning", "sub/Weekly"]);
    expect(templateOptions(entries, "../Templates", "").map((o) => o.path)).toContain("Templates/Meeting.md");
    expect(templateOptions(entries, "Templates", "").map((o) => o.path)).not.toContain("Templates/photo.png");
  });

  it("caps the list so a huge folder stays usable", () => {
    const many = Array.from({ length: PICKER_LIMIT + 20 }, (_, i) => entry(`Templates/Note ${i}.md`));
    expect(templateOptions(many, "Templates", "")).toHaveLength(PICKER_LIMIT);
    expect(templateOptions(many, "Templates", "Note 7")).not.toHaveLength(0);
  });
});

describe("freeNoteName", () => {
  it("uses the template name and counts up when it is taken", () => {
    expect(freeNoteName(entries, "", "Meeting")).toBe("Meeting");
    expect(freeNoteName(entries, "Templates", "Meeting")).toBe("Meeting 2");
    expect(freeNoteName([...entries, entry("Templates/Meeting 2.md")], "Templates", "Meeting")).toBe("Meeting 3");
    expect(freeNoteName(entries, "Other", "Meeting")).toBe("Meeting 2");
  });

  it("compares paths ignoring case, like the file system", () => {
    expect(freeNoteName([entry("Templates/meeting.md")], "Templates", "Meeting")).toBe("Meeting 2");
  });
});