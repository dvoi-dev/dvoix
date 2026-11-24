// Tests for the GFM table model: parsing cells with their exact positions and
// the pure edits built on it. Every edit must change only the cell, row or
// column it is about, so the padding and style of the table stay as written.
import { describe, expect, it } from "vitest";
import {
  alignOf,
  deleteColumn,
  deleteRow,
  escapeCell,
  fromTSV,
  insertColumn,
  insertRow,
  moveBlock,
  moveColumns,
  moveRows,
  parseRow,
  parseTable,
  setAlign,
  setCell,
  setCells,
  toggleMark,
  toTSV,
  type Change,
} from "./markdownTable";

function apply(text: string, changes: Change | Change[] | null): string {
  const list = (Array.isArray(changes) ? changes : changes ? [changes] : []).sort((a, b) => b.from - a.from);
  for (const change of list) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  return text;
}

const TABLE = ["| a | b |", "| --- | --- |", "| c | d |", "| e | f |"].join("\n");

describe("parseRow", () => {
  it("finds cells and their trimmed positions with outer pipes", () => {
    const row = parseRow("| a | b |");
    expect(row.lead).toBe(true);
    expect(row.trail).toBe(true);
    expect(row.cells.map((c) => c.text)).toEqual(["a", "b"]);
    expect(row.cells[0]).toMatchObject({ from: 2, to: 3, segFrom: 1, segTo: 4 });
    expect(row.cells[1]).toMatchObject({ from: 6, to: 7, segFrom: 5, segTo: 8 });
  });

  it("handles rows without outer pipes", () => {
    const row = parseRow("a | b");
    expect(row.lead).toBe(false);
    expect(row.trail).toBe(false);
    expect(row.cells.map((c) => c.text)).toEqual(["a", "b"]);
    expect(row.cells[0]).toMatchObject({ from: 0, to: 1 });
    expect(row.cells[1]).toMatchObject({ from: 4, to: 5 });
  });

  it("keeps escaped pipes and pipes in code as text", () => {
    expect(parseRow("| a \\| b | `c|d` |").cells.map((c) => c.text)).toEqual(["a \\| b", "`c|d`"]);
  });

  it("places the caret in an empty cell after its first space", () => {
    const row = parseRow("|  | x |");
    expect(row.cells[0].text).toBe("");
    expect(row.cells[0].from).toBe(2);
  });

  it("keeps CRLF out of the cell end", () => {
    const row = parseRow("| a |\r");
    expect(row.cells[0].text).toBe("a");
  });
});

describe("parseTable", () => {
  it("separates header, delimiter and alignment", () => {
    const table = parseTable(["| a | b | c |", "| :--- | :---: | ---: |", "| 1 | 2 | 3 |"].join("\n"));
    expect(table.rows).toHaveLength(2);
    expect(table.columns).toBe(3);
    expect(table.aligns).toEqual(["left", "center", "right"]);
    expect(table.delimiter.cells.map((c) => c.text)).toEqual([":---", ":---:", "---:"]);
  });

  it("takes the column count from the header", () => {
    const table = parseTable(["| a |", "| --- |", "| 1 | 2 |"].join("\n"));
    expect(table.columns).toBe(1);
    expect(table.rows[1].cells).toHaveLength(2);
  });

  it("reads alignment markers", () => {
    expect(alignOf(":---")).toBe("left");
    expect(alignOf(":---:")).toBe("center");
    expect(alignOf("---:")).toBe("right");
    expect(alignOf("---")).toBeNull();
  });
});

describe("cells", () => {
  it("writes one cell in place", () => {
    const table = parseTable(TABLE);
    expect(apply(TABLE, setCell(table, 0, 0, "x"))).toBe("| x | b |\n| --- | --- |\n| c | d |\n| e | f |");
  });

  it("does not escape on its own: the caller escapes typed text", () => {
    expect(escapeCell("a|b")).toBe("a\\|b");
    expect(escapeCell("a\\|b")).toBe("a\\|b");
    expect(escapeCell("line\nbreak")).toBe("line break");
    expect(apply(TABLE, setCell(parseTable(TABLE), 2, 0, escapeCell("x|y")))).toContain("| x\\|y | f |");
  });

  it("adds missing cells to a short row", () => {
    const text = ["| a | b |", "| --- | --- |", "| c |"].join("\n");
    const table = parseTable(text);
    expect(apply(text, setCell(table, 1, 1, "d"))).toBe("| a | b |\n| --- | --- |\n| c | d |");
  });

  it("adds several cells at once and rewrites only short rows", () => {
    const text = ["| a | b |", "| --- | --- |", "| c | d |"].join("\n");
    const table = parseTable(text);
    expect(apply(text, setCells(table, [{ r: 0, c: 1, text: "B" }, { r: 1, c: 0, text: "C" }]))).toBe(
      "| a | B |\n| --- | --- |\n| C | d |",
    );
    const short = ["| a |", "| --- |", "| c |"].join("\n");
    expect(apply(short, setCells(parseTable(short), [{ r: 1, c: 1, text: "d" }]))).toBe("| a |\n| --- |\n| c | d |");
  });
});

describe("rows", () => {
  it("inserts a row in the middle and at the end", () => {
    const table = parseTable(TABLE);
    expect(apply(TABLE, insertRow(table, 2))).toBe(
      "| a | b |\n| --- | --- |\n| c | d |\n|  |  |\n| e | f |",
    );
    expect(apply(TABLE, insertRow(table, 3))).toBe(
      "| a | b |\n| --- | --- |\n| c | d |\n| e | f |\n|  |  |",
    );
  });

  it("deletes a body row with its line break", () => {
    const table = parseTable(TABLE);
    expect(apply(TABLE, deleteRow(table, 1))).toBe("| a | b |\n| --- | --- |\n| e | f |");
    expect(apply(TABLE, deleteRow(table, 2))).toBe("| a | b |\n| --- | --- |\n| c | d |");
  });

  it("moves body rows, keeping the header", () => {
    const table = parseTable(TABLE);
    expect(apply(TABLE, moveRows(table, 1, 1, 3))).toBe("| a | b |\n| --- | --- |\n| e | f |\n| c | d |");
    expect(apply(TABLE, moveRows(table, 2, 2, 1))).toBe("| a | b |\n| --- | --- |\n| e | f |\n| c | d |");
    expect(moveRows(table, 0, 1, 2)).toBeNull();
  });
});

describe("columns", () => {
  it("inserts a column in every line", () => {
    const table = parseTable(TABLE);
    expect(apply(TABLE, insertColumn(table, 1))).toBe(
      "| a |  | b |\n| --- | --- | --- |\n| c |  | d |\n| e |  | f |",
    );
    expect(apply(TABLE, insertColumn(table, 2))).toBe(
      "| a | b |  |\n| --- | --- | --- |\n| c | d |  |\n| e | f |  |",
    );
  });

  it("deletes a column with the right pipe, at the edge too", () => {
    const table = parseTable(TABLE);
    expect(apply(TABLE, deleteColumn(table, 0))).toBe("| b |\n| --- |\n| d |\n| f |");
    expect(apply(TABLE, deleteColumn(table, 1))).toBe("| a |\n| --- |\n| c |\n| e |");
    const bare = ["a | b", "--- | ---", "c | d"].join("\n");
    // Removing the right-hand cell leaves the padding space of the line.
    expect(apply(bare, deleteColumn(parseTable(bare), 1))).toBe("a \n--- \nc ");
  });

  it("moves columns in every line", () => {
    const table = parseTable(TABLE);
    expect(apply(TABLE, moveColumns(table, 0, 0, 2))).toBe("| b | a |\n| --- | --- |\n| d | c |\n| f | e |");
  });

  it("sets alignment in the delimiter row only", () => {
    const table = parseTable(TABLE);
    expect(apply(TABLE, setAlign(table, [0], "center"))).toBe(
      "| a | b |\n| :---: | --- |\n| c | d |\n| e | f |",
    );
    expect(apply(TABLE, setAlign(table, [1], null))).toBe(TABLE);
  });
});

describe("formatting and blocks", () => {
  it("toggles bold and italic for a set of cells", () => {
    expect(toggleMark(["a", "b"], "**")).toEqual(["**a**", "**b**"]);
    expect(toggleMark(["**a**", "**b**"], "**")).toEqual(["a", "b"]);
    expect(toggleMark(["**a**", "b"], "**")).toEqual(["**a**", "**b**"]);
    expect(toggleMark(["", "b"], "*")).toEqual(["", "*b*"]);
    expect(toggleMark(["***a***"], "*")).toEqual(["**a**"]);
  });

  it("moves a block of cells and swaps what it lands on", () => {
    const table = parseTable(["| a | b |", "| --- | --- |", "| c | d |"].join("\n"));
    const updates = moveBlock(table, { r0: 0, c0: 0, r1: 0, c1: 0 }, 1, 1);
    const text = ["| a | b |", "| --- | --- |", "| c | d |"].join("\n");
    expect(apply(text, setCells(table, updates))).toBe("| d | b |\n| --- | --- |\n| c | a |");
    expect(moveBlock(table, { r0: 0, c0: 0, r1: 0, c1: 0 }, 0, 0)).toEqual([]);
  });

  it("round-trips cells as TSV for the clipboard", () => {
    expect(toTSV([["a\\|b", "c"], ["d", "e"]] )).toBe("a|b\tc\nd\te");
    expect(fromTSV("a\tb\r\nc\td\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(fromTSV("x|y")).toEqual([["x\\|y"]]);
  });
});
