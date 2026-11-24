// Types and helpers for the open JSON Canvas format (https://jsoncanvas.org),
// the same format Obsidian uses for `.canvas` files.

export type CanvasColor = string; // "1".."6" preset or "#rrggbb"
export type Side = "top" | "right" | "bottom" | "left";
export type EdgeEnd = "none" | "arrow";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
}

export interface TextNode extends NodeBase { type: "text"; text: string }
export interface FileNode extends NodeBase { type: "file"; file: string; subpath?: string }
export interface LinkNode extends NodeBase { type: "link"; url: string }
export interface GroupNode extends NodeBase { type: "group"; label?: string }

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  /** Arrow at the start or the end of the line, per the JSON Canvas spec. */
  fromEnd?: EdgeEnd;
  toEnd?: EdgeEnd;
  color?: CanvasColor;
  label?: string;
}

export interface JsonCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function parseCanvas(text: string): JsonCanvas {
  if (!text.trim()) return { nodes: [], edges: [] };
  const data = JSON.parse(text) as Partial<JsonCanvas>;
  return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
}

export function serializeCanvas(canvas: JsonCanvas): string {
  return JSON.stringify(canvas, null, "\t") + "\n";
}

export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const PRESETS: Record<string, string> = {
  "1": "#ef4444",
  "2": "#f97316",
  "3": "#eab308",
  "4": "#22c55e",
  "5": "#06b6d4",
  "6": "#a855f7",
};

export function colorOf(color?: CanvasColor): string | undefined {
  if (!color) return undefined;
  return PRESETS[color] ?? color;
}

export interface Point {
  x: number;
  y: number;
}

/** The middle of one side of a card, where an edge starts or ends. */
export function anchorOf(node: CanvasNode, side: Side): Point {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
  }
}

/** The sides that face each other, used when a file leaves them out. */
export function facingSides(from: CanvasNode, to: CanvasNode): { from: Side; to: Side } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: "right", to: "left" } : { from: "left", to: "right" };
  }
  return dy >= 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
}

/** Where an edge starts and ends, with the sides it really uses. */
export function edgeGeometry(
  from: CanvasNode,
  to: CanvasNode,
  fromSide?: Side,
  toSide?: Side,
): { from: Point; to: Point; fromSide: Side; toSide: Side } {
  const facing = facingSides(from, to);
  const start = fromSide ?? facing.from;
  const end = toSide ?? facing.to;
  return { from: anchorOf(from, start), to: anchorOf(to, end), fromSide: start, toSide: end };
}

/** The side of a card closest to a point, for dropping a connection there. */
export function nearestSide(node: CanvasNode, x: number, y: number): Side {
  const distances: [Side, number][] = [
    ["left", Math.abs(x - node.x)],
    ["right", Math.abs(x - (node.x + node.width))],
    ["top", Math.abs(y - node.y)],
    ["bottom", Math.abs(y - (node.y + node.height))],
  ];
  return distances.reduce((best, current) => (current[1] < best[1] ? current : best))[0];
}

/** The arrow head at `tip` as SVG polygon points, pointing away from `from`. */
export function arrowPoints(tip: Point, from: Point, size = 9): string {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const wing = (offset: number): Point => ({
    x: Math.round((tip.x + Math.cos(angle + offset) * size) * 100) / 100,
    y: Math.round((tip.y + Math.sin(angle + offset) * size) * 100) / 100,
  });
  const a = wing(Math.PI * 0.85);
  const b = wing(-Math.PI * 0.85);
  return `${tip.x},${tip.y} ${a.x},${a.y} ${b.x},${b.y}`;
}

/** The middle of an edge, where its label goes. */
export function labelPoint(from: Point, to: Point): Point {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

/**
 * Connects two cards. A new edge points at the target by default, so a
 * connection is visibly directed; the context menu can change that.
 */
export function connectNodes(
  canvas: JsonCanvas,
  fromNode: string,
  fromSide: Side,
  toNode: string,
  toSide?: Side,
): CanvasEdge | null {
  const from = canvas.nodes.find((n) => n.id === fromNode);
  const to = canvas.nodes.find((n) => n.id === toNode);
  if (!from || !to || from.id === to.id) return null;
  const edge: CanvasEdge = {
    id: newId(),
    fromNode,
    toNode,
    fromSide,
    toSide: toSide ?? facingSides(from, to).to,
    toEnd: "arrow",
  };
  canvas.edges.push(edge);
  return edge;
}

/** Changes the fields of one edge. `undefined` removes an optional field. */
export function updateEdge(canvas: JsonCanvas, id: string, patch: Partial<Omit<CanvasEdge, "id">>): CanvasEdge | undefined {
  const edge = canvas.edges.find((e) => e.id === id);
  if (!edge) return undefined;
  Object.assign(edge, patch);
  return edge;
}

/** Removes one edge; false when there is no such edge. */
export function removeEdge(canvas: JsonCanvas, id: string): boolean {
  const index = canvas.edges.findIndex((e) => e.id === id);
  if (index < 0) return false;
  canvas.edges.splice(index, 1);
  return true;
}
