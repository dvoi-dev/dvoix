// Bookmarks: pin favorite notes and folders to a sidebar panel. Toggle via
// the right-click menu of the file explorer and the tab bar or the command
// palette. The list lives in `.dvoix/bookmarks.json` and follows in-app
// renames; externally renamed targets show as "Missing" until removed.
import { Bookmark, BookmarkMinus, BookmarkPlus } from "@lucide/svelte";
import { ui } from "../../../ui.svelte";
import { vault } from "../../../vault.svelte";
import type { Plugin } from "../../types";
import BookmarksPanel from "./BookmarksPanel.svelte";
import { bookmarks } from "./store.svelte";

export const bookmarksPlugin: Plugin = {
  manifest: {
    id: "bookmarks",
    name: "Bookmarks",
    description: "Pin favorite notes and folders to a panel in the sidebar.",
    version: "1.0.0",
  },
  icon: Bookmark,
  async onload(ctx) {
    await bookmarks.load();
    ctx.register(() => bookmarks.reset());
    ctx.addPanel({ id: "bookmarks", label: "Bookmarks", icon: Bookmark, component: BookmarksPanel, order: 15 });

    const toggleItem = (type: "file" | "folder", path: string) => ({
      label: bookmarks.isBookmarked(path) ? "Remove bookmark" : "Bookmark",
      icon: bookmarks.isBookmarked(path) ? BookmarkMinus : BookmarkPlus,
      action: () => bookmarks.toggle(type, path),
    });

    ctx.addFileMenu({
      id: "toggle",
      items: ({ entry }) => (entry ? [toggleItem(entry.isDir ? "folder" : "file", entry.path)] : []),
    });
    ctx.addTabMenu({
      id: "toggle",
      items: (tab) => (tab.path ? [toggleItem("file", tab.path)] : []),
    });
    ctx.addCommand({
      id: "toggle",
      name: "Bookmark active note",
      hotkeys: [{ mod: true, shift: true, key: "b" }],
      when: () => !!vault.openPath,
      run: () => {
        if (vault.openPath) bookmarks.toggle("file", vault.openPath);
      },
    });
    ctx.addCommand({
      id: "show",
      name: "Show bookmarks",
      run: () => ui.showPanel("bookmarks"),
    });

    // In-app renames and moves keep the bookmarks pointing at their target.
    ctx.on("file-rename", ({ from, to, isDir }) => bookmarks.remap(from, to, isDir));
  },
};
