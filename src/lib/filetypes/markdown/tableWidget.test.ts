// @vitest-environment happy-dom
// Tests for the live-preview table widget: it renders the cells of the note,
// sends typing and the add buttons back as minimal editor changes, and keeps
// the table when only its text changed.
import { beforeEach, describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { TableWidget } from "./tableWidget";

interface Dispatch {
  changes?: { from: number; to: number; insert: string }[] | { from: number; to: number; insert: string };
  userEvent?: string;
}

function fakeView(): { view: EditorView; dispatches: Dispatch[] } {
  const dispatches: Dispatch[] = [];
  const view = {
    state: { doc: { length: 1000 }, facet: () => undefined },
    posAtDOM: () => 0,
    dispatch: (spec: Dispatch) => dispatches.push(spec),
    focus: () => {},
  } as unknown as EditorView;
  return { view, dispatches };
}

const SOURCE = ["| a | b |", "| --- | --- |", "| c | d |"].join("\n");

function cells(dom: HTMLElement): HTMLElement[] {
  return [...dom.querySelectorAll<HTMLElement>(".cm-lp-cell")];
}

describe("TableWidget", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders the header and body cells with their inline markdown", () => {
    const { view } = fakeView();
    const dom = new TableWidget(SOURCE).toDOM(view);
    document.body.append(dom);
    expect(cells(dom).map((c) => c.textContent)).toEqual(["a", "b", "c", "d"]);
    expect(cells(dom)[0].dataset).toMatchObject({ row: "0", col: "0" });
    // The grip row above the columns plus the header row.
    expect(dom.querySelectorAll("thead tr").length).toBe(2);
    expect(dom.querySelector("thead tr")?.classList.contains("cm-lp-grips")).toBe(true);
    expect(dom.querySelector("strong")?.textContent ?? null).toBeNull();

    const bold = new TableWidget("| **a** |\n| --- |\n| c |").toDOM(view);
    expect(bold.querySelector("strong")?.textContent).toBe("a");
  });

  it("sends typing in a cell back as one small change", () => {
    const { view, dispatches } = fakeView();
    const dom = new TableWidget(SOURCE).toDOM(view);
    document.body.append(dom);
    const cell = cells(dom)[0];
    cell.textContent = "Z";
    cell.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].userEvent).toBe("input");
    expect(dispatches[0].changes).toEqual([{ from: 2, to: 3, insert: "Z" }]);
  });

  it("escapes a typed pipe so the cell does not split", () => {
    const { view, dispatches } = fakeView();
    const dom = new TableWidget(SOURCE).toDOM(view);
    document.body.append(dom);
    const cell = cells(dom)[0];
    cell.textContent = "a|b";
    cell.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dispatches[0].changes).toEqual([{ from: 2, to: 3, insert: "a\\|b" }]);
  });

  it("adds a row and a column through the buttons", () => {
    const { view, dispatches } = fakeView();
    const dom = new TableWidget(SOURCE).toDOM(view);
    document.body.append(dom);
    dom.querySelector<HTMLButtonElement>(".cm-lp-table-add-row")!.click();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].changes).toEqual([{ from: 33, to: 33, insert: "\n|  |  |" }]);

    dom.querySelector<HTMLButtonElement>(".cm-lp-table-add-col")!.click();
    expect(dispatches).toHaveLength(2);
    expect(Array.isArray(dispatches[1].changes)).toBe(true);
    expect((dispatches[1].changes as { insert: string }[])[0].insert).toContain("|");
  });

  it("updates the drawn cells when only the text changed", () => {
    const { view } = fakeView();
    const before = new TableWidget(SOURCE);
    const dom = before.toDOM(view);
    document.body.append(dom);
    const after = new TableWidget("| A | b |\n| --- | --- |\n| c | d |");
    expect(after.updateDOM(dom)).toBe(true);
    expect(cells(dom)[0].textContent).toBe("A");
  });

  it("rebuilds when a row was added and keeps the other cells", () => {
    const { view } = fakeView();
    const before = new TableWidget(SOURCE);
    const dom = before.toDOM(view);
    document.body.append(dom);
    const oldHeader = cells(dom)[0];
    const after = new TableWidget(`${SOURCE}\n| e | f |`);
    expect(after.updateDOM(dom)).toBe(true);
    expect(cells(dom).map((c) => c.textContent)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(cells(dom)[0]).toBe(oldHeader);
  });

  it("compares widgets by their source and keeps its hands off the editor", () => {
    expect(new TableWidget("a").eq(new TableWidget("a"))).toBe(true);
    expect(new TableWidget("a").eq(new TableWidget("b"))).toBe(false);
    expect(new TableWidget("a").ignoreEvent()).toBe(true);
  });
});
