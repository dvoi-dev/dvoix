<script lang="ts">
  // Compare & merge for an external-change conflict (#54): the local unsaved
  // edits on the left (editable), the disk version on the right (read-only).
  // Chunk arrows take disk changes over; "Apply merged version" saves the
  // result through the conflict-checked write. Nothing is written before that.
  import { MergeView } from "@codemirror/merge";
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
  import { EditorState } from "@codemirror/state";
  import { EditorView, drawSelection, keymap } from "@codemirror/view";
  import { X } from "@lucide/svelte";
  import { focusTrap } from "../focusTrap";
  import { vault } from "../vault.svelte";

  let { path, onclose }: { path: string; onclose: () => void } = $props();

  const conflict = $derived(vault.conflictFor(path));
  const diskContent = $derived(conflict?.diskContent ?? "");

  let host: HTMLDivElement | undefined = $state();
  let merge: MergeView | undefined;
  /** Line endings of the file, so the merge keeps them (CRLF stays CRLF). */
  let crlf = false;

  const theme = EditorView.theme({
    "&": { color: "var(--editor-text)", backgroundColor: "transparent", fontSize: "13px", height: "100%" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--editor-link)" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--editor-gutter)" },
    ".cm-cursor": { borderLeftColor: "var(--editor-link)" },
    "&.cm-focused": { outline: "none" },
  });

  const baseExtensions = [history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), markdown({ base: markdownLanguage }), theme];

  // The merge view is built once per open dialog; the disk side follows
  // further external edits while the dialog is open.
  $effect(() => {
    if (!host || merge) return;
    const local = vault.contentFor(path);
    const disk = diskContent;
    crlf = disk.includes("\r\n") || (!disk && local.includes("\r\n"));
    merge = new MergeView({
      parent: host,
      a: { doc: local.replace(/\r\n?/g, "\n"), extensions: [drawSelection(), EditorView.lineWrapping, ...baseExtensions] },
      b: {
        doc: disk.replace(/\r\n?/g, "\n"),
        extensions: [EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false), ...baseExtensions],
      },
      revertControls: "b-to-a",
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
  });

  // A further external edit while the dialog is open: refresh the disk side.
  $effect(() => {
    const disk = diskContent.replace(/\r\n?/g, "\n");
    if (!merge || merge.b.state.doc.toString() === disk) return;
    merge.b.dispatch({ changes: { from: 0, to: merge.b.state.doc.length, insert: disk } });
  });

  $effect(() => () => merge?.destroy());

  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onclose();
    }
  }

  async function apply() {
    if (!merge) return;
    let text = merge.a.state.doc.toString();
    if (crlf) text = text.replace(/\n/g, "\r\n");
    onclose();
    await vault.resolveConflictMerged(path, text);
  }

  const actionBtn =
    "rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800";
</script>

<svelte:window onkeydown={keydown} />

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onclick={onclose}></div>
<div
  class="fixed top-1/2 left-1/2 z-50 flex h-[min(680px,90vh)] w-[min(1080px,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
  role="dialog"
  aria-modal="true"
  aria-label="Resolve file conflict"
  use:focusTrap
>
  <header class="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5">
    <div class="min-w-0">
      <h2 class="truncate text-sm font-medium text-zinc-200">Resolve conflict: {path}</h2>
      <p class="mt-0.5 text-xs text-zinc-500">
        Left: your unsaved edits (editable). Right: the version on disk. Use the arrows to take chunks from disk, then apply.
      </p>
    </div>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      title="Close without saving"
      aria-label="Close without saving"
      onclick={onclose}
    >
      <X size={15} strokeWidth={1.75} />
    </button>
  </header>
  <div class="grid shrink-0 grid-cols-2 border-b border-zinc-800 bg-zinc-950/60 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
    <div class="border-r border-zinc-800 px-4 py-1.5">Your edits</div>
    <div class="px-4 py-1.5">On disk</div>
  </div>
  <div bind:this={host} class="merge-host min-h-0 flex-1 overflow-auto"></div>
  <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-800 px-4 py-2.5">
    <button type="button" class={actionBtn} onclick={onclose}>Cancel</button>
    <button
      type="button"
      class="rounded-md border border-violet-500/50 bg-violet-500/15 px-2.5 py-1 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-500/25"
      onclick={() => void apply()}
    >
      Apply merged version
    </button>
  </footer>
</div>

<style>
  /* The merge view is only scrollable when its outer element has a height. */
  .merge-host :global(.cm-mergeView) {
    height: 100%;
    overflow-y: auto;
  }
  .merge-host :global(.cm-mergeView .cm-editor) {
    height: auto;
  }
  .merge-host :global(.cm-mergeView .cm-scroller) {
    overflow: visible;
  }
  .merge-host :global(.cm-changedLine) {
    background-color: color-mix(in srgb, var(--color-amber-400) 8%, transparent);
  }
  .merge-host :global(.cm-deletedChunk) {
    background-color: color-mix(in srgb, var(--color-red-400) 8%, transparent);
  }
  .merge-host :global(.cm-changedText) {
    background-color: color-mix(in srgb, var(--color-amber-400) 25%, transparent);
  }
  .merge-host :global(.cm-merge-revert button) {
    color: var(--color-zinc-400);
  }
</style>