// State of the template picker overlay: which mode it is in and where a new
// note should be created. Only `index.ts` opens it; the component reads it.
import { editorStatus } from "../../../editorStatus.svelte";

export type PickerMode = "insert" | "create";

class PickerState {
  mode: PickerMode = "insert";
  /** Target folder for "create" ("" = vault root). */
  folder = "";
  /**
   * Cursor position of "insert", captured when the picker opens: focusing the
   * picker blurs the editor, which clears `editorStatus.activeView`.
   */
  selection: { from: number; to: number } | null = null;

  openInsert() {
    const range = editorStatus.activeView?.state.selection.main;
    this.selection = range ? { from: range.from, to: range.to } : null;
    this.mode = "insert";
  }

  openCreate(folder: string) {
    this.folder = folder;
    this.selection = null;
    this.mode = "create";
  }
}

export const pickerState = new PickerState();
