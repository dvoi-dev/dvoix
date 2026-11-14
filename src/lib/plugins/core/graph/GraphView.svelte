<script lang="ts">
  // The graph view in a tab: notes as nodes, drawn on a canvas by force-graph
  // (d3-force layout), so a few thousand nodes stay smooth.
  import type ForceGraph from "force-graph";
  import { onMount, untrack } from "svelte";
  import { Crosshair, ExternalLink, Maximize, Pause, Play, RotateCcw, SlidersHorizontal, X, ZoomIn, ZoomOut } from "@lucide/svelte";
  import { api, type GraphData } from "../../../api";
  import { settings as appSettings } from "../../../settings.svelte";
  import { vault } from "../../../vault.svelte";
  import GraphOptions from "./GraphOptions.svelte";
  import {
    buildGraph,
    colorGroupNames,
    colorGroups,
    neighborhood,
    patchGraphData,
    sameShape,
    type EdgeKind,
    type GraphModel,
    type GraphNode,
    type NodeKind,
  } from "./model";
  import { graphSettings } from "./settings";

  type SimNode = GraphNode & { x?: number; y?: number; vx?: number; vy?: number; fx?: number; fy?: number };
  type SimLink = { source: string | SimNode; target: string | SimNode; kind: EdgeKind };
  type LabelBox = { left: number; right: number; top: number; bottom: number };

  const BASE_RADIUS = 4;
  const GROUP_COLORS = 10;
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 12;
  const MAX_FIT_ZOOM = 3;
  const DEFAULT_ALPHA_MIN = 0.001;
  const LABEL_LIMIT = 140;
  const TAU = Math.PI * 2;
  /** Above this many changed notes one read of the whole vault is cheaper than a read per note. */
  const PATCH_MAX = 400;
  const KIND_LABELS: Record<NodeKind, string> = {
    note: "Note",
    attachment: "Attachment",
    unresolved: "Missing note",
    folder: "Folder",
    tag: "Tag",
  };
  const KIND_ORDER: NodeKind[] = ["note", "folder", "tag", "attachment", "unresolved"];

  let container: HTMLDivElement;
  let graph: ForceGraph<SimNode, SimLink> | undefined;
  let version = $state(0);
  // Raw: the data is only ever replaced, and a deep proxy over every note and
  // link of a big vault would cost on every read of buildGraph.
  let data = $state.raw<GraphData>({ notes: [], links: [] });
  let loadError = $state<string | null>(null);
  let importError = $state<string | null>(null);
  let loaded = $state(false);
  let paused = $state(false);
  let zoomLevel = $state(1);
  let hovered = $state.raw<SimNode | null>(null);
  let preview = $state.raw<SimNode | null>(null);
  let inspected = $state.raw<SimNode | null>(null);
  let focusId = $state<string | null>(null);
  let fitted = false;
  let disposed = false;
  let fitTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let defaultAlphaMin = DEFAULT_ALPHA_MIN;
  let neighbours = new Set<string>();
  let activeId: string | null = null;
  let adjacency = new Map<string, Set<string>>();
  let simNodes = new Map<string, SimNode>();
  let labelOrder: SimNode[] = [];
  let positionCache = new Map<string, SimNode>();
  /** What force-graph was handed last, so a change that keeps every node and line does not hand it again. */
  let shown: GraphModel = { nodes: [], edges: [] };
  let engineRunning = false;
  let hoverFlushFrame: number | undefined;
  const labelWidths = new Map<string, number>();
  const alphaColors = new Map<string, string>();

  const settings = $derived(graphSettings.value);
  const ready = $derived(version > 0);
  const wanted = $derived({
    links: settings.links,
    folders: settings.folders,
    tags: settings.tags,
    tagMode: settings.tagMode,
    filter: settings.filter,
    orphans: settings.orphans,
    attachments: settings.attachments,
    unresolved: settings.unresolved,
  });
  let modelSettings = $state.raw<Parameters<typeof buildGraph>[2] | undefined>(undefined);
  let firstSettings = true;
  $effect(() => {
    const next = $state.snapshot(wanted);
    if (firstSettings) {
      firstSettings = false;
      modelSettings = next;
      return;
    }
    const timer = setTimeout(() => (modelSettings = next), 200);
    return () => clearTimeout(timer);
  });
  const model = $derived(buildGraph(data, vault.entries, modelSettings ?? wanted, vault.info?.name ?? "Vault"));
  const displayModel = $derived(focusId ? neighborhood(model, focusId, settings.focusDepth) : model);
  const focusNode = $derived(focusId ? (model.nodes.find((node) => node.id === focusId) ?? null) : null);
  const cardNode = $derived(preview ?? inspected);
  const error = $derived(importError ?? loadError);
  const noteCount = $derived(displayModel.nodes.filter((node) => node.kind === "note").length);
  const connectionCount = $derived(displayModel.edges.length);
  const kindLegend = $derived(KIND_ORDER.filter((kind) => displayModel.nodes.some((node) => node.kind === kind)));
  const groupNames = $derived(settings.colorBy === "none" ? [] : colorGroupNames(displayModel.nodes, settings.colorBy));
  const legendGroups = $derived(groupNames.slice(0, 5).map((name, index) => ({ name, index })));
  const hiddenGroupCount = $derived(Math.max(0, groupNames.length - legendGroups.length));

  let colors = readColors();

  function readColors() {
    const style = getComputedStyle(document.documentElement);
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = (name: string, fallback: string) => {
      const css = style.getPropertyValue(name).trim() || fallback;
      if (!probe) return css;
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = probe.getImageData(0, 0, 1, 1).data;
      return alpha === 255 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
    };
    return {
      node: rgba("--graph-node", "#a1a1aa"),
      link: rgba("--graph-link", "#3f3f46"),
      label: rgba("--graph-label", "#d4d4d8"),
      labelBg: rgba("--graph-label-bg", "#09090b"),
      highlight: rgba("--graph-highlight", "#a78bfa"),
      halo: rgba("--graph-halo", "#a78bfa"),
      structure: rgba("--graph-structure", "#d4d4d8"),
      kinds: {
        attachment: rgba("--graph-attachment", "#71717a"),
        unresolved: rgba("--graph-unresolved", "#52525b"),
        folder: rgba("--graph-folder", "#fcd34d"),
        tag: rgba("--graph-tag", "#34d399"),
      } as Partial<Record<NodeKind, string>>,
      groups: Array.from({ length: GROUP_COLORS }, (_, index) => rgba(`--graph-group-${index + 1}`, "#a78bfa")),
    };
  }

  let groupIndex = new Map<string, number>();

  function withAlpha(color: string, alpha: number): string {
    const key = `${color}|${alpha}`;
    const cached = alphaColors.get(key);
    if (cached) return cached;
    const result = color.startsWith("rgba(")
      ? color.replace(/,\s*[\d.]+\)$/, `, ${alpha})`)
      : color.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
    alphaColors.set(key, result);
    return result;
  }

  function nodeColor(node: SimNode): string {
    const index = groupIndex.get(node.id);
    if (index !== undefined && index < GROUP_COLORS) return colors.groups[index];
    if (settings.colorBy !== "none" && (node.kind === "folder" || node.kind === "tag")) return colors.structure;
    return colors.kinds[node.kind] ?? colors.node;
  }

  function refreshNeighbours() {
    const active = hovered ?? inspected;
    activeId = active?.id ?? null;
    neighbours = active ? (adjacency.get(active.id) ?? new Set()) : new Set();
  }

  function isLit(node: SimNode): boolean {
    return !activeId || node.id === activeId || neighbours.has(node.id);
  }

  function endId(end: string | SimNode): string {
    return typeof end === "string" ? end : end.id;
  }

  function linkLit(link: SimLink): boolean {
    return !!activeId && (endId(link.source) === activeId || endId(link.target) === activeId);
  }

  function radius(node: SimNode): number {
    const grow = settings.sizeByLinks ? Math.min(Math.sqrt(node.degree), 5) * 0.9 : 0;
    const kind = node.kind === "folder" || node.kind === "tag" ? 1.15 : 1;
    return BASE_RADIUS * settings.nodeSize * kind * (1 + grow * 0.5);
  }

  function roundedRectPath(ctx: CanvasRenderingContext2D, left: number, top: number, width: number, height: number, corner: number) {
    const radius = Math.min(corner, width / 2, height / 2);
    ctx.moveTo(left + radius, top);
    ctx.lineTo(left + width - radius, top);
    ctx.quadraticCurveTo(left + width, top, left + width, top + radius);
    ctx.lineTo(left + width, top + height - radius);
    ctx.quadraticCurveTo(left + width, top + height, left + width - radius, top + height);
    ctx.lineTo(left + radius, top + height);
    ctx.quadraticCurveTo(left, top + height, left, top + height - radius);
    ctx.lineTo(left, top + radius);
    ctx.quadraticCurveTo(left, top, left + radius, top);
    ctx.closePath();
  }

  function traceNode(ctx: CanvasRenderingContext2D, node: SimNode, nodeRadius: number) {
    const x = node.x!;
    const y = node.y!;
    ctx.beginPath();
    if (node.kind === "folder") {
      const side = nodeRadius * 1.9;
      roundedRectPath(ctx, x - side / 2, y - side / 2, side, side, nodeRadius * 0.35);
    } else if (node.kind === "attachment") {
      const side = nodeRadius * 1.7;
      roundedRectPath(ctx, x - side / 2, y - side / 2, side, side, nodeRadius * 0.3);
    } else if (node.kind === "tag") {
      const reach = nodeRadius * 1.15;
      ctx.moveTo(x, y - reach);
      ctx.lineTo(x + reach, y);
      ctx.lineTo(x, y + reach);
      ctx.lineTo(x - reach, y);
      ctx.closePath();
    } else {
      ctx.arc(x, y, nodeRadius, 0, TAU);
    }
  }

  function drawNode(node: SimNode, ctx: CanvasRenderingContext2D, scale: number) {
    const nodeRadius = radius(node);
    const isActive = activeId === node.id;
    const isFocus = focusId === node.id;
    ctx.save();
    ctx.globalAlpha = isLit(node) ? 1 : 0.18;
    if (isActive || isFocus) {
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, nodeRadius + 5 / scale, 0, TAU);
      ctx.strokeStyle = colors.halo;
      ctx.lineWidth = 3 / scale;
      ctx.stroke();
    }
    traceNode(ctx, node, nodeRadius);
    if (node.kind === "unresolved") {
      ctx.setLineDash([3 / scale, 2 / scale]);
      ctx.strokeStyle = nodeColor(node);
      ctx.lineWidth = 1.3 / scale;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = nodeColor(node);
      ctx.fill();
      if (isActive) {
        ctx.strokeStyle = colors.highlight;
        ctx.lineWidth = 1.5 / scale;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function paintArea(node: SimNode, color: string, ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = color;
    traceNode(ctx, node, radius(node) + 3);
    ctx.fill();
  }

  function linkColor(link: SimLink): string {
    if (linkLit(link)) return colors.highlight;
    return activeId ? withAlpha(colors.link, 0.25) : colors.link;
  }

  function linkWidth(link: SimLink): number {
    return settings.linkWidth * (linkLit(link) ? 1.8 : 1);
  }

  function arrowLength(): number {
    return settings.arrows ? 3.5 : 0;
  }

  function viewportBounds(scale: number) {
    if (!graph || !container.clientWidth || !container.clientHeight) return null;
    const first = graph.screen2GraphCoords(-60, -60);
    const second = graph.screen2GraphCoords(container.clientWidth + 60, container.clientHeight + 60);
    return {
      left: Math.min(first.x, second.x),
      right: Math.max(first.x, second.x),
      top: Math.min(first.y, second.y),
      bottom: Math.max(first.y, second.y),
      margin: 80 / scale,
    };
  }

  function drawLabels(ctx: CanvasRenderingContext2D, scale: number) {
    const bounds = viewportBounds(scale);
    if (!bounds) return;
    const active = activeId;
    const primary: SimNode[] = [];
    const focused: SimNode[] = [];
    const adjacent: SimNode[] = [];
    const automatic: SimNode[] = [];
    for (const node of labelOrder) {
      if (node.x === undefined || node.y === undefined) continue;
      if (
        node.x < bounds.left - bounds.margin ||
        node.x > bounds.right + bounds.margin ||
        node.y < bounds.top - bounds.margin ||
        node.y > bounds.bottom + bounds.margin
      ) {
        continue;
      }
      if (node.id === active) primary.push(node);
      else if (node.id === focusId) focused.push(node);
      else if (neighbours.has(node.id)) adjacent.push(node);
      else if (!active && settings.labels && scale >= settings.labelZoom) automatic.push(node);
    }
    const candidates = primary.concat(focused, adjacent, automatic);

    const boxes: LabelBox[] = [];
    const fontSize = 12 / scale;
    const padding = 4 / scale;
    let drawn = 0;
    ctx.save();
    ctx.font = "500 12px Inter, ui-sans-serif, system-ui, sans-serif";
    for (const node of candidates) {
      if (!labelWidths.has(node.label)) labelWidths.set(node.label, ctx.measureText(node.label).width);
    }
    ctx.font = `500 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const node of candidates) {
      if (drawn >= LABEL_LIMIT) break;
      const width = (labelWidths.get(node.label) ?? 0) / scale;
      const left = node.x! - width / 2 - padding;
      const top = node.y! + radius(node) + 4 / scale;
      const right = left + width + padding * 2;
      const bottom = top + fontSize + padding * 2;
      if (boxes.some((box) => left < box.right && right > box.left && top < box.bottom && bottom > box.top)) continue;
      boxes.push({ left, right, top, bottom });
      ctx.beginPath();
      roundedRectPath(ctx, left, top, right - left, bottom - top, 3 / scale);
      ctx.fillStyle = colors.labelBg;
      ctx.fill();
      ctx.fillStyle = node.id === active ? colors.highlight : colors.label;
      ctx.fillText(node.label, node.x!, top + padding);
      drawn++;
    }
    ctx.restore();
  }

  function redraw() {
    graph?.nodeCanvasObject(drawNode);
  }

  function cancelHoverFlush() {
    if (hoverFlushFrame === undefined) return;
    cancelAnimationFrame(hoverFlushFrame);
    hoverFlushFrame = undefined;
  }

  function flushHoverBitmap() {
    cancelHoverFlush();
    graph?.nodePointerAreaPaint(paintArea);
  }

  function queueHoverFlush() {
    if (hoverFlushFrame !== undefined) return;
    hoverFlushFrame = requestAnimationFrame(flushHoverBitmap);
  }

  function handlePointerMove() {
    if (engineRunning) queueHoverFlush();
  }

  function gravity() {
    let nodes: SimNode[] = [];
    const force = (alpha: number) => {
      const strength = settings.center * alpha;
      for (const node of nodes) {
        node.vx = (node.vx ?? 0) - (node.x ?? 0) * strength;
        node.vy = (node.vy ?? 0) - (node.y ?? 0) * strength;
      }
    };
    force.initialize = (next: SimNode[]) => (nodes = next);
    return force;
  }

  function applyForces(reheat: boolean) {
    if (!graph) return;
    graph.d3Force("charge")?.strength(-settings.repel);
    graph.d3Force("link")?.distance(settings.linkDistance).strength(settings.linkStrength);
    if (reheat && !paused) graph.d3ReheatSimulation();
  }

  function requestFit(delay: number) {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (!disposed) fitGraph();
    }, delay);
  }

  function fitGraph() {
    if (!graph || !container.clientWidth || !container.clientHeight) return;
    const bounds = graph.getGraphBbox();
    if (!bounds) return;
    const padding = 60;
    const width = Math.max(1, bounds.x[1] - bounds.x[0]);
    const height = Math.max(1, bounds.y[1] - bounds.y[0]);
    const availableWidth = Math.max(1, container.clientWidth - padding * 2);
    const availableHeight = Math.max(1, container.clientHeight - padding * 2);
    const zoom = Math.min(MAX_FIT_ZOOM, Math.max(MIN_ZOOM, Math.min(availableWidth / width, availableHeight / height)));
    graph.centerAt((bounds.x[0] + bounds.x[1]) / 2, (bounds.y[0] + bounds.y[1]) / 2, 400);
    graph.zoom(zoom, 400);
  }

  function toggleControls() {
    graphSettings.value.controlsOpen = !graphSettings.value.controlsOpen;
    graphSettings.save();
  }

  function zoomBy(factor: number) {
    if (!graph) return;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, graph.zoom() * factor));
    graph.zoom(next, 180);
  }

  function setFocus(id: string | null) {
    focusId = id;
    if (id) inspected = positionCache.get(id) ?? simNodes.get(id) ?? inspected;
    refreshNeighbours();
    redraw();
    requestFit(250);
  }

  function toggleFocus(node: SimNode) {
    setFocus(focusId === node.id ? null : node.id);
  }

  function restartLayout() {
    paused = false;
    for (const node of positionCache.values()) {
      delete node.fx;
      delete node.fy;
    }
    graph?.d3ReheatSimulation();
    requestFit(600);
  }

  function openable(node: SimNode): boolean {
    return node.kind === "note" || node.kind === "attachment" || node.kind === "unresolved";
  }

  function openLabel(node: SimNode): string {
    if (node.kind === "unresolved") return "Create note";
    if (node.kind === "attachment") return "Open file";
    return "Open note";
  }

  function openNode(node: SimNode) {
    if (node.kind === "note" || node.kind === "attachment") void vault.openFile(node.path, { newTab: true });
    else if (node.kind === "unresolved") void vault.openLink(node.path, { newTab: true });
  }

  function hoverNode(node: SimNode | null) {
    if ((hovered?.id ?? null) === (node?.id ?? null)) return;
    hovered = node;
    if (node) preview = node;
    refreshNeighbours();
    redraw();
  }

  function enterCanvas() {
    graph?.enablePointerInteraction(true);
    flushHoverBitmap();
  }

  function leaveGraph() {
    cancelHoverFlush();
    hovered = null;
    preview = null;
    refreshNeighbours();
    redraw();
    graph?.enablePointerInteraction(false);
  }

  function clickNode(node: SimNode) {
    inspected = node;
    refreshNeighbours();
    redraw();
    openNode(node);
  }

  function rightClickNode(node: SimNode, event: MouseEvent) {
    event.preventDefault();
    inspected = node;
    toggleFocus(node);
  }

  function backgroundClick() {
    hovered = null;
    preview = null;
    inspected = null;
    refreshNeighbours();
    redraw();
  }

  function canvasKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      setFocus(null);
      inspected = null;
      preview = null;
      refreshNeighbours();
      redraw();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.25);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(0.8);
    } else if (event.key === "0") {
      event.preventDefault();
      fitGraph();
    } else if (event.key === " ") {
      event.preventDefault();
      paused = !paused;
    } else if (event.key === "c") {
      event.preventDefault();
      toggleControls();
    }
  }

  function legendShape(kind: NodeKind): string {
    if (kind === "folder") return "rounded-[2px] bg-amber-300";
    if (kind === "tag") return "rotate-45 rounded-[1px] bg-emerald-400";
    if (kind === "attachment") return "rounded-[2px] bg-zinc-500";
    if (kind === "unresolved") return "rounded-full border border-dashed border-zinc-500 bg-transparent";
    return "rounded-full bg-zinc-400";
  }

  async function loadForceGraph() {
    try {
      const { default: ForceGraphClass } = await import("force-graph");
      return ForceGraphClass;
    } catch (cause) {
      console.error("force-graph could not be loaded", cause);
      importError = 'force-graph is missing. Please run "npm install".';
      return null;
    }
  }

  async function createGraph() {
    const ForceGraphClass = await loadForceGraph();
    if (!ForceGraphClass || !container.isConnected || disposed) return;
    graph = new ForceGraphClass<SimNode, SimLink>(container)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .nodeLabel(() => "")
      .nodeCanvasObject(drawNode)
      .nodePointerAreaPaint(paintArea)
      .linkPointerAreaPaint(() => {})
      .showPointerCursor((obj) => !!obj && openable(obj as SimNode))
      .linkColor(linkColor)
      .linkWidth(linkWidth)
      .linkDirectionalArrowLength(arrowLength)
      .linkDirectionalArrowRelPos(1)
      .minZoom(MIN_ZOOM)
      .maxZoom(MAX_ZOOM)
      .cooldownTime(8000)
      .d3Force("center", null)
      .d3Force("gravity", gravity())
      .onEngineTick(() => {
        engineRunning = true;
      })
      .onEngineStop(() => {
        engineRunning = false;
        flushHoverBitmap();
      })
      .onRenderFramePost(drawLabels)
      .onZoom((transform) => {
        zoomLevel = transform.k;
      })
      .onZoomEnd(() => flushHoverBitmap())
      .onNodeHover(hoverNode)
      .onNodeClick(clickNode)
      .onNodeRightClick(rightClickNode)
      .onBackgroundClick(backgroundClick);
    defaultAlphaMin = graph.d3AlphaMin();
    applyForces(false);
    graph.width(container.clientWidth).height(container.clientHeight);
    version++;
  }

  onMount(() => {
    void createGraph();
    const resize = new ResizeObserver(() => {
      graph?.width(container.clientWidth).height(container.clientHeight);
    });
    resize.observe(container);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const recolor = () => {
      colors = readColors();
      alphaColors.clear();
      labelWidths.clear();
      redraw();
    };
    scheme.addEventListener("change", recolor);
    void document.fonts?.ready.then(() => {
      if (disposed) return;
      labelWidths.clear();
      redraw();
    });
    return () => {
      disposed = true;
      clearTimeout(fitTimer);
      clearTimeout(reloadTimer);
      cancelHoverFlush();
      resize.disconnect();
      scheme.removeEventListener("change", recolor);
      graph?._destructor();
      graph = undefined;
    };
  });

  $effect(() => {
    void [appSettings.appearance.theme, appSettings.appearance.accentColor, appSettings.appearance.customAccentColor];
    const id = requestAnimationFrame(() => {
      alphaColors.clear();
      labelWidths.clear();
      colors = readColors();
      redraw();
    });
    return () => cancelAnimationFrame(id);
  });

  // Reload when files change on disk: once per burst of changes, and only
  // one load at a time (a load that was superseded waits for the next one).
  // A burst of changed notes is read on its own and patched into the data;
  // the whole vault is read only the first time, after an error, for a
  // change that names a folder (it can hold any number of notes) or for a
  // burst so big that one read of everything is cheaper.
  let loadingData = false;
  let dataAgain = false;
  let readAll = true;
  const pendingPaths = new Set<string>();

  function noteChanges(paths: string[]) {
    if (readAll) return;
    if (!paths.length || paths.some((path) => !path.toLowerCase().endsWith(".md"))) {
      readAll = true;
      pendingPaths.clear();
      return;
    }
    for (const path of paths) pendingPaths.add(path);
    if (pendingPaths.size > PATCH_MAX) {
      readAll = true;
      pendingPaths.clear();
    }
  }

  function loadData() {
    if (disposed) return;
    if (loadingData) {
      dataAgain = true;
      return;
    }
    const all = readAll;
    const paths = [...pendingPaths];
    readAll = false;
    pendingPaths.clear();
    if (!all && !paths.length) return;
    loadingData = true;
    (all ? api.graph() : api.graphNotes(paths))
      .then((result) => {
        if (disposed) return;
        data = all ? result : patchGraphData(data, paths, result);
        loadError = null;
      })
      .catch((cause) => {
        if (disposed) return;
        loadError = String(cause);
        // The patch was lost with the error: only a full read is right again.
        readAll = true;
        pendingPaths.clear();
      })
      .finally(() => {
        loadingData = false;
        if (disposed) return;
        loaded = true;
        if (dataAgain) {
          dataAgain = false;
          loadData();
        }
      });
  }

  $effect(() => {
    void vault.changes.notes.number;
    noteChanges(vault.changes.notes.paths);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadData, 250);
    return () => clearTimeout(reloadTimer);
  });

  $effect(() => {
    const visible = displayModel;
    void version;
    if (!graph) return;
    const modelIds = new Set(model.nodes.map((node) => node.id));
    for (const id of positionCache.keys()) {
      if (!modelIds.has(id)) positionCache.delete(id);
    }
    const next = new Map<string, SimNode>();
    const added: SimNode[] = [];
    for (const node of visible.nodes) {
      const old = positionCache.get(node.id);
      const sim = old ? Object.assign(old, node) : { ...node };
      if (!old) added.push(sim);
      next.set(node.id, sim);
      positionCache.set(node.id, sim);
    }
    // The same nodes and the same lines: the change was only in the looks of
    // a node (its title, its first tag), which the objects above now carry.
    // Handing force-graph the data again would restart the layout from full
    // heat, and every note save would shake the whole graph.
    const unchanged = sameShape(visible, shown);
    simNodes = next;
    labelOrder = [...next.values()].sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label));
    adjacency = new Map([...next.keys()].map((id) => [id, new Set<string>()]));
    for (const edge of visible.edges) {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }
    untrack(() => {
      if (hovered && !next.has(hovered.id)) hovered = null;
      if (preview && !next.has(preview.id)) preview = null;
      if (inspected && !next.has(inspected.id)) inspected = null;
      refreshNeighbours();
    });
    if (unchanged) {
      redraw();
      return;
    }
    // A new node starts next to a neighbour that already has its place,
    // instead of at the origin, so it does not fly across the graph.
    for (const node of added) {
      for (const id of adjacency.get(node.id) ?? []) {
        const anchor = next.get(id);
        if (anchor?.x === undefined || anchor.y === undefined) continue;
        node.x = anchor.x + (Math.random() - 0.5) * 20;
        node.y = anchor.y + (Math.random() - 0.5) * 20;
        break;
      }
    }
    shown = visible;
    graph.graphData({ nodes: [...next.values()], links: visible.edges.map((edge) => ({ ...edge })) });
    queueHoverFlush();
    if (!fitted && visible.nodes.length) {
      fitted = true;
      requestFit(800);
    }
  });

  $effect(() => {
    void version;
    groupIndex = colorGroups(displayModel.nodes, settings.colorBy);
    redraw();
  });

  $effect(() => {
    void [settings.repel, settings.linkDistance, settings.linkStrength, settings.center, version];
    applyForces(true);
  });

  $effect(() => {
    void version;
    if (!graph) return;
    graph.d3AlphaMin(paused ? 1 : defaultAlphaMin);
    if (!paused) graph.d3ReheatSimulation();
  });

  $effect(() => {
    void [settings.nodeSize, settings.sizeByLinks, settings.linkWidth, settings.arrows, settings.labelZoom, settings.labels];
    if (!graph) return;
    graph.linkWidth(graph.linkWidth()).linkDirectionalArrowLength(graph.linkDirectionalArrowLength());
    redraw();
  });

  $effect(() => {
    void settings.focusDepth;
    if (focusId) requestFit(250);
  });

  $effect(() => {
    void settings.controlsOpen;
    if (ready) requestFit(250);
  });

  $effect(() => {
    if (focusId && !model.nodes.some((node) => node.id === focusId)) focusId = null;
  });
</script>

<div class="flex h-full w-full flex-col overflow-hidden bg-zinc-950 min-[900px]:flex-row">
  <section class="relative min-h-0 flex-1 overflow-hidden" aria-label="Graph" onpointerleave={leaveGraph}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={container}
      class="graph-surface absolute inset-0 outline-none"
      role="application"
      aria-label="Graph canvas"
      tabindex="0"
      onkeydown={canvasKey}
      oncontextmenu={(event) => event.preventDefault()}
      onpointerenter={enterCanvas}
      onpointermove={handlePointerMove}
    ></div>

    <div class="pointer-events-none absolute top-3 left-3 flex flex-col gap-1">
      <span class="text-sm font-medium text-zinc-200">{vault.info?.name ?? "Vault"}</span>
      <span class="text-xs text-zinc-400">
        {noteCount} {noteCount === 1 ? "note" : "notes"} · {connectionCount} {connectionCount === 1 ? "connection" : "connections"}
      </span>
    </div>

    {#if focusNode}
      <div
        class="absolute top-14 left-3 flex max-w-[calc(100%-7rem)] items-center gap-2 rounded-md border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-xs text-violet-200"
      >
        <Crosshair size={13} class="shrink-0" />
        <span class="truncate">Focused on {focusNode.label} · {settings.focusDepth} {settings.focusDepth === 1 ? "hop" : "hops"}</span>
        <button class="shrink-0 rounded p-0.5 hover:bg-violet-500/20" aria-label="Clear focus" onclick={() => setFocus(null)}>
          <X size={13} />
        </button>
      </div>
    {/if}

    <div class="absolute top-3 right-3 flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/90 p-1 shadow-lg backdrop-blur">
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        title="Zoom out"
        aria-label="Zoom out"
        disabled={!ready}
        onclick={() => zoomBy(0.8)}
      >
        <ZoomOut size={15} />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        title="Zoom in"
        aria-label="Zoom in"
        disabled={!ready}
        onclick={() => zoomBy(1.25)}
      >
        <ZoomIn size={15} />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        title="Fit graph"
        aria-label="Fit graph"
        disabled={!ready}
        onclick={fitGraph}
      >
        <Maximize size={15} />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 {paused
          ? 'text-violet-300'
          : ''}"
        title={paused ? "Resume layout" : "Pause layout"}
        aria-label={paused ? "Resume layout" : "Pause layout"}
        aria-pressed={paused}
        disabled={!ready}
        onclick={() => (paused = !paused)}
      >
        {#if paused}<Play size={15} />{:else}<Pause size={15} />{/if}
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        title="Restart layout"
        aria-label="Restart layout"
        disabled={!ready}
        onclick={restartLayout}
      >
        <RotateCcw size={15} />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 {settings.controlsOpen
          ? 'text-violet-300'
          : ''}"
        title={settings.controlsOpen ? "Hide controls (C)" : "Show controls (C)"}
        aria-label={settings.controlsOpen ? "Hide controls" : "Show controls"}
        aria-pressed={settings.controlsOpen}
        onclick={toggleControls}
      >
        <SlidersHorizontal size={15} />
      </button>
    </div>

    {#if error}
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
        <div class="pointer-events-auto max-w-sm rounded-lg border border-red-900 bg-red-950/70 p-4 text-center shadow-xl">
          <p class="text-sm text-red-200">Graph could not be loaded: {error}</p>
          <button
            class="mt-3 rounded-md border border-red-800 px-3 py-1.5 text-xs text-red-100 hover:bg-red-900/60"
            onclick={() => {
              loadError = null;
              if (importError) {
                importError = null;
                void createGraph();
              } else {
                loadData();
              }
            }}
          >
            Retry
          </button>
        </div>
      </div>
    {:else if !displayModel.nodes.length}
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
        <div class="pointer-events-auto max-w-sm rounded-lg border border-zinc-800 bg-zinc-900/85 p-5 text-center shadow-xl">
          {#if !loaded}
            <p class="text-sm text-zinc-300">Loading graph…</p>
          {:else if settings.filter}
            <p class="text-sm text-zinc-300">No notes match this filter.</p>
            <button
              class="mt-3 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
              onclick={() => {
                graphSettings.value.filter = "";
                graphSettings.save();
              }}
            >
              Clear filter
            </button>
          {:else}
            <p class="text-sm text-zinc-300">No notes in this vault yet.</p>
            <p class="mt-1 text-xs text-zinc-400">Create a note to start building your graph.</p>
          {/if}
        </div>
      </div>
    {/if}

    {#if cardNode}
      <div
        class="absolute bottom-12 left-3 w-64 max-w-[calc(100%-1.5rem)] rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 shadow-xl backdrop-blur"
      >
        <div class="text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">{KIND_LABELS[cardNode.kind]}</div>
        <div class="mt-1 text-sm font-medium break-words text-zinc-100">{cardNode.label}</div>
        <div class="mt-0.5 text-xs break-all text-zinc-400">{cardNode.path || (vault.info?.name ?? "Vault")}</div>
        <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
          <span>{cardNode.degree} {cardNode.degree === 1 ? "connection" : "connections"}</span>
          {#if cardNode.tag}<span class="text-emerald-300">#{cardNode.tag}</span>{/if}
        </div>
        <div class="mt-3 flex gap-2">
          {#if openable(cardNode)}
            <button
              class="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-violet-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
              onclick={() => cardNode && openNode(cardNode)}
            >
              <ExternalLink size={13} />
              {openLabel(cardNode)}
            </button>
          {/if}
          <button
            class="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            onclick={() => cardNode && toggleFocus(cardNode)}
          >
            <Crosshair size={13} />
            {focusId === cardNode.id ? "Unfocus" : "Focus"}
          </button>
        </div>
      </div>
    {/if}

    <div class="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-7rem)] flex-wrap items-center gap-x-3 gap-y-1.5">
      {#if settings.colorBy !== "none" && legendGroups.length}
        {#each legendGroups as group (group.index)}
          <span class="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: var(--graph-group-{group.index + 1})"></span>
            <span class="max-w-28 truncate">{group.name}</span>
          </span>
        {/each}
        {#if hiddenGroupCount}<span class="text-[11px] text-zinc-500">+{hiddenGroupCount} more</span>{/if}
      {:else}
        {#each kindLegend as kind (kind)}
          <span class="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span class="h-2.5 w-2.5 shrink-0 {legendShape(kind)}"></span>
            {KIND_LABELS[kind]}
          </span>
        {/each}
      {/if}
    </div>

    <div
      class="pointer-events-none absolute right-3 bottom-3 rounded-md border border-zinc-800 bg-zinc-900/85 px-2 py-1 text-[11px] text-zinc-400 tabular-nums"
    >
      {Math.round(zoomLevel * 100)}%
    </div>
  </section>

  {#if settings.controlsOpen}
    <aside
      class="flex h-[42%] max-h-[340px] min-h-[200px] w-full shrink-0 flex-col border-t border-zinc-800 bg-zinc-900/60 min-[900px]:h-full min-[900px]:max-h-none min-[900px]:w-72 min-[900px]:border-t-0 min-[900px]:border-l"
      aria-label="Graph controls"
    >
      <header class="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div>
          <h2 class="text-sm font-semibold text-zinc-100">Graph controls</h2>
          <p class="mt-0.5 text-xs text-zinc-400">Changes apply live</p>
        </div>
        <button
          class="rounded-md p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          title="Hide controls"
          aria-label="Hide controls"
          onclick={toggleControls}
        >
          <X size={14} />
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <GraphOptions />
      </div>
    </aside>
  {/if}
</div>
