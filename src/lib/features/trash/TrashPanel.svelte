<script lang="ts">
  // Trash panel: browse deleted files/folders in `.trash/`, preview notes,
  // restore to original locations (with conflict copy fallback), or delete permanently.
  import { FileText, Folder, RotateCcw, Search, Trash2, X } from "@lucide/svelte";
  import { api, type TrashedEntry } from "../../api";
  import { toasts } from "../../toast.svelte";
  import { vault } from "../../vault.svelte";
  import { trashState } from "./state.svelte";

  const TEXT_EXTS = new Set(["md", "markdown", "txt", "canvas", "json", "yaml", "yml", "css", "csv", "tsv"]);
  const MAX_PREVIEW_BYTES = 100_000;

  let query = $state("");
  let busyName = $state<string | null>(null);
  let conflictName = $state<string | null>(null);
  let confirmDeleteName = $state<string | null>(null);
  let previewName = $state<string | null>(null);
  let previewText = $state<string | null>(null);
  let previewLoading = $state(false);

  $effect(() => {
    void vault.trashVersion;
    void trashState.refresh();
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return trashState.items;
    return trashState.items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.originalPath?.toLowerCase().includes(q) ?? false),
    );
  });

  function displayName(item: TrashedEntry): string {
    const source = item.originalPath ?? item.name;
    return source.split("/").pop() ?? item.name;
  }

  function locationLabel(item: TrashedEntry): string {
    if (!item.originalPath) return "Original folder unknown (restores to root)";
    const idx = item.originalPath.lastIndexOf("/");
    return idx > 0 ? item.originalPath.slice(0, idx) : "Vault root";
  }

  function canPreview(item: TrashedEntry): boolean {
    if (item.isDir || item.size > MAX_PREVIEW_BYTES) return false;
    const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
    return TEXT_EXTS.has(ext);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatTime(ms: number): string {
    if (!ms) return "";
    const diff = Date.now() - ms;
    if (diff < 60_000) return "Just now";
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  async function togglePreview(item: TrashedEntry) {
    if (!canPreview(item)) return;
    if (previewName === item.name) {
      previewName = null;
      previewText = null;
      return;
    }
    previewName = item.name;
    previewText = null;
    previewLoading = true;
    try {
      const content = await api.readFile(item.trashPath);
      if (previewName === item.name) previewText = content;
    } catch {
      if (previewName === item.name) previewText = null;
    } finally {
      if (previewName === item.name) previewLoading = false;
    }
  }

  async function restore(item: TrashedEntry, renameOnConflict = false) {
    if (busyName) return;
    busyName = item.name;
    try {
      const entry = await vault.restoreTrash(item.name, item.originalPath, { renameOnConflict });
      if (conflictName === item.name) conflictName = null;
      if (previewName === item.name) {
        previewName = null;
        previewText = null;
      }
      toasts.show(`Restored "${entry.path}"`, {
        action: entry.isDir ? undefined : { label: "Open", run: () => vault.openFile(entry.path) },
      });
    } catch (e) {
      const msg = String(e);
      if (!renameOnConflict && msg.toLowerCase().includes("already exists")) {
        conflictName = item.name;
      } else {
        toasts.error(msg);
      }
    } finally {
      if (busyName === item.name) busyName = null;
    }
  }

  async function deleteForever(item: TrashedEntry) {
    if (busyName) return;
    busyName = item.name;
    try {
      await vault.deleteTrashed(item.name);
      if (confirmDeleteName === item.name) confirmDeleteName = null;
      if (conflictName === item.name) conflictName = null;
      if (previewName === item.name) {
        previewName = null;
        previewText = null;
      }
    } catch (e) {
      toasts.error(String(e));
    } finally {
      if (busyName === item.name) busyName = null;
    }
  }
</script>

<div class="px-3 pt-2.5 pb-2">
  <label class="flex items-center gap-2 rounded-md border border-zinc-700/80 bg-zinc-950 px-2.5 py-1.5 focus-within:border-violet-500">
    <Search size={14} class="shrink-0 text-zinc-500" />
    <input
      class="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
      placeholder="Filter trash …"
      bind:value={query}
    />
    {#if query}
      <button
        type="button"
        class="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        aria-label="Clear trash filter"
        onclick={() => (query = "")}
      >
        <X size={13} />
      </button>
    {/if}
  </label>
</div>

{#if trashState.error}
  <p class="px-3 pb-2 text-xs text-red-400">{trashState.error}</p>
{/if}

<div class="flex-1 overflow-y-auto px-1.5 pb-4">
  {#each filtered as item (item.name)}
    {@const isBusy = busyName === item.name}
    {@const previewable = canPreview(item)}
    <div class="group rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-800/60">
      <div class="flex items-start gap-2">
        <span class="mt-0.5 shrink-0 text-zinc-500">
          {#if item.isDir}
            <Folder size={14} strokeWidth={1.75} />
          {:else}
            <FileText size={14} strokeWidth={1.75} />
          {/if}
        </span>

        <button
          type="button"
          class="min-w-0 flex-1 text-left {!previewable ? 'cursor-default' : ''}"
          disabled={!previewable}
          title={previewable ? "Click to preview" : undefined}
          onclick={() => void togglePreview(item)}
        >
          <div class="truncate text-sm font-medium text-zinc-200">{displayName(item)}</div>
          <div class="mt-0.5 truncate text-[11px] text-zinc-500" title={item.originalPath ?? item.trashPath}>
            {locationLabel(item)}
          </div>
          <div class="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
            {#if item.deletedAt}<span>{formatTime(item.deletedAt)}</span>{/if}
            {#if !item.isDir}<span>· {formatSize(item.size)}</span>{/if}
            {#if item.isDir}<span>· Folder</span>{/if}
          </div>
        </button>

        <div class="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-violet-500/15 hover:text-violet-300 disabled:opacity-40"
            title="Restore"
            aria-label="Restore {displayName(item)}"
            disabled={isBusy}
            onclick={() => void restore(item)}
          >
            <RotateCcw size={13} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
            title="Delete permanently"
            aria-label="Delete {displayName(item)} permanently"
            disabled={isBusy}
            onclick={() => (confirmDeleteName = confirmDeleteName === item.name ? null : item.name)}
          >
            <Trash2 size={13} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {#if conflictName === item.name}
        <div class="mt-1.5 flex items-center justify-between gap-2 rounded border border-amber-800/60 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-200">
          <span class="truncate">Target already exists.</span>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="rounded bg-amber-500/20 px-1.5 py-0.5 font-medium text-amber-200 hover:bg-amber-500/30"
              disabled={isBusy}
              onclick={() => void restore(item, true)}
            >
              Restore copy
            </button>
            <button
              type="button"
              class="rounded px-1 py-0.5 text-zinc-400 hover:text-zinc-200"
              onclick={() => (conflictName = null)}
            >
              ×
            </button>
          </div>
        </div>
      {/if}

      {#if confirmDeleteName === item.name}
        <div class="mt-1.5 flex items-center justify-between gap-2 rounded border border-red-900/70 bg-red-950/40 px-2 py-1 text-[11px] text-red-200">
          <span>Delete permanently?</span>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="rounded bg-red-600/80 px-1.5 py-0.5 font-medium text-white hover:bg-red-500"
              disabled={isBusy}
              onclick={() => void deleteForever(item)}
            >
              Delete
            </button>
            <button
              type="button"
              class="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
              onclick={() => (confirmDeleteName = null)}
            >
              Cancel
            </button>
          </div>
        </div>
      {/if}

      {#if previewName === item.name}
        <div class="mt-1.5 rounded border border-zinc-800 bg-zinc-950/80 p-2 text-[11px] text-zinc-300">
          {#if previewLoading}
            <span class="text-zinc-500">Loading preview …</span>
          {:else if previewText !== null}
            <pre class="max-h-36 overflow-auto font-mono leading-relaxed whitespace-pre-wrap break-words">{previewText.trim() || "(Empty file)"}</pre>
          {:else}
            <span class="text-zinc-500">Preview unavailable.</span>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    {#if query.trim()}
      <p class="px-2.5 py-2 text-xs text-zinc-500">Nothing in trash matches "{query.trim()}".</p>
    {:else}
      <p class="px-2.5 py-3 text-xs leading-relaxed text-zinc-500">
        Trash is empty. Deleted files and folders are moved to <code class="text-zinc-400">.trash/</code> and can be restored here.
      </p>
    {/if}
  {/each}
</div>
