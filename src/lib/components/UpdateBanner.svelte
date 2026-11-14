<script lang="ts">
  // Offers an available app update above the status bar; installing restarts
  // the app. App infrastructure, not a vault feature, so it lives in the frame.
  import { Download, X } from "@lucide/svelte";
  import { updater } from "../updater.svelte";
</script>

{#if updater.status === "available" && !updater.dismissed}
  <div
    class="fixed right-4 bottom-10 z-50 flex w-80 items-center gap-2.5 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl"
    role="status"
  >
    <Download size={16} class="shrink-0 text-violet-400" />
    <div class="min-w-0 flex-1 truncate text-sm text-zinc-200">dvoix {updater.version} is available.</div>
    <button
      class="shrink-0 rounded-md bg-violet-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-violet-600"
      onclick={() => void updater.install()}
    >
      Install & restart
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
      <div class="h-full rounded-full bg-violet-500 transition-[width]" style:width="{Math.round(updater.progress * 100)}%"></div>
    </div>
  </div>
{/if}
