// Bookmarked notes and folders of the vault, stored in `.dvoix/bookmarks.json`
// (not in the plugin's data.json: the list belongs to the vault and stays
// useful even when the plugin is off). Unknown item types and fields survive
// loading and saving, so newer versions can add kinds without losing data.
import { readJsonRaw, writeJson } from "../../../config";

export interface BookmarkItem {
  type: "file" | "folder";
  /** Vault-relative path. */
  path: string;
  /** Optional display name; the file name is shown when it is missing. */
  title?: string;
}

const FILE = "bookmarks.json";

/** Same path ignoring case: one bookmark per target, like the vault's file system. */
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

class BookmarksStore {
  /** Items in display order; unknown types are kept but not rendered. */
  items = $state.raw<BookmarkItem[]>([]);
  /** Raw items of unknown kinds, kept for the next save. */
  private unknown = $state.raw<Record<string, unknown>[]>([]);
  /** Other top-level fields of the file, kept for the next save. */
  private extra: Record<string, unknown> = {};
  private loaded = false;

  /** Reads the list of the vault that was just opened. */
  async load(): Promise<void> {
    this.loaded = false;
    this.items = [];
    this.unknown = [];
    this.extra = {};
    const raw = await readJsonRaw(FILE);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const { items, ...rest } = raw as { items?: unknown; [key: string]: unknown };
      this.extra = rest;
      const known: BookmarkItem[] = [];
      const unknown: Record<string, unknown>[] = [];
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, unknown>;
        if ((it.type === "file" || it.type === "folder") && typeof it.path === "string" && it.path) {
          const { type, path, title, ...more } = it;
          known.push({ ...more, type: it.type, path: it.path, ...(typeof title === "string" ? { title } : {}) });
        } else unknown.push(it);
      }
      this.items = known;
      this.unknown = unknown;
    }
    this.loaded = true;
  }

  reset() {
    this.loaded = false;
    this.items = [];
    this.unknown = [];
    this.extra = {};
  }

  isBookmarked(path: string): boolean {
    return this.items.some((i) => samePath(i.path, path));
  }

  /** Adds a bookmark, or removes it when the path is already bookmarked. */
  toggle(type: BookmarkItem["type"], path: string): void {
    if (this.isBookmarked(path)) this.remove(path);
    else this.items = [...this.items, { type, path }];
    this.save();
  }

  remove(path: string): void {
    this.items = this.items.filter((i) => !samePath(i.path, path));
    this.save();
  }

  /** Drag & drop in the panel: moves the item at `from` to index `to`. */
  move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) return;
    const next = [...this.items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    this.items = next;
    this.save();
  }

  /**
   * Follows an in-app rename or move: the exact path and, for folders, every
   * path below it. External renames arrive through the watcher instead; those
   * bookmarks show as missing until the user removes them.
   */
  remap(from: string, to: string, isDir: boolean): void {
    const prefix = `${from}/`;
    let changed = false;
    const next = this.items.map((item) => {
      if (samePath(item.path, from)) {
        changed = true;
        return { ...item, path: to };
      }
      if (isDir && item.path.toLowerCase().startsWith(prefix.toLowerCase())) {
        changed = true;
        return { ...item, path: to + item.path.slice(from.length) };
      }
      return item;
    });
    if (!changed) return;
    this.items = next;
    this.save();
  }

  private save(): void {
    if (!this.loaded) return;
    writeJson(FILE, { ...this.extra, items: [...this.items, ...this.unknown] });
  }
}

export const bookmarks = new BookmarksStore();
