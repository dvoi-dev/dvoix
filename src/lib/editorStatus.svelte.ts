// Live editor state shared by the status bar and editor commands. The active
// editor is kept while a search panel or toolbar has focus, so commands still
// know which document they belong to.
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

class EditorStatusStore {
  cursor = $state<{ line: number; col: number } | null>(null);
  selection = $state<{ words: number; chars: number } | null>(null);
  activeView = $state.raw<EditorView | null>(null);

  activate(view: EditorView) {
    this.activeView = view;
    this.report(view, view.state);
  }

  report(view: EditorView, state: EditorState) {
    if (this.activeView !== view) return;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const nextCursor = { line: line.number, col: head - line.from + 1 };
    if (this.cursor?.line !== nextCursor.line || this.cursor?.col !== nextCursor.col) this.cursor = nextCursor;
    const range = state.selection.main;
    if (range.empty) {
      this.selection = null;
      return;
    }
    const text = state.sliceDoc(range.from, range.to);
    const trimmed = text.trim();
    this.selection = { words: trimmed ? trimmed.split(/\s+/).length : 0, chars: text.length };
  }

  clear(view?: EditorView) {
    if (view && this.activeView !== view) return;
    this.activeView = null;
    this.cursor = null;
    this.selection = null;
  }
}

export const editorStatus = new EditorStatusStore();
