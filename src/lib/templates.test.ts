// Tests for the shared template engine: variable substitution, date tokens,
// parsing dates back (for daily note navigation) and the template folder list.
import { describe, expect, it } from "vitest";
import type { VaultEntry } from "./api";
import { formatDate, noteTitle, parseDate, renderTemplate, templatesInFolder } from "./templates";

const vars = { title: "Meeting notes", now: new Date(2026, 10, 23, 9, 5, 7), dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" };

function entry(path: string, isDir = false): VaultEntry {
  const name = path.split("/").pop()!;
  return { path, name, extension: isDir ? "" : name.split(".").pop()!, isDir, size: 10, modified: 1000 };
}

describe("renderTemplate", () => {
  it("fills title, date and time", () => {
    expect(renderTemplate("# {{title}}\n{{date}} at {{time}}", vars)).toBe("# Meeting notes\n2026-11-23 at 09:05");
  });

  it("supports a format per placeholder", () => {
    expect(renderTemplate("{{date:YYYY}}/{{date:MM}} {{time:HH:mm:ss}}", vars)).toBe("2026/11 09:05:07");
  });

  it("keeps unknown placeholders as they are", () => {
    expect(renderTemplate("{{title}} {{unknown}} {{{x}}}", vars)).toBe("Meeting notes {{unknown}} {{{x}}}");
    expect(renderTemplate("{{ date }}", vars)).toBe("2026-11-23");
  });

  it("leaves a template without placeholders unchanged", () => {
    const text = "# Weekly review\n\n- [ ] Inbox\n";
    expect(renderTemplate(text, vars)).toBe(text);
  });
});

describe("formatDate", () => {
  it("formats the common tokens", () => {
    const d = new Date(2026, 0, 5, 14, 3, 9); // Mon Jan 05 2026
    expect(formatDate(d, "YYYY-MM-DD")).toBe("2026-01-05");
    expect(formatDate(d, "dddd, MMMM D, YYYY")).toBe("Monday, January 5, 2026");
    expect(formatDate(d, "ddd MMM DD YY HH:mm:ss")).toBe("Mon Jan 05 26 14:03:09");
    expect(formatDate(d, "M/D H:m:s")).toBe("1/5 14:3:9");
  });

  it("keeps bracketed text literal", () => {
    expect(formatDate(new Date(2026, 10, 23), "[Daily]/YYYY-MM-DD")).toBe("Daily/2026-11-23");
    expect(formatDate(new Date(2026, 10, 23), "[YYYY]")).toBe("YYYY");
  });

  it("formats a leap day", () => {
    expect(formatDate(new Date(2028, 1, 29), "YYYY-MM-DD")).toBe("2028-02-29");
  });
});

describe("parseDate", () => {
  it("reads back what formatDate writes", () => {
    const d = new Date(2026, 10, 23);
    for (const pattern of ["YYYY-MM-DD", "YYYY/MM/DD", "DD.MM.YYYY", "MMMM D, YYYY", "YY-MM-DD"]) {
      const parsed = parseDate(formatDate(d, pattern), pattern);
      expect(parsed?.getFullYear()).toBe(2026);
      expect(parsed?.getMonth()).toBe(10);
      expect(parsed?.getDate()).toBe(23);
    }
  });

  it("matches literals and bracketed text exactly", () => {
    expect(parseDate("Daily/2026-11-23", "[Daily]/YYYY-MM-DD")?.getDate()).toBe(23);
    expect(parseDate("2026-11-23", "[Daily]/YYYY-MM-DD")).toBeNull();
    expect(parseDate("notes/2026-11-23.md", "YYYY-MM-DD")).toBeNull();
  });

  it("rejects impossible dates", () => {
    expect(parseDate("2026-02-30", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2026-13-01", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2026-00-10", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2027-02-29", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2028-02-29", "YYYY-MM-DD")?.getDate()).toBe(29);
  });

  it("requires year, month and day", () => {
    expect(parseDate("2026", "YYYY")).toBeNull();
    expect(parseDate("2026-11", "YYYY-MM")).toBeNull();
  });

  it("ignores weekday tokens but still matches them", () => {
    expect(parseDate("Monday 2026-11-23", "dddd YYYY-MM-DD")?.getDate()).toBe(23);
    expect(parseDate("Someday 2026-11-23", "dddd YYYY-MM-DD")).toBeNull();
  });

  it("keeps short years in this century", () => {
    expect(parseDate("26-11-23", "YY-MM-DD")?.getFullYear()).toBe(2026);
  });
});

describe("templatesInFolder", () => {
  const entries = [
    entry("Templates", true),
    entry("Templates/Meeting.md"),
    entry("Templates/sub/Weekly.md"),
    entry("Templates/photo.png"),
    entry("Other/Meeting.md"),
    entry("Template notes.md"),
  ];

  it("lists only notes inside the folder, sorted naturally", () => {
    const more = [...entries, entry("Templates/Note 10.md"), entry("Templates/Note 2.md")];
    expect(templatesInFolder(more, "Templates").map((e) => e.path)).toEqual([
      "Templates/Meeting.md",
      "Templates/Note 2.md",
      "Templates/Note 10.md",
      "Templates/sub/Weekly.md",
    ]);
  });

  it("cleans the folder setting: slashes and traversal cannot escape", () => {
    expect(templatesInFolder(entries, "/Templates/").map((e) => e.path)).toContain("Templates/Meeting.md");
    expect(templatesInFolder([...entries, entry("Outside.md")], "../Outside")).toEqual([]);
  });

  it("matches the folder case-insensitively and never a name prefix", () => {
    expect(templatesInFolder(entries, "templates")).toHaveLength(2);
    expect(templatesInFolder(entries, "Template")).toEqual([]);
  });

  it("an empty folder means the vault root", () => {
    expect(templatesInFolder(entries, "").map((e) => e.path)).toContain("Other/Meeting.md");
  });
});

describe("noteTitle", () => {
  it("strips folders and the markdown extension", () => {
    expect(noteTitle("Daily/2026-11-23.md")).toBe("2026-11-23");
    expect(noteTitle("Ideas.MD")).toBe("Ideas");
    expect(noteTitle("plain")).toBe("plain");
  });
});
