<script lang="ts">
  // A first, minimal canvas: pan the board, drag cards, double-click empty
  // space for a new text card, and drag from a card's border handle to another
  // card to connect them. Edges are edited through their context menu. A full
  // editor (tldraw, Svelte Flow, ...) can replace the interaction later while
  // keeping the same `.canvas` files.
  import type { FileViewProps } from "../../../filetypes/types";
  import { contextMenu, type MenuEntry } from "../../../components/contextMenuState.svelte";
  import {
    arrowPoints,
    colorOf,
    connectNodes,
    edgeGeometry,
    labelPoint,
    nearestSide,
    newId,
    parseCanvas,
    removeEdge,
    serializeCanvas,
    updateEdge,
    type CanvasEdge,
    type CanvasNode,
    type JsonCanvas,
    type Point,
    type Side,
  } from "./jsonCanvas";

  let { content, onchange, onopen }: FileViewProps = $props();

  let canvas = $state<JsonCanvas>({ nodes: [], edges: [] });
  let error = $state<string | undefined>();
  let lastWritten = "";

  // (Re)load whenever the content differs from what we last wrote ourselves.
  $effect(() => {
    if (content === lastWritten) return;
    try {
      canvas = parseCanvas(content);
      error = undefined;
    } catch (e) {
      error = `Invalid canvas file: ${e}`;
    }
  });

  function commit() {
    lastWritten = serializeCanvas($state.snapshot(canvas) as JsonCanvas);
    onchange(lastWritten);
  }

  let pan = $state({ x: 0, y: 0 });
  type Drag =
    | { kind: "pan"; startX: number; startY: number; origX: number; origY: number }
    | { kind: "node"; startX: number; startY: number; origX: number; origY: number; node: CanvasNode }
    | { kind: "edge"; from: CanvasNode; fromSide: Side; x: number; y: number };
  let drag = $state<Drag | undefined>();

  let root: HTMLDivElement | undefined = $state();
  let editingEdge = $state<string | null>(null);
  let labelDraft = $state("");
  let labelInput = $state<HTMLInputElement | undefined>();

  const SIDES: Side[] = ["top", "right", "bottom", "left"];
  const HANDLE_POSITION: Record<Side, string> = {
    top: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2",
    right: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2",
    bottom: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2",
    left: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
  };
  const handleClass = (side: Side) =>
    `pointer-events-auto absolute h-3 w-3 cursor-crosshair rounded-full border border-violet-400 bg-zinc-900 opacity-0 transition-opacity group-hover:opacity-100 ${HANDLE_POSITION[side]}`;

  // Focus the label field as soon as it exists.
  $effect(() => {
    if (!editingEdge || !labelInput) return;
    labelInput.focus();
    labelInput.select();
  });

  function startPan(e: PointerEvent) {
    if (e.target !== e.currentTarget) return;
    drag = { kind: "pan", startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function startNodeDrag(e: PointerEvent, node: CanvasNode) {
    if ((e.target as HTMLElement).closest("textarea, a, button")) return;
    e.stopPropagation();
    drag = { kind: "node", startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y, node };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  /** The pointer in canvas coordinates, i.e. without the current pan. */
  function canvasPoint(e: PointerEvent): Point {
    const rect = root!.getBoundingClientRect();
    return { x: e.clientX - rect.left - pan.x, y: e.clientY - rect.top - pan.y };
  }

  function startEdgeDrag(e: PointerEvent, node: CanvasNode, side: Side) {
    e.preventDefault();
    e.stopPropagation();
    const point = canvasPoint(e);
    drag = { kind: "edge", from: node, fromSide: side, x: point.x, y: point.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!drag) return;
    if (drag.kind === "edge") {
      const point = canvasPoint(e);
      drag.x = point.x;
      drag.y = point.y;
      return;
    }
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.kind === "pan") pan = { x: drag.origX + dx, y: drag.origY + dy };
    else if (drag.node) {
      drag.node.x = Math.round(drag.origX + dx);
      drag.node.y = Math.round(drag.origY + dy);
    }
  }

  function end(e: PointerEvent) {
    if (drag?.kind === "edge") {
      const dropped = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-node-id]");
      const target = dropped ? nodesById.get(dropped.dataset.nodeId ?? "") : undefined;
      if (target && target.id !== drag.from.id) {
        const side = nearestSide(target, drag.x, drag.y);
        if (connectNodes(canvas, drag.from.id, drag.fromSide, target.id, side)) commit();
      }
      drag = undefined;
      return;
    }
    if (drag?.kind === "node") commit();
    drag = undefined;
  }

  function addTextNode(e: MouseEvent) {
    if (e.target !== e.currentTarget) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    canvas.nodes.push({
      id: newId(),
      type: "text",
      text: "",
      x: Math.round(e.clientX - rect.left - pan.x - 125),
      y: Math.round(e.clientY - rect.top - pan.y - 30),
      width: 250,
      height: 60,
    });
    commit();
  }

  function removeNode(node: CanvasNode) {
    canvas.nodes = canvas.nodes.filter((n) => n.id !== node.id);
    canvas.edges = canvas.edges.filter((ed) => ed.fromNode !== node.id && ed.toNode !== node.id);
    commit();
  }

  let nodesById = $derived(new Map(canvas.nodes.map((n) => [n.id, n])));

  /** Start, end and real sides of an edge, or null for a dangling one. */
  function geometryOf(edge: CanvasEdge) {
    const from = nodesById.get(edge.fromNode);
    const to = nodesById.get(edge.toNode);
    return from && to ? edgeGeometry(from, to, edge.fromSide, edge.toSide) : null;
  }

  let edgeDrag = $derived(drag?.kind === "edge" ? drag : null);

  let editing = $derived.by(() => {
    const id = editingEdge;
    if (!id) return null;
    const edge = canvas.edges.find((e) => e.id === id);
    if (!edge) return null;
    const geometry = geometryOf(edge);
    return geometry ? { edge, point: labelPoint(geometry.from, geometry.to) } : null;
  });

  const EDGE_COLORS: { label: string; value: string | undefined }[] = [
    { label: "Default", value: undefined },
    { label: "Red", value: "1" },
    { label: "Orange", value: "2" },
    { label: "Yellow", value: "3" },
    { label: "Green", value: "4" },
    { label: "Cyan", value: "5" },
    { label: "Purple", value: "6" },
  ];

  function beginLabel(edge: CanvasEdge) {
    labelDraft = edge.label ?? "";
    editingEdge = edge.id;
  }

  function commitLabel() {
    const id = editingEdge;
    if (!id) return;
    const label = labelDraft.trim();
    if (updateEdge(canvas, id, { label: label || undefined })) commit();
    editingEdge = null;
  }

  function labelKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitLabel();
    } else if (e.key === "Escape") {
      e.preventDefault();
      editingEdge = null;
    }
  }

  function edgeMenu(e: MouseEvent, edge: CanvasEdge) {
    const id = edge.id;
    const set = (patch: Partial<Omit<CanvasEdge, "id">>) => {
      if (updateEdge(canvas, id, patch)) commit();
    };
    const items: MenuEntry[] = [
      { label: "Edit label", action: () => beginLabel(edge) },
      edge.toEnd === "arrow"
        ? { label: "Remove arrow at target", action: () => set({ toEnd: "none" }) }
        : { label: "Arrow at target", action: () => set({ toEnd: "arrow" }) },
      edge.fromEnd === "arrow"
        ? { label: "Remove arrow at start", action: () => set({ fromEnd: "none" }) }
        : { label: "Arrow at start", action: () => set({ fromEnd: "arrow" }) },
      "separator",
      ...EDGE_COLORS.map((color) => ({ label: `Color: ${color.label}`, action: () => set({ color: color.value }) })),
      "separator",
      {
        label: "Delete edge",
        danger: true,
        action: () => {
          if (removeEdge(canvas, id)) commit();
        },
      },
    ];
    contextMenu.show(e, items);
  }
</script>

{#if error}
  <div class="p-8 text-sm text-red-400">{error}</div>
{:else}
  <div
    bind:this={root}
    class="relative h-full cursor-grab overflow-hidden bg-zinc-950 bg-[radial-gradient(circle,var(--color-zinc-800)_1px,transparent_1px)] [background-size:24px_24px] select-none"
    style:background-position="{pan.x}px {pan.y}px"
    role="application"
    aria-label="Canvas"
    onpointerdown={startPan}
    onpointermove={move}
    onpointerup={end}
    ondblclick={addTextNode}
  >
    <div class="pointer-events-none absolute top-0 left-0" style:transform="translate({pan.x}px, {pan.y}px)">
      <svg class="absolute overflow-visible" width="1" height="1">
        {#each canvas.edges as edge (edge.id)}
          {@const geometry = geometryOf(edge)}
          {#if geometry}
            {@const stroke = colorOf(edge.color) ?? "var(--color-zinc-500)"}
            <g
              role="button"
              tabindex="0"
              aria-label={edge.label ? `Edge: ${edge.label}` : "Edge"}
              class="cursor-pointer"
              oncontextmenu={(e) => edgeMenu(e, edge)}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  beginLabel(edge);
                }
              }}
            >
              <title>{edge.label ?? "Edge"}</title>
              <!-- A wider invisible line makes the edge easy to hit. -->
              <line x1={geometry.from.x} y1={geometry.from.y} x2={geometry.to.x} y2={geometry.to.y} stroke="transparent" stroke-width="14" />
              <line x1={geometry.from.x} y1={geometry.from.y} x2={geometry.to.x} y2={geometry.to.y} {stroke} stroke-width="2" />
              {#if edge.toEnd === "arrow"}
                <polygon points={arrowPoints(geometry.to, geometry.from)} fill={stroke} />
              {/if}
              {#if edge.fromEnd === "arrow"}
                <polygon points={arrowPoints(geometry.from, geometry.to)} fill={stroke} />
              {/if}
              {#if edge.label}
                {@const label = labelPoint(geometry.from, geometry.to)}
                <text
                  x={label.x}
                  y={label.y}
                  text-anchor="middle"
                  dominant-baseline="middle"
                  fill="var(--color-zinc-300)"
                  style="paint-order: stroke; stroke: var(--color-zinc-950); stroke-width: 4px"
                >{edge.label}</text>
              {/if}
            </g>
          {/if}
        {/each}

        {#if edgeDrag}
          {@const start = edgeDrag.from.x + edgeDrag.from.width / 2}
          {@const startY = edgeDrag.from.y + edgeDrag.from.height / 2}
          {@const anchor =
            edgeDrag.fromSide === "top"
              ? { x: start, y: edgeDrag.from.y }
              : edgeDrag.fromSide === "bottom"
                ? { x: start, y: edgeDrag.from.y + edgeDrag.from.height }
                : edgeDrag.fromSide === "left"
                  ? { x: edgeDrag.from.x, y: startY }
                  : { x: edgeDrag.from.x + edgeDrag.from.width, y: startY }}
          <line
            x1={anchor.x}
            y1={anchor.y}
            x2={edgeDrag.x}
            y2={edgeDrag.y}
            stroke="var(--color-violet-400)"
            stroke-width="2"
            stroke-dasharray="6 4"
          />
        {/if}
      </svg>

      {#each canvas.nodes as node (node.id)}
        <div
          class="group pointer-events-auto absolute flex cursor-move flex-col rounded-lg border bg-zinc-900 text-sm shadow-lg"
          class:bg-transparent={node.type === "group"}
          style:left="{node.x}px"
          style:top="{node.y}px"
          style:width="{node.width}px"
          style:height="{node.height}px"
          style:border-color={colorOf(node.color) ?? "var(--color-zinc-700)"}
          role="group"
          data-node-id={node.id}
          onpointerdown={(e) => startNodeDrag(e, node)}
        >
          <button
            class="absolute -top-2 -right-2 hidden h-5 w-5 rounded-full bg-zinc-700 text-xs text-zinc-200 group-hover:block"
            title="Remove"
            onclick={() => removeNode(node)}>×</button
          >
          {#each SIDES as side (side)}
            <button
              type="button"
              class={handleClass(side)}
              title={`Connect from ${side}`}
              aria-label={`Connect from ${side}`}
              onpointerdown={(e) => startEdgeDrag(e, node, side)}
            ></button>
          {/each}
          {#if node.type === "text"}
            <textarea
              class="h-full w-full resize-none bg-transparent p-3 text-zinc-200 outline-none"
              placeholder="Text …"
              bind:value={node.text}
              onblur={commit}
            ></textarea>
          {:else if node.type === "file"}
            <button class="h-full w-full p-3 text-left text-violet-300 hover:underline" onclick={() => onopen(node.file)}>
              {node.file}
            </button>
          {:else if node.type === "link"}
            <a class="p-3 break-all text-violet-300 hover:underline" href={node.url} target="_blank" rel="noreferrer">{node.url}</a>
          {:else}
            <span class="-mt-6 text-xs text-zinc-400">{node.label ?? ""}</span>
          {/if}
        </div>
      {/each}

      {#if editing}
        <input
          bind:this={labelInput}
          class="pointer-events-auto absolute z-10 w-44 -translate-x-1/2 -translate-y-1/2 rounded border border-violet-500 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 shadow-lg outline-none"
          style:left="{editing.point.x}px"
          style:top="{editing.point.y}px"
          placeholder="Edge label …"
          aria-label="Edge label"
          bind:value={labelDraft}
          onkeydown={labelKey}
          onblur={commitLabel}
        />
      {/if}
    </div>

    <div class="pointer-events-none absolute bottom-3 left-3 text-xs text-zinc-500">
      Double-click: new card · Drag: move · Drag a border dot onto a card: connect · Right-click an edge: edit
    </div>
  </div>
{/if}
