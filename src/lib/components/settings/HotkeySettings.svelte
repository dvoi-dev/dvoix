<script lang="ts">
  // Rebindable command shortcuts. Overrides live in `.dvoix/hotkeys.json`;
  // conflicts are shown before a binding is taken from another command.
  import { onMount } from "svelte";
  import { AlertTriangle, Plus, RotateCcw, Search, X } from "@lucide/svelte";
  import { fuzzyMatch } from "../../fuzzy";
  import { hotkeys, hotkeyFromEvent, type BoundCommand } from "../../hotkeys.svelte";
  import { hotkeyLabel, plugins, type Command } from "../../plugins";
  import type { Hotkey } from "../../plugins/types";

  let query = $state("");
  let capture = $state<{ command: Command; index: number | null; pending?: { hotkey: Hotkey; conflicts: BoundCommand[] } } | null>(null);
  let message = $state<string | null>(null);
  let confirmReset = $state(false);

  onMount(() => () => {
    hotkeys.capturing = false;
  });

  const groups = $derived.by(() => {
    const q = query.trim();
    return [...plugins.features, ...plugins.all, ...plugins.extra]
      .map((plugin) => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        commands: plugins.commands.filter((command) => {
          if (command.pluginId !== plugin.manifest.id) return false;
          return !q || !!fuzzyMatch(q, `${command.name} ${plugin.manifest.name} ${command.fullId}`);
        }),
      }))
      .filter((group) => group.commands.length);
  });

  const conflictNames = $derived(
    capture?.pending?.conflicts
      .map((conflict) => plugins.commands.find((command) => command.fullId === conflict.fullId)?.name ?? conflict.fullId)
      .join(", ") ?? "",
  );

  function start(command: Command, index: number | null = null) {
    capture = { command, index };
    message = null;
    confirmReset = false;
    hotkeys.capturing = true;
  }

  function cancel() {
    capture = null;
    message = null;
    hotkeys.capturing = false;
  }

  function apply(hotkey: Hotkey, replace = false) {
    if (!capture) return;
    const conflicts = hotkeys.assign(capture.command, hotkey, capture.index, plugins.commands, replace);
    if (conflicts.length) {
      capture = { ...capture, pending: { hotkey, conflicts } };
      message = null;
      return;
    }
    cancel();
  }

  function captureKey(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      cancel();
      return;
    }
    const hotkey = hotkeyFromEvent(event);
    if (!hotkey) {
      message = "Use Ctrl/Cmd, Alt, or a function key.";
      return;
    }
    apply(hotkey);
  }

  function focusCapture(el: HTMLButtonElement) {
    requestAnimationFrame(() => el.focus());
  }

  function conflictKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  function resetAll() {
    if (!confirmReset) {
      confirmReset = true;
      return;
    }
    hotkeys.resetAll();
    confirmReset = false;
    cancel();
  }

  const iconButton =
    "flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200";
</script>

<div class="py-3">
  <div class="flex items-center gap-2">
    <div class="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-2.5">
      <Search size={14} class="shrink-0 text-zinc-500" />
      <input
        class="w-full bg-transparent py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        placeholder="Search commands …"
        aria-label="Search keyboard shortcuts"
        bind:value={query}
      />
    </div>
    <button
      type="button"
      class="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      onclick={resetAll}
    >
      {confirmReset ? "Confirm reset" : "Reset all"}
    </button>
  </div>
  <p class="pt-2 text-xs leading-relaxed text-zinc-500">
    Select a shortcut to change it, or add another one. Esc cancels recording. Shortcuts are saved for this vault.
  </p>

  {#each groups as group (group.id)}
    <div class="pt-4 pb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{group.name}</div>
    {#each group.commands as command (command.fullId)}
      {@const bound = plugins.hotkeysFor(command)}
      <div class="flex items-start justify-between gap-4 border-b border-zinc-800/40 py-2 text-sm text-zinc-300 last:border-b-0">
        <span class="min-w-0 truncate pt-1" title={command.fullId}>{command.name}</span>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {#each bound as hotkey, index (index)}
            <span class="inline-flex items-center gap-0.5 rounded border border-zinc-700/70 bg-zinc-950/60 pr-0.5">
              <button
                type="button"
                class="rounded px-1 py-0.5 hover:bg-zinc-800"
                title="Change shortcut"
                aria-label="Change {command.name} shortcut"
                onclick={() => start(command, index)}
              >
                <kbd>{hotkeyLabel(hotkey)}</kbd>
              </button>
              <button
                type="button"
                class="flex h-5 w-5 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                aria-label="Remove {command.name} shortcut"
                onclick={() => {
                  cancel();
                  hotkeys.remove(command, index);
                }}
              >
                <X size={11} />
              </button>
            </span>
          {/each}
          {#if !bound.length}<span class="px-1 text-xs text-zinc-600">Unbound</span>{/if}
          {#if capture?.command.fullId === command.fullId}
            <div class="flex flex-col items-end gap-1">
              <button
                type="button"
                class="rounded-md border border-violet-500 bg-violet-500/10 px-2 py-1 text-xs text-violet-300 outline-none"
                use:focusCapture
                onkeydowncapture={captureKey}
              >
                Press keys …
              </button>
              {#if message}<span class="max-w-56 text-right text-[11px] text-warning">{message}</span>{/if}
              {#if capture.pending}
                <div class="flex flex-col items-end gap-1" onkeydowncapture={conflictKey}>
                  <span class="flex max-w-64 items-center gap-1 text-right text-[11px] text-warning">
                    <AlertTriangle size={12} class="shrink-0" />
                    Used by {conflictNames}
                  </span>
                  <span class="flex gap-1">
                    <button
                      type="button"
                      class="rounded bg-violet-500 px-2 py-0.5 text-[11px] text-white"
                      use:focusCapture
                      onclick={() => capture?.pending && apply(capture.pending.hotkey, true)}
                    >
                      Replace
                    </button>
                    <button type="button" class="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400" onclick={cancel}>Cancel</button>
                  </span>
                </div>
              {/if}
            </div>
          {:else}
            <button type="button" class={iconButton} title="Add shortcut" aria-label="Add {command.name} shortcut" onclick={() => start(command)}>
              <Plus size={13} />
            </button>
          {/if}
          {#if hotkeys.isOverridden(command.fullId)}
            <button
              type="button"
              class={iconButton}
              title="Reset command shortcut"
              aria-label="Reset {command.name} shortcut"
              onclick={() => {
                cancel();
                hotkeys.resetCommand(command);
              }}
            >
              <RotateCcw size={12} />
            </button>
          {/if}
        </div>
      </div>
    {/each}
  {/each}
  {#if !groups.length}<p class="py-4 text-xs text-zinc-500">No matching commands.</p>{/if}
</div>
