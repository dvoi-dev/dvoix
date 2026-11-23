import { FolderPlus, PanelTop, Pencil, Trash2 } from "@lucide/svelte";
import type { VaultEntry } from "../../api";
import { folderOf } from "../../attachments";
import { creatableFileTypes } from "../../filetypes";
import { plugins } from "../../plugins/manager.svelte";
import type { FileMenuContext } from "../../plugins/types";
import { ui } from "../../ui.svelte";
import { vault } from "../../vault.svelte";
import type { MenuEntry } from "../../components/contextMenuState.svelte";

/** "New note", "New canvas", ..., "New folder" inside `folder` ("" = vault root). */
export function createItems(folder: string): MenuEntry[] {
  return [
    ...creatableFileTypes().map((type) => ({
      label: `Create ${type.label}`,
      icon: type.icon,
      action: () => void vault.createFile(type, folder),
    })),
    { label: "Create folder", icon: FolderPlus, action: () => void newFolder(folder) },
  ];
}

export async function newFolder(parent: string) {
  const path = await vault.createFolder(parent);
  if (path) ui.renaming = path;
}

/** Right-click on the empty area of the explorer: create in the vault root. */
export function rootMenu(): MenuEntry[] {
  const extra = plugins.fileMenuItems({ entry: null, folder: "" });
  return [...createItems(""), ...(extra.length ? (["separator", ...extra] as MenuEntry[]) : [])];
}

export function entryMenu(entry: VaultEntry): MenuEntry[] {
  const ctx: FileMenuContext = { entry, folder: entry.isDir ? entry.path : folderOf(entry.path) };
  const extra = plugins.fileMenuItems(ctx);
  return [
    ...(entry.isDir
      ? createItems(entry.path)
      : [{ label: "Open in new tab", icon: PanelTop, action: () => void vault.openFile(entry.path, { newTab: true }) }]),
    ...(extra.length ? (["separator", ...extra] as MenuEntry[]) : []),
    "separator" as const,
    { label: "Rename", icon: Pencil, action: () => (ui.renaming = entry.path) },
    { label: "Delete", icon: Trash2, danger: true, action: () => void vault.trash(entry.path) },
  ];
}

export const DRAG_TYPE = "application/x-dvoix-path";
