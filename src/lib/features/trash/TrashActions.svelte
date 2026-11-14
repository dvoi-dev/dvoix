<script lang="ts">
  // Header actions for the Trash panel: refresh and empty trash with inline confirmation.
  import { RefreshCw, Trash2 } from "@lucide/svelte";
  import { toasts } from "../../toast.svelte";
  import { vault } from "../../vault.svelte";
  import { trashState } from "./state.svelte";

  let confirming = $state(false);
  let busy = $state(false);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  function armConfirm() {
    confirming = true;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => (confirming = false), 3500);
  }

  async function emptyAll() {
    if (busy) return;
    busy = true;
    clearTimeout(confirmTimer);
    try {
      await vault.emptyTrash();
      confirming = false;
    } catch (e) {
      toasts.error(String(e));
    } finally {
      busy = false;
    }
  }
</script>

<button
  type="button"
  class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
  title="Refresh trash"
  aria-label="Refresh trash"
  onclick={() => void trashState.refresh()}
>
  <RefreshCw size={14} strokeWidth={1.75} class={trashState.loading ? "animate-spin" : ""} />
</button>

{#if trashState.items.length > 0}
  {#if confirming}
    <button
      type="button"
      class="rounded-md bg-red-600/90 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
      disabled={busy}
      onclick={() => void emptyAll()}
    >
      Empty all?
    </button>
    <button
      type="button"
      class="rounded-md px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      onclick={() => {
        clearTimeout(confirmTimer);
        confirming = false;
      }}
    >
      Cancel
    </button>
  {:else}
    <button
      type="button"
      class="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-red-300"
      title="Empty trash"
      aria-label="Empty trash"
      onclick={armConfirm}
    >
      <Trash2 size={14} strokeWidth={1.75} />
      <span>Empty</span>
    </button>
  {/if}
{/if}
