// Tests for the JSON Canvas edge model: parsing and serializing the open
// format, the geometry of anchors and arrow heads, and the minimal edits that
// create, change and remove an edge.
import { describe, expect, it } from "vitest";
import {
  anchorOf,
  arrowPoints,
  colorOf,
  connectNodes,
  edgeGeometry,
  facingSides,
  labelPoint,
  nearestSide,
  parseCanvas,
  removeEdge,
  serializeCanvas,
  updateEdge,
  type CanvasNode,
  type JsonCanvas,
} from "./jsonCanvas";

const node = (id: string, x: number, y: number, width = 100, height = 100): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x,
  y,
  width,
  height,
});

const canvas = (): JsonCanvas => ({ nodes: [node("a", 0, 0), node("b", 200, 0)], edges: [] });

describe("parse and serialize", () => {
  it("keeps the edge fields of the open format", () => {
    const text = JSON.stringify({
      nodes: [{ id: "a", type: "text", text: "", x: 0, y: 0, width: 10, height: 10 }],
      edges: [{ id: "e", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left", fromEnd: "arrow", toEnd: "none", color: "2", label: "uses" }],
    });
    const parsed = parseCanvas(text);
    expect(parsed.edges).toEqual([
      { id: "e", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left", fromEnd: "arrow", toEnd: "none", color: "2", label: "uses" },
    ]);
  });

  it("treats an empty file as an empty canvas and rejects broken JSON", () => {
    expect(parseCanvas("  \n")).toEqual({ nodes: [], edges: [] });
    expect(() => parseCanvas("{")).toThrow();
  });

  it("defaults missing arrays and writes a trailing newline", () => {
    expect(parseCanvas("{}")).toEqual({ nodes: [], edges: [] });
    const text = serializeCanvas({ nodes: [], edges: [] });
    expect(text).toBe('{\n\t"nodes": [],\n\t"edges": []\n}\n');
    expect(parseCanvas(text)).toEqual({ nodes: [], edges: [] });
  });
});

describe("geometry", () => {
  it("puts an anchor in the middle of each side", () => {
    const n = node("a", 100, 200, 50, 40);
    expect(anchorOf(n, "top")).toEqual({ x: 125, y: 200 });
    expect(anchorOf(n, "right")).toEqual({ x: 150, y: 220 });
    expect(anchorOf(n, "bottom")).toEqual({ x: 125, y: 240 });
    expect(anchorOf(n, "left")).toEqual({ x: 100, y: 220 });
  });

  it("picks the sides that face each other", () => {
    const a = node("a", 0, 0);
    expect(facingSides(a, node("b", 200, 0))).toEqual({ from: "right", to: "left" });
    expect(facingSides(a, node("b", -200, 0))).toEqual({ from: "left", to: "right" });
    expect(facingSides(a, node("b", 0, 200))).toEqual({ from: "bottom", to: "top" });
    expect(facingSides(a, node("b", 0, -200))).toEqual({ from: "top", to: "bottom" });
  });

  it("keeps explicit sides and fills in only the missing one", () => {
    const a = node("a", 0, 0);
    const b = node("b", 200, 0);
    expect(edgeGeometry(a, b)).toEqual({ from: { x: 100, y: 50 }, to: { x: 200, y: 50 }, fromSide: "right", toSide: "left" });
    expect(edgeGeometry(a, b, "top")).toMatchObject({ fromSide: "top", toSide: "left", from: { x: 50, y: 0 } });
    expect(edgeGeometry(a, b, "top", "bottom")).toMatchObject({ fromSide: "top", toSide: "bottom", to: { x: 250, y: 100 } });
  });

  it("finds the side nearest to a drop point", () => {
    const n = node("a", 0, 0);
    expect(nearestSide(n, 2, 50)).toBe("left");
    expect(nearestSide(n, 98, 50)).toBe("right");
    expect(nearestSide(n, 50, 2)).toBe("top");
    expect(nearestSide(n, 50, 98)).toBe("bottom");
  });

  it("draws an arrow head pointing away from the line", () => {
    const points = arrowPoints({ x: 100, y: 0 }, { x: 0, y: 0 }, 10);
    const [tip, left, right] = points.split(" ").map((p) => p.split(",").map(Number));
    expect(tip).toEqual([100, 0]);
    expect(left[0]).toBeLessThan(100);
    expect(right[0]).toBeLessThan(100);
    expect(left[1]).toBeGreaterThan(0);
    expect(right[1]).toBeLessThan(0);
  });

  it("puts a label in the middle", () => {
    expect(labelPoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});

describe("edge edits", () => {
  it("connects two cards and points at the target", () => {
    const c = canvas();
    const edge = connectNodes(c, "a", "right", "b");
    expect(edge).toMatchObject({ fromNode: "a", toNode: "b", fromSide: "right", toSide: "left", toEnd: "arrow" });
    expect(edge?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(c.edges).toHaveLength(1);
  });

  it("takes an explicit target side", () => {
    const c = canvas();
    expect(connectNodes(c, "a", "top", "b", "bottom")).toMatchObject({ fromSide: "top", toSide: "bottom" });
  });

  it("refuses a loop or an unknown card", () => {
    const c = canvas();
    expect(connectNodes(c, "a", "right", "a")).toBeNull();
    expect(connectNodes(c, "a", "right", "missing")).toBeNull();
    expect(connectNodes(c, "missing", "right", "b")).toBeNull();
    expect(c.edges).toEqual([]);
  });

  it("changes label, color and arrow ends", () => {
    const c = canvas();
    const edge = connectNodes(c, "a", "right", "b")!;
    expect(updateEdge(c, edge.id, { label: "uses", color: "3", fromEnd: "arrow" })).toMatchObject({
      label: "uses",
      color: "3",
      fromEnd: "arrow",
    });
    expect(updateEdge(c, edge.id, { color: undefined })?.color).toBeUndefined();
    expect(updateEdge(c, "missing", { label: "x" })).toBeUndefined();
  });

  it("removes one edge only", () => {
    const c = canvas();
    const first = connectNodes(c, "a", "right", "b")!;
    const second = connectNodes(c, "b", "left", "a")!;
    expect(removeEdge(c, first.id)).toBe(true);
    expect(c.edges).toEqual([second]);
    expect(removeEdge(c, first.id)).toBe(false);
  });

  it("maps preset colors and passes hex values through", () => {
    expect(colorOf("1")).toBe("#ef4444");
    expect(colorOf("#123456")).toBe("#123456");
    expect(colorOf(undefined)).toBeUndefined();
  });
});
