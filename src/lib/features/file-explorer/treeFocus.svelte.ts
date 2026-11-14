// Which row of the file tree the keyboard is on. The tree has one tab stop
// (roving tabindex): Tab moves into the tree, the arrow keys move inside it.
class TreeFocus {
  /** The row the keyboard is on; null until one is picked. */
  path = $state<string | null>(null);
  /** The first root row: the tab stop as long as no row was picked. */
  first = $state<string | null>(null);
  /** Counts explicit focus requests, so a row focuses even when its path stays the same. */
  request = $state(0);

  /** Moves the keyboard focus to a row and makes it the tab stop. */
  focus(path: string) {
    this.path = path;
    this.request++;
  }
}

export const treeFocus = new TreeFocus();
