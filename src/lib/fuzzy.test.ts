// Tests for the fuzzy matcher of the quick switcher.
import { describe, expect, it } from "vitest";
import { fuzzyMatch, highlight } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("", "Projects/Note.md")).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch("   ", "Note.md")).toEqual({ score: 0, indices: [] });
  });

  it("finds spread-out letters in order", () => {
    const match = fuzzyMatch("mtg plan", "Projects/Meeting-Planning");
    expect(match).not.toBeNull();
    // "mtg" spreads across Meeting (m, t, g), "plan" sits in Planning.
    expect(match!.indices).toEqual([9, 12, 15, 17, 18, 19, 20]);
  });

  it("rejects letters that are out of order or missing", () => {
    expect(fuzzyMatch("tm", "meeting")).toBeNull();
    expect(fuzzyMatch("xyz", "Meeting-Planning")).toBeNull();
  });

  it("ignores case", () => {
    expect(fuzzyMatch("MEET", "meeting")).not.toBeNull();
    expect(fuzzyMatch("élan", "Élan")).not.toBeNull();
  });

  it("matches consecutive letters as a run", () => {
    expect(fuzzyMatch("meet", "Meeting")!.indices).toEqual([0, 1, 2, 3]);
  });

  it("prefers word starts over scattered letters", () => {
    expect(fuzzyMatch("mp", "Meeting-Planning")!.indices).toEqual([0, 8]);
    expect(fuzzyMatch("mn", "myNote")!.indices).toEqual([0, 2]);
  });

  it("scores a tight match above a scattered one", () => {
    expect(fuzzyMatch("mg", "Mg")!.score).toBeGreaterThan(fuzzyMatch("mg", "Meeting")!.score);
  });

  it("scores a match in the file name above one in the folder", () => {
    const inFolder = fuzzyMatch("proj", "Projects/Note.md")!;
    const inName = fuzzyMatch("proj", "Notes/Proj.md")!;
    expect(inName.score).toBeGreaterThan(inFolder.score);
  });

  it("scores shorter paths above longer ones", () => {
    expect(fuzzyMatch("note", "note.md")!.score).toBeGreaterThan(fuzzyMatch("note", "deep/folder/note.md")!.score);
  });

  it("returns sorted, unique indices across all words", () => {
    const match = fuzzyMatch("plan meet", "Meeting-Planning")!;
    expect(match.indices).toEqual([0, 1, 2, 3, 8, 9, 10, 11]);
  });
});

describe("highlight", () => {
  it("splits text into plain and hit parts", () => {
    expect(highlight("Meeting-Planning", [0, 8])).toEqual([
      { text: "M", hit: true },
      { text: "eeting-", hit: false },
      { text: "P", hit: true },
      { text: "lanning", hit: false },
    ]);
  });

  it("merges neighbouring hits into one part", () => {
    expect(highlight("Meeting", [0, 1, 2])).toEqual([
      { text: "Mee", hit: true },
      { text: "ting", hit: false },
    ]);
  });

  it("applies the offset of the file name inside the path", () => {
    expect(highlight("Planning", [8, 9], 8)).toEqual([
      { text: "Pl", hit: true },
      { text: "anning", hit: false },
    ]);
  });

  it("returns one plain part without indices", () => {
    expect(highlight("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(highlight("", [])).toEqual([]);
  });
});
