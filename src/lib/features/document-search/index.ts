// In-document search and replace, registered like every other editor extension.
import { keymap } from "@codemirror/view";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { tick } from "svelte";
import type { EditorView } from "@codemirror/view";
import type { Plugin } from "../../plugins/types";
import { editorStatus } from "../../editorStatus.svelte";
import { fileTypeFor } from "../../filetypes";
import { settings } from "../../settings.svelte";
import { vault } from "../../vault.svelte";

const editorSearchKeymap = searchKeymap.filter((binding) => binding.key !== "Mod-f");

function openPanel(replace: boolean) {
  const view = editorStatus.activeView;
  if (!view) return;
  openSearchPanel(view);
  if (!replace) return;
  requestAnimationFrame(() => {
    view.dom.querySelector<HTMLInputElement>('.cm-panel.cm-search input[name="replace"]')?.focus();
  });
}

async function activeEditor(): Promise<EditorView | null> {
  if (editorStatus.activeView) return editorStatus.activeView;
  if (!vault.openPath || fileTypeFor(vault.openPath)?.id !== "markdown") return null;
  if (settings.app.viewMode === "read") {
    settings.app.viewMode = "edit";
    settings.saveApp();
    await tick();
  }
  return editorStatus.activeView;
}

async function open(replace: boolean) {
  const view = await activeEditor();
  if (!view) return;
  editorStatus.activate(view);
  openPanel(replace);
}

function canSearch(): boolean {
  return !!editorStatus.activeView || (!!vault.openPath && fileTypeFor(vault.openPath)?.id === "markdown");
}

export const documentSearchFeature: Plugin = {
  manifest: {
    id: "document-search",
    name: "Document search",
    description: "Find and replace text in the open note.",
    version: "1.0.0",
  },
  onload(ctx) {
    ctx.registerEditorExtension([search({ top: true, literal: true }), keymap.of(editorSearchKeymap)]);
    ctx.addCommand({
      id: "find",
      name: "Find in document",
      hotkeys: [{ mod: true, key: "f" }],
      when: canSearch,
      run: () => open(false),
    });
    ctx.addCommand({
      id: "replace",
      name: "Replace in document",
      hotkeys: [{ mod: true, key: "h" }],
      when: canSearch,
      run: () => open(true),
    });
  },
};
