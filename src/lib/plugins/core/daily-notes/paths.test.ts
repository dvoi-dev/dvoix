// Tests for the daily note paths: date formats with folders, traversal
// defense, month/year borders and finding the neighboring existing note.
import { describe, expect, it } from "vitest";
import type { VaultEntry } from "../../../api";
import { dailyNotePath, dateOfDailyNote, neighborDailyNote } from "./paths";

function entry(path: string, isDir = false): VaultEntry {
  const name = path.split("/").pop()!;
  return { path, name, extension: isDir ? "" : name.split(".").pop()!, isDir, size: 10, modified: 1000 };
}

const FMT = "YYYY-MM-DD";

describe("dailyNotePath", () => {
  it("builds folder/name.md", () => {
    expect(dailyNotePath(new Date(2026, 10, 23), "Daily", FMT)).toBe("Daily/2026-11-23.md");
    expect(dailyNotePath(new Date(2026, 10, 23), "", FMT)).toBe("2026-11-23.md");
  });

  it("supports folders inside the date format", () => {
    expect(dailyNotePath(new Date(2026, 10, 23), "Journal", "YYYY/MM/YYYY-MM-DD")).toBe("Journal/2026/11/2026-11-23.md");
  });

  it("cleans traversal out of folder and format", () => {
    expect(dailyNotePath(new Date(2026, 10, 23), "../outside", FMT)).toBe("outside/2026-11-23.md");
    expect(dailyNotePath(new Date(2026, 10, 23), "Daily", "../../evil")).toBe("Daily/evil.md");
    expect(dailyNotePath(new Date(2026, 10, 23), "/Daily/", FMT)).toBe("Daily/2026-11-23.md");
  });

  it("falls back to ISO when the format has no tokens", () => {
    expect(dailyNotePath(new Date(2026, 10, 23), "Daily", "")).toBe("Daily/2026-11-23.md");
  });
});

describe("dateOfDailyNote", () => {
  it("recognizes notes of the configured folder and format", () => {
    expect(dateOfDailyNote("Daily/2026-11-23.md", "Daily", FMT)?.getDate()).toBe(23);
    expect(dateOfDailyNote("Journal/2026/11/2026-11-23.md", "Journal", "YYYY/MM/YYYY-MM-DD")?.getMonth()).toBe(10);
  });

  it("rejects other folders, other files and invalid dates", () => {
    expect(dateOfDailyNote("Other/2026-11-23.md", "Daily", FMT)).toBeNull();
    expect(dateOfDailyNote("Daily/Meeting.md", "Daily", FMT)).toBeNull();
    expect(dateOfDailyNote("Daily/2026-02-30.md", "Daily", FMT)).toBeNull();
    expect(dateOfDailyNote("Daily/2026-11-23.png", "Daily", FMT)).toBeNull();
  });
});

describe("neighborDailyNote", () => {
  const entries = [
    entry("Daily", true),
    entry("Daily/2026-11-20.md"),
    entry("Daily/2026-11-23.md"),
    entry("Daily/2026-12-01.md"),
    entry("Daily/2027-01-02.md"),
    entry("Daily/Meeting.md"),
    entry("Other/2026-11-22.md"),
  ];
  const now = new Date(2026, 10, 23);

  it("finds the closest existing note in each direction", () => {
    expect(neighborDailyNote(entries, "Daily/2026-11-23.md", "Daily", FMT, -1, now)).toBe("Daily/2026-11-20.md");
    expect(neighborDailyNote(entries, "Daily/2026-11-23.md", "Daily", FMT, 1, now)).toBe("Daily/2026-12-01.md");
  });

  it("crosses month and year borders", () => {
    expect(neighborDailyNote(entries, "Daily/2026-12-01.md", "Daily", FMT, -1, now)).toBe("Daily/2026-11-23.md");
    expect(neighborDailyNote(entries, "Daily/2026-12-01.md", "Daily", FMT, 1, now)).toBe("Daily/2027-01-02.md");
  });

  it("uses today when the open file is not a daily note", () => {
    expect(neighborDailyNote(entries, "Other/idea.md", "Daily", FMT, -1, now)).toBe("Daily/2026-11-20.md");
    expect(neighborDailyNote(entries, null, "Daily", FMT, 1, now)).toBe("Daily/2026-12-01.md");
  });

  it("returns null at the ends instead of creating anything", () => {
    expect(neighborDailyNote(entries, "Daily/2026-11-20.md", "Daily", FMT, -1, now)).toBeNull();
    expect(neighborDailyNote(entries, "Daily/2027-01-02.md", "Daily", FMT, 1, now)).toBeNull();
  });

  it("works with folder formats and leap days", () => {
    const journal = [entry("Journal/2028/02/2028-02-28.md"), entry("Journal/2028/02/2028-02-29.md"), entry("Journal/2028/03/2028-03-01.md")];
    const fmt = "YYYY/MM/YYYY-MM-DD";
    expect(neighborDailyNote(journal, "Journal/2028/02/2028-02-29.md", "Journal", fmt, -1, now)).toBe("Journal/2028/02/2028-02-28.md");
    expect(neighborDailyNote(journal, "Journal/2028/02/2028-02-29.md", "Journal", fmt, 1, now)).toBe("Journal/2028/03/2028-03-01.md");
  });
});
