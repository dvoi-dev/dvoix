<script lang="ts">
  // Bookmarks panel: pinned notes and folders in user order. Click opens a
  // note (Ctrl/Cmd or middle click in a new tab) or reveals a folder in the
  // file explorer. Drag to reorder; right-click for remove and move actions.
  // Targets that no longer exist stay visible as "Missing" until removed.
  import { Bookmark, ChevronDown, ChevronUp, FileText, Folder, X } from "@lucide/svelte";
  import { contextMenu } from "../../../components/contextMenuState.svelte";
  import { fileTypeFor } from "../../../filetypes";
  import { ui } from "../../../ui.svelte";
  import { vault } from "../../../vault.svelte";
  import { bookmarks, type BookmarkItem } from "./store.svelte";

  const DRAG_TYPE = "application/x-dvoix-bookmark";

  let dragIndex = $state<number | null>(null);
  let dropAt = $state<number | null>(null);

  function label(item: BookmarkItem): string {
    if (item.title) return item.title;
    const name = item.path.split("/").pop() ?? item.path;
    return item.type === "file" && fileTypeFor(item.path)?.id === "markdown" ? name.replace(/\.md$/i, "") : name;
  }

  function location(item: BookmarkItem): string {
    const idx = item.path.lastIndexOf("/");
    return idx > 0 ? item.path.slice(0, idx) : "";
  }

  function missing(item: BookmarkItem): boolean {
    const entry = vault.entryAt(item.path);
    return !entry || entry.isDir !== (item.type === "folder");
  }

  function open(item: BookmarkItem, newTab: boolean) {
    if (missing(item)) return;
    if (item.type === "folder") ui.revealFolder(item.path);
    else void vault.openFile(item.path, { newTab });
  }

  function menu(e: MouseEvent, item: BookmarkItem, index: number) {
    contextMenu.show(e, [
      ...(item.type === "file" && !missing(item)
        ? [{ label: "Open in new tab", icon: FileText, action: () => void vault.openFile(item.path, { newTab: true }) }]
        : []),
      { label: "Move up", icon: ChevronUp, action: () => bookmarks.move(index, index - 1) },
      { label: "Move down", icon: ChevronDown, action: () => bookmarks.move(index, index + 1) },
      "separator",
      { label: "Remove bookmark", icon: X, danger: true, action: () => bookmarks.remove(item.path) },
    ]);
  }

  function dragOver(e: DragEvent, index: number) {
    if (dragIndex === null || !e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = e.clientY < r.top + r.height / 2 ? index : index + 1;
  }

  function drop(e: DragEvent) {
    if (dragIndex === null || dropAt === null) return;
    e.preventDefault();
    bookmarks.move(dragIndex, dropAt > dragIndex ? dropAt - 1 : dropAt);
    dragIndex = dropAt = null;
  }
</script>

<div class="flex-1 overflow-y-auto px-1.5 py-1.5" role="list" aria-label="Bookmarks">
  {#each bookmarks.items as item, i (item.path)}
    {@const gone = missing(item)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="group relative flex w-full items-center rounded-md transition-colors hover:bg-zinc-800/60 {gone ? 'text-zinc-600' : 'text-zinc-300'}"
      role="listitem"
      draggable="true"
      ondragstart={(e) => {
        dragIndex = i;
        e.dataTransfer?.setData(DRAG_TYPE, String(i));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      ondragend={() => (dragIndex = dropAt = null)}
      ondragover={(e) => dragOver(e, i)}
      ondrop={drop}
      oncontextmenu={(e) => menu(e, item, i)}
    >
      {#if dropAt === i}<span class="absolute -top-px right-1 left-1 h-0.5 rounded bg-violet-500"></span>{/if}
      {#if dropAt === i + 1 && i === bookmarks.items.length - 1}<span class="absolute right-1 -bottom-px left-1 h-0.5 rounded bg-violet-500"></span>{/if}
      <button
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-violet-500 focus-visible:ring-inset"
        title={item.path}
        aria-disabled={gone}
        onclick={(e) => open(item, e.ctrlKey || e.metaKey)}
        onauxclick={(e) => e.button === 1 && open(item, true)}
      >
        {#if item.type === "folder"}
          <Folder size={15} strokeWidth={1.75} class="shrink-0 text-zinc-500" />
        {:else}
          <FileText size={15} strokeWidth={1.75} class="shrink-0 text-zinc-500" />
        {/if}
        <span class="min-w-0 flex-1 truncate">
          {label(item)}
          {#if gone}<span class="ml-1.5 text-[11px] text-zinc-600 italic">Missing</span>{/if}
          {#if location(item)}<span class="ml-1.5 text-[11px] text-zinc-600">{location(item)}</span>{/if}
        </span>
      </button>
      <button
        class="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-zinc-700 hover:text-zinc-200"
        title="Remove bookmark"
        aria-label="Remove bookmark {label(item)}"
        onclick={() => bookmarks.remove(item.path)}
      >
        <X size={13} />
      </button>
    </div>
  {:else}
    <div class="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-zinc-500">
      <Bookmark size={20} strokeWidth={1.5} class="text-zinc-600" />
      <p>No bookmarks yet. Right-click a note or folder in the file explorer and choose "Bookmark".</p>
    </div>
  {/each}
</div>
