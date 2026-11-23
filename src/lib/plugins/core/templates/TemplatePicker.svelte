<script lang="ts">
  // Template picker: fuzzy search over the notes of the template folder.
  // "Insert" expands the chosen template at the cursor of the open note,
  // "create" makes a new note from it in the folder that was right-clicked.
  import { FilePlus2, LayoutTemplate, Search } from "@lucide/svelte";
  import { focusTrap } from "../../../focusTrap";
  import { highlight } from "../../../fuzzy";
  import { templatesInFolder } from "../../../templates";
  import { ui } from "../../../ui.svelte";
  import { vault } from "../../../vault.svelte";
  import { createNoteFromTemplate, insertTemplateAtCursor } from "./actions";
  import { TEMPLATE_PICKER } from "./modal";
  import { freeNoteName, templateOptions } from "./picker";
  import { pickerState } from "./pickerState";
  import { templateSettings } from "./settings";

  let query = $state("");
  let selected = $state(0);
  let name = $state("");
  let step = $state<"pick" | "name">("pick");
  let list: HTMLDivElement | undefined = $state();
  let nameInput: HTMLInputElement | undefined = $state();
  let picked: string | null = $state(null);

  const folder = $derived(templateSettings.value.folder);
  const prefix = $derived(folder ? `${folder}/` : "");

  const notes = $derived(templatesInFolder(vault.entries, folder));
  const items = $derived(templateOptions(vault.entries, folder, query));

  $effect(() => {
    void query;
    selected = 0;
  });

  $effect(() => {
    const el = list?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });

  $effect(() => {
    if (step === "name") nameInput?.focus();
  });

  function close() {
    if (ui.modal === TEMPLATE_PICKER) ui.modal = null;
    query = "";
    name = "";
    step = "pick";
    picked = null;
  }

  function choose(index: number) {
    const item = items[index];
    if (!item) return;
    if (pickerState.mode === "insert") {
      const at = pickerState.selection;
      close();
      void insertTemplateAtCursor(item.path, at);
    } else {
      picked = item.path;
      name = freeNoteName(vault.entries, pickerState.folder, item.label.split("/").pop()!);
      step = "name";
    }
  }

  async function createNote() {
    if (!picked || !name.trim()) return;
    const template = picked;
    const folder = pickerState.folder;
    const title = name.trim();
    close();
    const path = await createNoteFromTemplate(template, folder, title);
    if (path) ui.renaming = path;
  }

  function keydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") close();
    else if (step === "name") {
      if (e.key === "Enter") void createNote();
      else return;
    } else if (e.key === "ArrowDown" || (mod && e.key === "n")) selected = items.length ? (selected + 1) % items.length : 0;
    else if (e.key === "ArrowUp" || (mod && e.key === "p")) selected = items.length ? (selected - 1 + items.length) % items.length : 0;
    else if (e.key === "Enter" && items.length) choose(selected);
    else return;
    e.preventDefault();
  }
</script>

{#if ui.modal === TEMPLATE_PICKER}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onclick={close}></div>
  <div
    class="fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[min(640px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-label={pickerState.mode === "insert" ? "Insert template" : "New note from template"}
    use:focusTrap
  >
    {#if step === "pick"}
      <div class="flex items-center gap-2.5 border-b border-zinc-800 px-4">
        <Search size={16} class="shrink-0 text-zinc-500" />
        <input
          class="w-full bg-transparent py-3 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500"
          placeholder={pickerState.mode === "insert" ? "Insert template …" : "New note from template …"}
          role="combobox"
          aria-expanded="true"
          aria-controls="template-picker-list"
          aria-autocomplete="list"
          aria-activedescendant={items.length ? `template-picker-option-${selected}` : undefined}
          bind:value={query}
          onkeydown={keydown}
          onblur={close}
        />
      </div>
      <div id="template-picker-list" class="min-h-0 flex-1 overflow-y-auto p-1.5" bind:this={list} role="listbox" aria-label="Templates">
        {#each items as item, i (item.path)}
          <button
            class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors {i === selected ? 'bg-zinc-800' : ''}"
            data-index={i}
            id="template-picker-option-{i}"
            role="option"
            aria-selected={i === selected}
            tabindex="-1"
            onmousedown={(e) => e.preventDefault()}
            onmousemove={() => (selected = i)}
            onclick={() => choose(i)}
          >
            <LayoutTemplate size={15} strokeWidth={1.75} class="shrink-0 text-zinc-500" />
            <span class="min-w-0 flex-1 truncate text-sm text-zinc-100">
              {#each highlight(item.label, item.indices) as part, k (k)}
                <span class={part.hit ? "font-semibold text-violet-300" : ""}>{part.text}</span>
              {/each}
            </span>
          </button>
        {/each}
        {#if !items.length}
          <p class="px-3 py-3 text-xs text-zinc-500">
            {#if notes.length}
              No template matches "{query.trim()}".
            {:else}
              No templates in "{folder || "the vault root"}". Put Markdown notes there, or change the folder under Settings → Templates.
            {/if}
          </p>
        {/if}
      </div>
      <footer class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800 bg-zinc-950/50 px-4 py-2 text-[11px] text-zinc-500">
        <span class="inline-flex items-center gap-1"><kbd>↑↓</kbd> to select</span>
        <span class="inline-flex items-center gap-1"><kbd>Enter</kbd> to {pickerState.mode === "insert" ? "insert" : "choose"}</span>
        <span class="inline-flex items-center gap-1"><kbd>Esc</kbd> to close</span>
      </footer>
    {:else}
      <div class="flex items-center gap-2.5 border-b border-zinc-800 px-4">
        <FilePlus2 size={16} class="shrink-0 text-zinc-500" />
        <input
          bind:this={nameInput}
          class="w-full bg-transparent py-3 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500"
          placeholder="Name of the new note"
          aria-label="Name of the new note"
          bind:value={name}
          onkeydown={keydown}
        />
      </div>
      <div class="px-4 py-3 text-xs text-zinc-500">
        Creates "{pickerState.folder ? `${pickerState.folder}/` : ""}{name.trim() || "…"}.md" from "{picked?.slice(prefix.length)}".
      </div>
      <footer class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800 bg-zinc-950/50 px-4 py-2 text-[11px] text-zinc-500">
        <span class="inline-flex items-center gap-1"><kbd>Enter</kbd> to create</span>
        <span class="inline-flex items-center gap-1"><kbd>Esc</kbd> to cancel</span>
      </footer>
    {/if}
  </div>
{/if}
