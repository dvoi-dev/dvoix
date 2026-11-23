<script lang="ts">
  // File explorer: the folder tree of the vault. Its buttons sit in the panel header (FileExplorerActions).
  import TreeItem from "./TreeItem.svelte";
  import { buildTree, mergeEntries } from "./tree";
  import { treeFocus } from "./treeFocus.svelte";
  import { contextMenu } from "../../components/contextMenuState.svelte";
  import { DRAG_TYPE, rootMenu } from "./fileMenu";
  import { vault } from "../../vault.svelte";
  import { ui } from "../../ui.svelte";
  import { plugins } from "../../plugins/manager.svelte";

  // Other plugins can add entries only the explorer shows (hidden folders).
  // The tree follows the list of the vault, which is only replaced when the
  // shape of the vault changes: a file that was only written stays as it is.
  const tree = $derived.by(() => {
    void vault.changes.structure.number;
    return buildTree(mergeEntries(vault.entries, plugins.explorerEntries));
  });
  let rootDrop = $state(false);
  let container: HTMLDivElement | undefined = $state();

  // The first root row is the tab stop until the keyboard picks another one.
  $effect(() => {
    treeFocus.first = tree[0]?.entry.path ?? null;
  });

  // A focused row that disappeared (collapsed folder, deleted file) must not
  // leave the tree without a tab stop.
  $effect(() => {
    void tree;
    for (const path of ui.expanded) void path;
    if (treeFocus.path && container && !container.querySelector(`[data-tree-path="${CSS.escape(treeFocus.path)}"]`)) {
      treeFocus.path = null;
    }
  });

  /** The visible rows, in the order they are drawn (collapsed folders draw no children). */
  function rows(): HTMLElement[] {
    return container ? [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')] : [];
  }

  /** Tree keyboard navigation: arrows move, Left/Right collapse/expand, Enter opens, F2 renames. */
  function keydown(e: KeyboardEvent) {
    if (ui.renaming) return; // the rename input handles its own keys
    const all = rows();
    if (!all.length) return;
    const current = all.findIndex((row) => row.dataset.treePath === treeFocus.path);
    const index = current >= 0 ? current : 0;
    const row = all[index];
    const path = row.dataset.treePath!;
    const isDir = row.dataset.treeDir === "true";
    const expanded = ui.expanded.has(path);
    const focusRow = (el: HTMLElement | undefined) => {
      if (el?.dataset.treePath) treeFocus.focus(el.dataset.treePath);
    };
    switch (e.key) {
      case "ArrowDown":
        focusRow(all[index + 1] ?? row);
        break;
      case "ArrowUp":
        focusRow(all[index - 1] ?? row);
        break;
      case "Home":
        focusRow(all[0]);
        break;
      case "End":
        focusRow(all[all.length - 1]);
        break;
      case "ArrowRight":
        if (isDir && !expanded) ui.toggleFolder(path);
        else if (isDir) {
          const next = all[index + 1];
          if (next && Number(next.dataset.treeDepth) > Number(row.dataset.treeDepth)) focusRow(next);
        } else return;
        break;
      case "ArrowLeft":
        if (isDir && expanded) ui.toggleFolder(path);
        else {
          const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
          const parentRow = parent ? all.find((r) => r.dataset.treePath === parent) : undefined;
          if (!parentRow) return;
          focusRow(parentRow);
        }
        break;
      case "Enter":
      case " ":
        if (isDir) ui.toggleFolder(path);
        else void vault.openFile(path, { newTab: e.ctrlKey || e.metaKey });
        break;
      case "F2":
        ui.renaming = path;
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  /** Clicking a row (or its button) makes it the tab stop without stealing focus. */
  function focusin(e: FocusEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-tree-path]");
    if (row?.dataset.treePath && row.dataset.treePath !== treeFocus.path) treeFocus.path = row.dataset.treePath;
  }
</script>

<div
  bind:this={container}
  class="flex-1 overflow-y-auto px-1.5 py-1.5 {rootDrop ? 'bg-violet-500/5' : ''}"
  role="tree"
  tabindex="-1"
  aria-label="Files"
  onkeydown={keydown}
  onfocusin={focusin}
  oncontextmenu={(e) => contextMenu.show(e, rootMenu())}
  ondragover={(e) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    rootDrop = true;
  }}
  ondragleave={() => (rootDrop = false)}
  ondrop={(e) => {
    rootDrop = false;
    const from = e.dataTransfer?.getData(DRAG_TYPE);
    if (from) void vault.move(from, "");
  }}
>
  {#each tree as node (node.entry.path)}
    <TreeItem {node} />
  {:else}
    <p class="px-3 py-4 text-xs leading-relaxed text-zinc-500">
      The vault is still empty. Right-click or use the buttons above to create something.
    </p>
  {/each}
</div>
