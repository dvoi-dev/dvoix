<script lang="ts">
  // CSS snippets manager in Appearance settings: lists `.dvoix/snippets/*.css`,
  // toggles them on/off, creates new snippets, and supports quick inline editing.
  import { Code2, Pencil, Plus, RefreshCw } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { snippets } from "../../snippets.svelte";
  import Toggle from "./Toggle.svelte";

  let creating = $state(false);
  let newName = $state("");
  let createError = $state<string | null>(null);

  let editingFile = $state<string | null>(null);
  let draftCss = $state("");
  let savingEdit = $state(false);
  let editError = $state<string | null>(null);

  onMount(() => {
    void snippets.refresh();
  });

  async function startEdit(file: string) {
    if (editingFile === file) {
      editingFile = null;
      return;
    }
    editError = null;
    try {
      draftCss = await snippets.read(file);
      editingFile = file;
    } catch (e) {
      editError = String(e);
    }
  }

  async function saveEdit() {
    if (!editingFile || savingEdit) return;
    savingEdit = true;
    editError = null;
    try {
      await snippets.save(editingFile, draftCss);
      editingFile = null;
    } catch (e) {
      editError = String(e);
    } finally {
      savingEdit = false;
    }
  }

  async function submitCreate() {
    createError = null;
    try {
      const file = await snippets.create(newName);
      creating = false;
      newName = "";
      await startEdit(file);
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="border-t border-zinc-800/70 py-3">
  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0">
      <div class="text-sm text-zinc-100">CSS snippets</div>
      <div class="mt-0.5 text-xs text-zinc-500">
        Load custom stylesheets from <code class="text-zinc-400">.dvoix/snippets/</code>.
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-md border border-zinc-700/80 bg-zinc-950 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
        onclick={() => {
          creating = !creating;
          createError = null;
        }}
      >
        <Plus size={13} />
        New
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700/80 bg-zinc-950 text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200"
        title="Reload snippets from disk"
        aria-label="Reload CSS snippets"
        onclick={() => void snippets.refresh()}
      >
        <RefreshCw size={13} class={snippets.loading ? "animate-spin" : ""} />
      </button>
    </div>
  </div>

  {#if creating}
    <form
      class="mt-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 p-2"
      onsubmit={(e) => {
        e.preventDefault();
        void submitCreate();
      }}
    >
      <input
        class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-violet-500"
        placeholder="snippet-name.css"
        bind:value={newName}
        onkeydown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            creating = false;
          }
        }}
      />
      <button
        type="submit"
        class="rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-500"
      >
        Create
      </button>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        onclick={() => (creating = false)}
      >
        Cancel
      </button>
    </form>
    {#if createError}
      <p class="mt-1.5 text-xs text-red-400">{createError}</p>
    {/if}
  {/if}

  {#if snippets.error}
    <p class="mt-2 text-xs text-red-400">{snippets.error}</p>
  {/if}
  {#if editError}
    <p class="mt-2 text-xs text-red-400">{editError}</p>
  {/if}

  {#if snippets.files.length}
    <div class="mt-3 divide-y divide-zinc-800/70 rounded-lg border border-zinc-800 bg-zinc-950/50">
      {#each snippets.files as file (file)}
        <div class="px-3 py-2">
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
              <Code2 size={14} class="shrink-0 text-zinc-500" />
              <span class="truncate font-mono text-xs text-zinc-200">{file}</span>
            </div>
            <div class="flex shrink-0 items-center gap-2.5">
              <button
                type="button"
                class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                title="Edit {file}"
                aria-label="Edit {file}"
                onclick={() => void startEdit(file)}
              >
                <Pencil size={13} />
              </button>
              <Toggle
                label="Toggle {file}"
                checked={snippets.isEnabled(file)}
                onchange={(v) => void snippets.setEnabled(file, v)}
              />
            </div>
          </div>

          {#if editingFile === file}
            <div class="mt-2.5 space-y-2">
              <textarea
                rows={7}
                spellcheck="false"
                class="w-full rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs leading-relaxed text-zinc-200 outline-none focus:border-violet-500"
                bind:value={draftCss}
                onkeydown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    void saveEdit();
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    editingFile = null;
                  }
                }}
              ></textarea>
              <div class="flex items-center justify-between">
                <span class="text-[11px] text-zinc-500">Ctrl+Enter to save and apply</span>
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    class="rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    onclick={() => (editingFile = null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
                    disabled={savingEdit}
                    onclick={() => void saveEdit()}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else if !creating}
    <p class="mt-3 rounded-lg border border-dashed border-zinc-800 px-3 py-2.5 text-xs text-zinc-500">
      No CSS snippets yet. Click <strong>New</strong> or place <code class="text-zinc-400">.css</code> files in
      <code class="text-zinc-400">.dvoix/snippets/</code>.
    </p>
  {/if}
</div>
