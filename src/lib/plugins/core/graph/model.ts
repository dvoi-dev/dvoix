// Turns the notes, tags and links of the vault into the nodes and lines of the
// graph view, according to the settings. Pure functions without UI, so the
// rules (which lines exist, what is filtered out) stay readable on their own.
import type { GraphData, VaultEntry } from "../../../api";
import type { ColorBy, GraphSettings } from "./settings";

/** The settings that change which nodes and lines exist (the rest only changes looks). */
export type ModelSettings = Pick<
  GraphSettings,
  "links" | "folders" | "tags" | "tagMode" | "filter" | "orphans" | "attachments" | "unresolved"
>;

export type NodeKind = "note" | "attachment" | "unresolved" | "folder" | "tag";
export type EdgeKind = "link" | "folder" | "tag";

export interface GraphNode {
  /** Unique: the path for files, `folder:<path>`, `tag:<tag>` or `unresolved:<target>` otherwise. */
  id: string;
  kind: NodeKind;
  label: string;
  /** Vault path for notes and attachments; folder path for folders; link text for unresolved notes. */
  path: string;
  /** First tag of a note; the tag itself for a tag node. */
  tag: string | null;
  /** Number of lines at this node. */
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function neighborhood(model: GraphModel, rootId: string, depth: number): GraphModel {
  if (!model.nodes.some((node) => node.id === rootId)) return { nodes: [], edges: [] };

  const adjacency = new Map<string, string[]>();
  for (const edge of model.edges) {
    const from = adjacency.get(edge.source) ?? [];
    from.push(edge.target);
    adjacency.set(edge.source, from);
    const to = adjacency.get(edge.target) ?? [];
    to.push(edge.source);
    adjacency.set(edge.target, to);
  }

  const included = new Set<string>([rootId]);
  let frontier = [rootId];
  const hops = Math.max(1, Math.floor(depth));
  for (let level = 0; level < hops && frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (included.has(neighbor)) continue;
        included.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  return {
    nodes: model.nodes.filter((node) => included.has(node.id)),
    edges: model.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  };
}

/**
 * The data of the whole vault with the notes of `paths` replaced by `part`,
 * the answer of `api.graphNotes(paths)`: their old entries and outgoing links
 * go, what the index has for them now comes in. A path missing from `part`
 * was removed or is no longer a note. Links of other notes are untouched,
 * because a link belongs to the note it is written in.
 *
 * Everything keeps its place: a changed note stays where it was, its links
 * take the place of its old ones, only new ones go to the end. The model built
 * from the result then has its nodes and lines in the same order as before,
 * so `sameShape` can compare them place by place.
 */
export function patchGraphData(data: GraphData, paths: string[], part: GraphData): GraphData {
  const changed = new Set(paths);
  const fresh = new Map(part.notes.map((note) => [note.path, note]));
  const notes: GraphData["notes"] = [];
  for (const note of data.notes) {
    if (!changed.has(note.path)) notes.push(note);
    else if (fresh.has(note.path)) {
      notes.push(fresh.get(note.path)!);
      fresh.delete(note.path);
    }
  }
  for (const note of fresh.values()) notes.push(note);

  const linksOf = new Map<string, GraphData["links"]>();
  for (const link of part.links) {
    const list = linksOf.get(link.source);
    if (list) list.push(link);
    else linksOf.set(link.source, [link]);
  }
  const links: GraphData["links"] = [];
  for (const link of data.links) {
    if (!changed.has(link.source)) links.push(link);
    else {
      const list = linksOf.get(link.source);
      if (list) links.push(...list);
      linksOf.delete(link.source);
    }
  }
  for (const list of linksOf.values()) links.push(...list);
  return { notes, links };
}

/**
 * True when two models have the same nodes and lines in the same order. Two
 * models built from the same data, or from data patched by `patchGraphData`
 * without a new or lost link, line up place by place, so this needs no keys.
 * A different order only costs one unneeded update of the view.
 */
export function sameShape(left: GraphModel, right: GraphModel): boolean {
  if (left.nodes.length !== right.nodes.length || left.edges.length !== right.edges.length) return false;
  for (let i = 0; i < left.nodes.length; i++) if (left.nodes[i].id !== right.nodes[i].id) return false;
  for (let i = 0; i < left.edges.length; i++) {
    const a = left.edges[i];
    const b = right.edges[i];
    if (a.source !== b.source || a.target !== b.target || a.kind !== b.kind) return false;
  }
  return true;
}

/**
 * Above this many notes a tag is drawn as a node even in "shared" mode:
 * lines between every pair would be n² lines and only make a hairball.
 */
export const SHARED_TAG_MAX = 40;

interface Item {
  path: string;
  title: string;
  tags: string[];
}

export function buildGraph(data: GraphData, entries: VaultEntry[], s: ModelSettings, vaultName: string): GraphModel {
  const matches = filterFn(s.filter);
  const resolve = resolver(entries, data.notes);
  const noteSet = new Set(data.notes.map((n) => n.path));

  const nodes = new Map<string, GraphNode>();
  const items = new Map<string, Item>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();

  const addNode = (node: Omit<GraphNode, "degree" | "tag">, item?: Item) => {
    if (!nodes.has(node.id)) nodes.set(node.id, { ...node, tag: item?.tags[0] ?? (node.kind === "tag" ? node.path : null), degree: 0 });
    if (item) items.set(node.id, item);
    return node.id;
  };
  const addEdge = (source: string, target: string, kind: EdgeKind, undirected = false) => {
    if (source === target) return;
    const key = undirected && source > target ? `${target}\0${source}` : `${source}\0${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, kind });
  };

  for (const n of data.notes) {
    const item = { path: n.path, title: n.title, tags: n.tags };
    if (matches(item)) addNode({ id: n.path, kind: "note", label: n.title, path: n.path }, item);
  }

  // Files that are not notes: with "attachments" on, all of them, not only linked ones.
  const attachment = (path: string): string | undefined => {
    if (!s.attachments) return undefined;
    const item = { path, title: fileName(path), tags: [] };
    return matches(item) ? addNode({ id: path, kind: "attachment", label: item.title, path }, item) : undefined;
  };
  if (s.attachments) for (const e of entries) if (!e.isDir && !noteSet.has(e.path)) attachment(e.path);

  if (s.links) {
    for (const link of data.links) {
      if (!nodes.has(link.source)) continue;
      const path = resolve(link.target, link.source);
      let target: string | undefined;
      if (path && noteSet.has(path)) target = nodes.has(path) ? path : undefined;
      else if (path) target = attachment(path);
      else if (s.unresolved && matches({ path: link.target, title: link.target, tags: [] })) {
        target = addNode({ id: `unresolved:${link.target}`, kind: "unresolved", label: link.target, path: link.target });
      }
      if (target) addEdge(link.source, target, "link");
    }
  }

  // Taken before folders and tags add their own nodes.
  const files = [...nodes.values()].filter((n) => n.kind === "note" || n.kind === "attachment");

  if (s.folders) {
    const folderNode = (path: string): string => {
      const id = `folder:${path}`;
      if (nodes.has(id)) return id;
      addNode({ id, kind: "folder", label: path ? fileName(path) : vaultName, path });
      if (path) addEdge(id, folderNode(parentOf(path)), "folder");
      return id;
    };
    for (const f of files) addEdge(f.id, folderNode(parentOf(f.path)), "folder");
  }

  if (s.tags) {
    const byTag = new Map<string, string[]>();
    for (const f of files) {
      for (const tag of items.get(f.id)?.tags ?? []) {
        const list = byTag.get(tag);
        if (list) list.push(f.id);
        else byTag.set(tag, [f.id]);
      }
    }
    for (const [tag, ids] of byTag) {
      if (s.tagMode === "shared" && ids.length <= SHARED_TAG_MAX) {
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addEdge(ids[i], ids[j], "tag", true);
      } else {
        const id = addNode({ id: `tag:${tag}`, kind: "tag", label: `#${tag}`, path: tag });
        for (const f of ids) addEdge(f, id, "tag");
      }
    }
  }

  for (const e of edges) {
    nodes.get(e.source)!.degree++;
    nodes.get(e.target)!.degree++;
  }
  let list = [...nodes.values()];
  if (!s.orphans) list = list.filter((n) => n.degree > 0);
  return { nodes: list, edges };
}

/**
 * Color groups: the top folder or the first tag of each node, numbered by how
 * often they occur (0 = most frequent), so the palette goes to the big groups.
 */
export function colorGroups(nodes: GraphNode[], by: ColorBy): Map<string, number> {
  const { groupOf, order } = groupOrder(nodes, by);
  const index = new Map(order.map((group, position) => [group, position]));
  return new Map([...groupOf].map(([id, group]) => [id, index.get(group)!]));
}

export function colorGroupNames(nodes: GraphNode[], by: ColorBy): string[] {
  return groupOrder(nodes, by).order;
}

function groupOrder(nodes: GraphNode[], by: ColorBy): { groupOf: Map<string, string>; order: string[] } {
  const groupOf = new Map<string, string>();
  const counts = new Map<string, number>();
  if (by === "none") return { groupOf, order: [] };
  for (const node of nodes) {
    const group = by === "tag" ? node.tag : folderGroup(node);
    if (group === null) continue;
    groupOf.set(node.id, group);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const order = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([group]) => group);
  return { groupOf, order };
}

function folderGroup(node: GraphNode): string | null {
  if (node.kind === "tag" || node.kind === "unresolved") return null;
  const top = node.path.split("/")[0];
  // A file in the root has no folder; a top-level folder node is its own group.
  if (node.kind === "folder") return node.path ? top : null;
  return node.path.includes("/") ? top : null;
}

/**
 * Resolves link text the way `vault.resolveLink` does (exact path, path
 * without `.md`, file name, then frontmatter alias, ambiguous ones by path
 * proximity), but with lookup tables, because the graph resolves every link
 * of the vault at once.
 */
function resolver(entries: VaultEntry[], notes: GraphData["notes"]): (target: string, fromPath?: string) => string | undefined {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, path: string) => {
    const list = map.get(key);
    if (list) list.push(path);
    else map.set(key, [path]);
  };
  for (const e of entries) {
    if (e.isDir) continue;
    byPath.set(e.path.toLowerCase(), e.path);
    add(byName, e.name.toLowerCase(), e.path);
  }
  // Frontmatter aliases resolve like file names; the note that owns the
  // alias is a real node, not an "unresolved" one.
  const byAlias = new Map<string, string[]>();
  for (const n of notes) for (const alias of n.aliases) add(byAlias, alias.toLowerCase(), n.path);
  const closest = (paths: string[], fromPath?: string): string => {
    const from = (fromPath ?? "").toLowerCase().split("/");
    let best = paths[0];
    let bestShared = -1;
    for (const path of paths) {
      const parts = path.toLowerCase().split("/");
      let shared = 0;
      while (shared < from.length - 1 && shared < parts.length - 1 && from[shared] === parts[shared]) shared++;
      if (shared > bestShared || (shared === bestShared && path.toLowerCase() < best.toLowerCase())) {
        best = path;
        bestShared = shared;
      }
    }
    return best;
  };
  return (target, fromPath) => {
    const t = target.toLowerCase();
    const exact = byPath.get(t) ?? byPath.get(`${t}.md`);
    if (exact) return exact;
    const byNameHit = byName.get(t) ?? byName.get(`${t}.md`);
    if (byNameHit) return closest(byNameHit, fromPath);
    const byAliasHit = byAlias.get(t);
    return byAliasHit ? closest(byAliasHit, fromPath) : undefined;
  };
}

/**
 * The filter field: every term must occur in the path, the title or as `#tag`;
 * a term starting with `-` hides what it matches. Case-insensitive.
 */
export function filterFn(filter: string): (item: Item) => boolean {
  const terms = filter.toLowerCase().split(/\s+/).filter((t) => t && t !== "-");
  if (!terms.length) return () => true;
  return (item) => {
    const hay = `${item.path}\n${item.title}\n${item.tags.map((t) => `#${t}`).join(" ")}`.toLowerCase();
    return terms.every((t) => (t.startsWith("-") ? !hay.includes(t.slice(1)) : hay.includes(t)));
  };
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
