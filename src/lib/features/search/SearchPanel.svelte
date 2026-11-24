<script lang="ts">
  import { Replace as ReplaceIcon, Search, X } from "@lucide/svelte";
  import { api, type ReplaceOptions, type ReplaceOutcome, type SearchHit } from "../../api";
  import { toasts } from "../../toast.svelte";
  import { vault } from "../../vault.svelte";
  import { replaceDone, replaceQuestion } from "./replace";

  let query = $state("");
  let hits = $state<SearchHit[]>([]);

  let showReplace = $state(false);
  let replacement = $state("");
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let regexMode = $state(false);
  let busy = $state(false);
  /** A preview that waits for the user's confirmation. */
  let pending = $state<{ outcome: ReplaceOutcome; path: string | null } | null>(null);

  $effect(() => {
    const q = query;
    void vault.changes.notes.number; // search again when files change
    const timer = setTimeout(async () => {
      hits = q.trim() ? await api.search(q).catch(() => []) : [];
    }, 120);
    return () => clearTimeout(timer);
  });

  // A changed pattern, replacement or option makes a shown confirmation stale.
  $effect(() => {
    void query;
    void replacement;
    void caseSensitive;
    void wholeWord;
    void regexMode;
    void showReplace;
    pending = null;
  });

  const options = $derived.by((): ReplaceOptions => ({ caseSensitive, wholeWord, regex: regexMode }));
  const canReplace = $derived(!busy && query.trim().length > 0);

  /** Saves pending edits and refuses to run while a save is stuck (conflict). */
  async function readyToWrite(): Promise<boolean> {
    await vault.flush();
    if (!vault.hasUnsavedChanges()) return true;
    toasts.error("Some files could not be saved. Retry saving before replacing.");
    return false;
  }

  /** Counts what a replacement would change and asks for confirmation. */
  async function preview(path: string | null) {
    if (!canReplace) return;
    pending = null;
    busy = true;
    try {
      if (!(await readyToWrite())) return;
      const outcome = await api.replaceInVault(query, replacement, options, path ? [path] : null, true);
      if (!outcome.paths.length) {
        toasts.show("Nothing to replace.");
        return;
      }
      pending = { outcome, path };
    } catch (e) {
      toasts.error(String(e));
    } finally {
      busy = false;
    }
  }

  async function confirm() {
    const current = pending;
    if (!current) return;
    pending = null;
    busy = true;
    try {
      const outcome = await api.replaceInVault(
        query,
        replacement,
        options,
        current.path ? [current.path] : null,
        false,
      );
      if (outcome.paths.length) toasts.undo(replaceDone(outcome), () => undo(outcome));
    } catch (e) {
      toasts.error(String(e));
    } finally {
      busy = false;
    }
  }

  /** Writes every previous text back; a conflict leaves that note alone. */
  async function undo(outcome: ReplaceOutcome) {
    try {
      for (const file of outcome.files) {
        await api.writeFile(file.path, file.previousContent, {
          modified: file.entry.modified,
          size: file.entry.size,
        });
      }
    } catch (e) {
      toasts.error(`Undo failed: ${e}`);
    }
  }

  const optionClass = (on: boolean) =>
    `rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
      on ? "bg-violet-600 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
    }`;
</script>

<div class="space-y-1.5 px-3 pt-2.5 pb-2">
  <label class="flex items-center gap-2 rounded-md border border-zinc-700/80 bg-zinc-950 px-2.5 py-1.5 focus-within:border-violet-500">
    <Search size={14} class="shrink-0 text-zinc-500" />
    <input
      class="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
      placeholder="Full-text search …"
      bind:value={query}
    />
    {#if query}
      <button
        type="button"
        class="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        aria-label="Clear search"
        onclick={() => (query = "")}
      >
        <X size={13} />
      </button>
    {/if}
    <button
      type="button"
      class="rounded p-0.5 transition-colors hover:bg-zinc-800 {showReplace ? 'text-violet-300' : 'text-zinc-500 hover:text-zinc-200'}"
      aria-label={showReplace ? "Hide replace" : "Show replace"}
      aria-pressed={showReplace}
      title="Replace"
      onclick={() => (showReplace = !showReplace)}
    >
      <ReplaceIcon size={13} />
    </button>
  </label>

  {#if showReplace}
    <label class="flex items-center rounded-md border border-zinc-700/80 bg-zinc-950 px-2.5 py-1.5 focus-within:border-violet-500">
      <input
        class="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
        placeholder="Replace with …"
        bind:value={replacement}
      />
    </label>
    <div class="flex items-center gap-1">
      <button
        type="button"
        class={optionClass(caseSensitive)}
        aria-pressed={caseSensitive}
        title="Match case"
        onclick={() => (caseSensitive = !caseSensitive)}>Aa</button
      >
      <button
        type="button"
        class={optionClass(wholeWord)}
        aria-pressed={wholeWord}
        title="Whole word"
        onclick={() => (wholeWord = !wholeWord)}>ab</button
      >
      <button
        type="button"
        class={optionClass(regexMode)}
        aria-pressed={regexMode}
        title="Regular expression"
        onclick={() => (regexMode = !regexMode)}>.*</button
      >
      <span class="flex-1"></span>
      <button
        type="button"
        class="rounded bg-violet-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        disabled={!canReplace}
        onclick={() => preview(null)}>Replace all</button
      >
    </div>
    {#if pending}
      <div class="rounded-md border border-zinc-700 bg-zinc-900 p-2 text-xs">
        <p class="text-zinc-300">{replaceQuestion(pending.outcome)}</p>
        <div class="mt-2 flex gap-1.5">
          <button
            type="button"
            class="rounded bg-violet-600 px-2 py-1 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
            disabled={busy}
            onclick={confirm}>{pending.path ? "Replace in note" : "Replace all"}</button
          >
          <button
            type="button"
            class="rounded px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            onclick={() => (pending = null)}>Cancel</button
          >
        </div>
      </div>
    {/if}
  {/if}
</div>

<div class="flex-1 overflow-y-auto px-1.5 pb-4">
  {#each hits as hit (hit.path)}
    <div class="flex items-start rounded-md transition-colors hover:bg-zinc-800/70">
      <button class="min-w-0 flex-1 px-2.5 py-2 text-left" onclick={() => vault.openFile(hit.path)}>
        <div class="truncate text-sm font-medium text-zinc-100">{hit.title}</div>
        <div class="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-400">{hit.snippet}</div>
      </button>
      {#if showReplace}
        <button
          type="button"
          class="mt-2 mr-1.5 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
          title="Replace in this note"
          aria-label="Replace in this note"
          disabled={!canReplace}
          onclick={() => preview(hit.path)}
        >
          <ReplaceIcon size={13} />
        </button>
      {/if}
    </div>
  {:else}
    {#if query.trim()}
      <p class="px-2.5 py-2 text-xs text-zinc-500">Nothing found for "{query.trim()}".</p>
    {:else}
      <p class="px-2.5 py-2 text-xs text-zinc-500">Type to search across all notes in your vault.</p>
    {/if}
  {/each}
</div>
