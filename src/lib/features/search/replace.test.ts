// Tests for the wording of the vault-wide replace preview and toast.
import { describe, expect, it } from "vitest";
import { replaceDone, replaceQuestion, replaceSummary } from "./replace";

describe("replaceSummary", () => {
  it("uses the singular for one match and one note", () => {
    expect(replaceSummary({ paths: ["a.md"], replacements: 1 })).toBe("1 match in 1 note");
  });

  it("uses the plural for several", () => {
    expect(replaceSummary({ paths: ["a.md", "b.md"], replacements: 4 })).toBe("4 matches in 2 notes");
  });

  it("says zero notes when nothing matched", () => {
    expect(replaceSummary({ paths: [], replacements: 0 })).toBe("0 matches in 0 notes");
  });
});

describe("replaceQuestion and replaceDone", () => {
  it("names the counts and the promise of a minimal change", () => {
    expect(replaceQuestion({ paths: ["a.md", "b.md"], replacements: 2 })).toBe(
      "Replace 2 matches in 2 notes? Only the affected lines change.",
    );
    expect(replaceDone({ paths: ["a.md"], replacements: 3 })).toBe("Replaced 3 matches in 1 note");
  });
});
