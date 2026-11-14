<script lang="ts">
  // Bottom-right toast notifications (e.g. undo after delete/move).
  import { RotateCcw, X } from "@lucide/svelte";
  import { toasts, type ToastItem } from "../toast.svelte";

  let busyId = $state<number | null>(null);

  async function runAction(t: ToastItem) {
    if (!t.action || busyId === t.id) return;
    busyId = t.id;
    try {
      await t.action.run();
      toasts.dismiss(t.id);
    } finally {
      if (busyId === t.id) busyId = null;
    }
  }
</script>

{#if toasts.items.length}
  <div class="pointer-events-none fixed right-4 bottom-8 z-40 flex max-w-sm flex-col gap-2" role="status" aria-live="polite">
    {#each toasts.items as t (t.id)}
      <div
        role="group"
        class="pointer-events-auto flex items-center gap-2.5 rounded-lg border px-3 py-2 text-xs shadow-xl backdrop-blur-sm {t.tone === 'error'
          ? 'border-red-900 bg-red-950/95 text-red-200'
          : 'border-zinc-700 bg-zinc-900/95 text-zinc-200'}"
        onpointerenter={() => toasts.pause(t.id)}
        onpointerleave={() => toasts.resume(t.id)}
      >
        <span class="min-w-0 flex-1 truncate" title={t.message}>{t.message}</span>
        {#if t.action}
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-1 rounded-md bg-violet-500/15 px-2 py-1 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-500/25 disabled:opacity-50"
            disabled={busyId === t.id}
            onclick={() => void runAction(t)}
          >
            <RotateCcw size={12} strokeWidth={2} />
            {t.action.label}
          </button>
        {/if}
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="Dismiss"
          onclick={() => toasts.dismiss(t.id)}
        >
          <X size={13} />
        </button>
      </div>
    {/each}
  </div>
{/if}
