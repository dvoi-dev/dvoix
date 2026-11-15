// Which row of the file tree the keyboard is on. The tree has one tab stop
// (roving tabindex): Tab moves into the tree, the arrow keys move inside it.
class TreeFocus {
  /** The row the keyboard is on; null until one is picked. */
  path = $state<string | null>(null);
  /** The first root row: the tab stop as long as no row was picked. */
  first = $state<string | null>(null);
  /**
   * The row that still has to take the keyboard focus. It is cleared once the
   * row focused itself: a request that stayed around made the row grab the
   * focus again whenever it was redrawn (e.g. after every save), which pulled
   * the focus out of the editor while typing.
   */
  pending = $state<string | null>(null);

  /** Moves the keyboard focus to a row and makes it the tab stop. */
  focus(path: string) {
    this.path = path;
    this.pending = path;
  }

  /** Called by the row once it has focused itself. */
  done(path: string) {
    if (this.pending === path) this.pending = null;
  }
}

export const treeFocus = new TreeFocus();
