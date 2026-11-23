// What the picker does with a chosen template: insert it at the cursor of the
// open note, or create a new note from it. The template file is only read.
import { tick } from "svelte";
import { api } from "../../../api";
import { editorStatus } from "../../../editorStatus.svelte";
import { fileTypeFor } from "../../../filetypes";
import { settings } from "../../../settings.svelte";
import { noteTitle, renderTemplate } from "../../../templates";
import { toasts } from "../../../toast.svelte";
import { vault } from "../../../vault.svelte";
import { templateSettings } from "./settings";

/** The editor of the open note, switching from the reading view like document search does. */
async function activeEditor() {
  if (editorStatus.activeView) return editorStatus.activeView;
  if (!vault.openPath || fileTypeFor(vault.openPath)?.id !== "markdown") return null;
  if (settings.app.viewMode === "read") {
    settings.app.viewMode = "edit";
    settings.saveApp();
    await tick();
  }
  return editorStatus.activeView;
}

/** Whether "Insert template" can run: an open Markdown note. */
export function canInsert(): boolean {
  return !!editorStatus.activeView || (!!vault.openPath && fileTypeFor(vault.openPath)?.id === "markdown");
}

/** Reads a template and fills its variables for a note titled `title`. */
export async function expandTemplate(path: string, title: string, now = new Date()): Promise<string | null> {
  try {
    const text = await api.readFile(path);
    return renderTemplate(text, {
      title,
      now,
      dateFormat: templateSettings.value.dateFormat,
      timeFormat: templateSettings.value.timeFormat,
    });
  } catch (e) {
    toasts.error(`Could not read template "${path}": ${e}`);
    return null;
  }
}

/**
 * Inserts the expanded template where the cursor was when the picker opened
 * (a selection is replaced). Only this range of the document changes.
 */
export async function insertTemplateAtCursor(templatePath: string, at: { from: number; to: number } | null): Promise<void> {
  const path = vault.openPath;
  if (!path) return;
  const text = await expandTemplate(templatePath, noteTitle(path));
  if (text === null) return;
  const view = await activeEditor();
  if (!view) return;
  const max = view.state.doc.length;
  const from = Math.min(at?.from ?? max, max);
  const to = Math.min(at?.to ?? from, max);
  view.dispatch({
    changes: { from, to: Math.max(from, to), insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

/** Creates `folder/title.md` from a template and opens it; the path or null. */
export async function createNoteFromTemplate(templatePath: string, folder: string, title: string): Promise<string | null> {
  const name = title.replace(/\.md$/i, "");
  const path = `${folder ? `${folder}/` : ""}${name}.md`;
  const text = (await expandTemplate(templatePath, name)) ?? `# ${name}\n\n`;
  return vault.openOrCreateFile(path, text, { newTab: !!vault.openPath });
}
