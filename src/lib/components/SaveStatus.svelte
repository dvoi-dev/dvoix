<script lang="ts">
  // The real autosave state of one file, shared by the pane header and status bar.
  import { vault } from "../vault.svelte";

  let { path, announce = true }: { path: string | null; announce?: boolean } = $props();

  const state = $derived(vault.saveStateFor(path));
  const label = $derived(
    state === "pending"
      ? "Unsaved"
      : state === "saving"
        ? "Saving …"
        : state === "error"
          ? "Save failed"
          : state === "conflict"
            ? "Changed on disk"
            : "Saved",
  );
  const tone = $derived(
    state === "pending" || state === "conflict"
      ? "text-warning"
      : state === "saving"
        ? "text-violet-300"
        : state === "error"
          ? "text-danger"
          : "text-zinc-500",
  );
  const dot = $derived(
    state === "pending" || state === "conflict"
      ? "bg-warning"
      : state === "saving"
        ? "bg-violet-400"
        : state === "error"
          ? "bg-danger"
          : "bg-zinc-600",
  );
</script>

{#if path}
  <span class="inline-flex items-center gap-1.5 text-[11px] {tone}" role={announce ? "status" : undefined} aria-live={announce ? "polite" : "off"}>
    <span class="h-1.5 w-1.5 rounded-full {dot}" aria-hidden="true"></span>
    {label}
    {#if state === "error"}
      <button
        type="button"
        class="rounded px-1 py-0.5 text-danger transition-colors hover:bg-danger/10"
        title="Retry saving this file"
        onclick={() => void vault.flush(path)}
      >
        Retry
      </button>
    {/if}
  </span>
{/if}
