<script lang="ts">
  // Fuzzy command palette (Ctrl/Cmd+P), including commands without a shortcut.
  import { Command, Search } from "@lucide/svelte";
  import { fuzzyMatch, highlight } from "../../fuzzy";
  import { hotkeyLabel, plugins, type Command as RegisteredCommand } from "../../plugins";
  import { ui } from "../../ui.svelte";

  const MODAL = "command-palette";

  interface Item {
    command: RegisteredCommand;
    label: string;
    pluginName: string;
    indices: number[];
    available: boolean;
    shortcuts: string[];
  }

  let query = $state("");
  let selected = $state(0);
  let list: HTMLDivElement | undefined = $state();

  const items = $derived.by((): Item[] => {
    const q = query.trim();
    const scored: { item: Item; score: number }[] = [];
    for (const command of plugins.commands) {
      const pluginName = plugins.get(command.pluginId)?.manifest.name ?? command.pluginId;
      const target = `${command.name} ${pluginName} ${command.fullId}`;
      const match = fuzzyMatch(q, target);
      if (!match) continue;
      const available = !command.when || command.when();
      scored.push({
        item: {
          command,
          label: command.name,
          pluginName,
          indices: fuzzyMatch(q, command.name)?.indices ?? [],
          available,
          shortcuts: plugins.hotkeysFor(command).map(hotkeyLabel),
        },
        score: match.score,
      });
    }
    scored.sort((a, b) => Number(b.item.available) - Number(a.item.available) || b.score - a.score);
    return scored.map((entry) => entry.item);
  });

  $effect(() => {
    void query;
    selected = 0;
  });

  $effect(() => {
    list?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function focus(el: HTMLInputElement) {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => el.focus());
    return { destroy: () => previous?.focus() };
  }

  function close() {
    if (ui.modal === MODAL) ui.modal = null;
    query = "";
  }

  function choose(index: number) {
    const item = items[index];
    if (!item?.available) return;
    close();
    plugins.run(item.command.fullId);
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === "Escape") close();
    else if (event.key === "ArrowDown" || (mod && event.key === "n")) selected = items.length ? (selected + 1) % items.length : 0;
    else if (event.key === "ArrowUp" || (mod && event.key === "p")) selected = items.length ? (selected - 1 + items.length) % items.length : 0;
    else if (event.key === "Enter") choose(selected);
    else return;
    event.preventDefault();
  }
</script>

{#if ui.modal === MODAL}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onclick={close}></div>
  <div
    class="fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[min(680px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
  >
    <div class="flex items-center gap-2.5 border-b border-zinc-800 px-4">
      <Search size={16} class="shrink-0 text-zinc-500" />
      <input
        id="command-palette-input"
        class="w-full bg-transparent py-3 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500"
        placeholder="Search commands …"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-palette-list"
        aria-activedescendant={items[selected] ? `command-palette-option-${selected}` : undefined}
        use:focus
        bind:value={query}
        onkeydown={keydown}
        onblur={close}
      />
    </div>
    <div id="command-palette-list" class="min-h-0 flex-1 overflow-y-auto p-1.5" bind:this={list} role="listbox" aria-label="Commands">
      {#each items as item, index (item.command.fullId)}
        <button
          id="command-palette-option-{index}"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors {index === selected ? 'bg-zinc-800' : ''} {item.available ? '' : 'opacity-45'}"
          data-index={index}
          role="option"
          aria-selected={index === selected}
          aria-disabled={!item.available}
          tabindex="-1"
          onmousedown={(event) => event.preventDefault()}
          onmousemove={() => (selected = index)}
          onclick={() => choose(index)}
        >
          <Command size={15} strokeWidth={1.75} class="shrink-0 text-violet-400" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-zinc-100">
              {#each highlight(item.label, item.indices) as part, partIndex (partIndex)}
                <span class={part.hit ? "font-semibold text-violet-300" : ""}>{part.text}</span>
              {/each}
            </span>
            <span class="block truncate text-[11px] text-zinc-500">{item.pluginName}</span>
          </span>
          <span class="flex shrink-0 gap-1">
            {#each item.shortcuts as shortcut (shortcut)}
              <kbd>{shortcut}</kbd>
            {/each}
          </span>
        </button>
      {/each}
      {#if !items.length}
        <p class="px-3 py-4 text-xs text-zinc-500">No matching commands.</p>
      {/if}
    </div>
    <footer class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800 bg-zinc-950/50 px-4 py-2 text-[11px] text-zinc-500">
      <span class="inline-flex items-center gap-1"><kbd>↑↓</kbd> to select</span>
      <span class="inline-flex items-center gap-1"><kbd>Enter</kbd> to run</span>
      <span class="inline-flex items-center gap-1"><kbd>Esc</kbd> to close</span>
    </footer>
  </div>
{/if}
