<script lang="ts">
  // Offers an available app update above the status bar; installing restarts
  // the app. App infrastructure, not a vault feature, so it lives in the frame.
  import { CircleAlert, Download, X } from "@lucide/svelte";
  import { updater } from "../updater.svelte";

  /** A failed install keeps the banner, so the error is seen and can be retried. */
  const failed = $derived(updater.status === "error" && updater.version !== null);
</script>

{#if (updater.status === "available" || failed) && !updater.dismissed}
  <div
    class="fixed right-4 bottom-10 z-50 flex w-80 items-center gap-2.5 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl"
    role={failed ? "alert" : "status"}
  >
    {#if failed}
      <CircleAlert size={16} class="shrink-0 text-red-400" />
      <div class="min-w-0 flex-1 text-sm text-zinc-200">
        <div>Installing dvoix {updater.version} failed.</div>
        <div class="mt-0.5 line-clamp-3 text-xs text-red-400" title={updater.error ?? ""}>{updater.error}</div>
      </div>
    {:else}
      <Download size={16} class="shrink-0 text-violet-400" />
      <div class="min-w-0 flex-1 truncate text-sm text-zinc-200">dvoix {updater.version} is available.</div>
    {/if}
    <button
      class="shrink-0 rounded-md bg-violet-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-violet-600"
      onclick={() => void updater.install()}
    >
      {failed ? "Retry" : "Install & restart"}
    </button>
    <button
      class="shrink-0 rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      aria-label="Dismiss update"
      onclick={() => (updater.dismissed = true)}
    >
      <X size={14} />
    </button>
  </div>
{:else if updater.status === "downloading"}
  <div class="fixed right-4 bottom-10 z-50 w-80 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl" role="status">
    <div class="text-sm text-zinc-200">Installing dvoix {updater.version} …</div>
    <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
      {#if updater.progress === null}
        <!-- size unknown: a pulsing full bar instead of one stuck at 0% -->
        <div class="h-full w-full animate-pulse rounded-full bg-violet-500/60"></div>
      {:else}
        <div class="h-full rounded-full bg-violet-500 transition-[width]" style:width="{Math.round(updater.progress * 100)}%"></div>
      {/if}
    </div>
  </div>
{/if}
