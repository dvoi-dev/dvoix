// App state for the open vault and the open file, shared by all components.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { untrack } from "svelte";
import {
  api,
  onVaultChanged,
  type NoteAliases,
  type UpdatedLinkFile,
  type VaultChange,
  type VaultEntry,
  type VaultInfo,
} from "./api";
import { appEvents } from "./events";
import { creatableFileTypes, type FileType } from "./filetypes";
import { flushConfig } from "./config";
import { plugins } from "./plugins/manager.svelte";
import { pluginStore } from "./plugins/store/store.svelte";
import { settings } from "./settings.svelte";
import { snippets } from "./snippets.svelte";
import { toasts } from "./toast.svelte";
import { ui } from "./ui.svelte";

const SAVE_DELAY_MS = 400;
const RECENT_MAX = 50;
/** How long a self-written file's watcher echo is recognized as our own write. */
const ECHO_WINDOW_MS = 5000;
/** How many writes are remembered for the echo check (a burst stays covered). */
const ECHO_MAX = 16;

/**
 * An editor tab. `path` is null for an empty tab ("New tab") and for a tab
 * that shows a view of a plugin (e.g. the graph); then `view` is its id.
 */
export interface Tab {
  id: number;
  path: string | null;
  view?: string;
  pinned?: boolean;
}

export type PaneSide = "left" | "right";

/** The two tabs shown side by side. Both stay in the same tab list. */
export interface SplitView {
  left: number;
  right: number;
}

export type SaveState = "saved" | "pending" | "saving" | "error" | "conflict";

/**
 * An external change that collided with unsaved edits. Autosave is stopped
 * until the user resolves it (keep mine, take theirs, or merge); nothing is
 * written or discarded silently. `diskContent`/`diskEntry` are null when the
 * file was deleted on disk.
 */
export interface FileConflict {
  kind: "modified" | "removed";
  diskContent: string | null;
  diskEntry: VaultEntry | null;
}

/** One in-memory document per path, shared by every pane and tab showing it. */
interface FileBuffer {
  content: string;
  dirty: boolean;
  saveState: SaveState;
  revision: number;
  /** Disk state the content was last read from or saved at; the base of the next checked write. */
  baseModified: number | null;
  baseSize: number | null;
  conflict: FileConflict | null;
}

const newBuffer = (content: string, base?: VaultEntry | null): FileBuffer => ({
  content,
  dirty: false,
  saveState: "saved",
  revision: 0,
  baseModified: base?.modified ?? null,
  baseSize: base?.size ?? null,
  conflict: null,
});

/** What `read` returns: the text and, for a fresh disk read, its disk state. */
interface ReadResult {
  content: string;
  entry: VaultEntry | null;
}

export interface OpenOptions {
  /** Open in a new tab instead of replacing the active tab's file. */
  newTab?: boolean;
}

export interface HistoryEntry {
  path: string | null;
  view?: string;
}

/** How a view tab is stored in `workspace.json`; `//` never occurs in a vault path. */
const VIEW_PREFIX = "dvoix://view/";
const HISTORY_MAX = 100;

/**
 * A group of changes in the vault. The number moves once per batch of
 * changes from the watcher, so a panel that reads it refreshes only when it
 * has to.
 */
export interface ChangeGroup {
  /** Moves with every batch of changes of this group. */
  number: number;
  /**
   * Every distinct path of the last batch of this group, replaced wholesale
   * with every batch. A batch can name many files, so a view that follows one
   * file (e.g. the docked note) has to check its path against this list: one
   * path alone would miss the note that was not last in the batch.
   */
  paths: string[];
}

/** One path of a batch of changes on disk and what happened to it. */
export interface VaultChangeKind {
  path: string;
  kind: VaultChange["kind"];
}

/** True for a note: only notes are indexed, so only they change the panels of notes. */
function isNote(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

let nextTabId = 1;
const newTabObj = (path: string | null, view?: string): Tab => ({ id: nextTabId++, path, view });

class VaultStore {
  info = $state<VaultInfo | null>(null);
  entries = $state<VaultEntry[]>([]);
  tabs = $state<Tab[]>([]);
  activeTabId = $state(0);
  split = $state<SplitView | null>(null);
  focusedPane = $state<PaneSide>("left");
  /** Recently opened files, newest first. */
  recent = $state<string[]>([]);
  error = $state<string | null>(null);
  private buffers = $state<Record<string, FileBuffer>>({});
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private writeJobs = new Map<string, Promise<void>>();
  private closingTabs = new Set<number>();
  /** Invalidates pending tab reads when the user navigates somewhere else. */
  private navigationId = 0;
  private navHistory = $state<HistoryEntry[]>([]);
  private navIndex = $state(-1);
  private navigatingHistory = false;

  /** Path of the file shown in the active tab (null for an empty tab). */
  get openPath(): string | null {
    return this.activeTab?.path ?? null;
  }

  /** Id of the view shown in the active tab instead of a file, if any. */
  get openView(): string | null {
    return this.activeTab?.view ?? null;
  }

  get content(): string {
    return this.contentFor(this.openPath);
  }

  get dirty(): boolean {
    return !!this.openPath && !!this.buffers[this.openPath]?.dirty;
  }

  get saveState(): SaveState {
    return this.saveStateFor(this.openPath);
  }

  contentFor(path: string | null): string {
    return path ? (this.buffers[path]?.content ?? "") : "";
  }

  /** The in-memory text of a buffered note, or undefined when it is not open. */
  bufferedContent(path: string): string | undefined {
    return this.buffers[path]?.content;
  }

  saveStateFor(path: string | null): SaveState {
    if (!path) return "saved";
    const buffer = this.buffers[path];
    if (!buffer) return "saved";
    return buffer.conflict ? "conflict" : buffer.saveState;
  }

  /** The external-change conflict of a path, while it is unresolved. */
  conflictFor(path: string | null): FileConflict | null {
    return path ? (this.buffers[path]?.conflict ?? null) : null;
  }

  get conflict(): FileConflict | null {
    return this.conflictFor(this.openPath);
  }

  get canGoBack(): boolean {
    return this.navIndex > 0;
  }

  get canGoForward(): boolean {
    return this.navIndex >= 0 && this.navIndex < this.navHistory.length - 1;
  }
  /**
   * What changed in the vault. Every group has a counter that moves only for
   * the changes that can change what it shows, so a panel refreshes only when
   * it has to: the panels of notes read `notes`, the panels of the repository
   * read `files`.
   */
  changes = $state<{ notes: ChangeGroup; structure: ChangeGroup; files: ChangeGroup }>({
    /** A note changed: its text, its tags, its tasks and its links. */
    notes: { number: 0, paths: [] },
    /** A file or folder was added, removed or moved: the tree of the vault changes. */
    structure: { number: 0, paths: [] },
    /** Any file changed. */
    files: { number: 0, paths: [] },
  });
  /** Moves when the list of the vault changes, so that caches know they are stale. */
  entriesVersion = $state(0);
  /** Moves whenever `.trash/` changes through in-app trash, restore, or delete operations. */
  trashVersion = $state(0);

  /** The files of the vault by their path, for the lookups of links and of changes. */
  private fileByPath = $derived.by(() => {
    const map = new Map<string, VaultEntry>();
    for (const entry of this.entries) if (!entry.isDir) map.set(entry.path.toLowerCase(), entry);
    return map;
  });

  /** The folders of the vault by their path, to recognize changes of folders. */
  private dirByPath = $derived.by(() => {
    const map = new Map<string, VaultEntry>();
    for (const entry of this.entries) if (entry.isDir) map.set(entry.path.toLowerCase(), entry);
    return map;
  });

  /** The files of the vault by their name, for the lookups of links. All
   * candidates per name: an ambiguous `[[name]]` is answered by path proximity. */
  private filesByName = $derived.by(() => {
    const map = new Map<string, VaultEntry[]>();
    for (const entry of this.entries) {
      if (entry.isDir) continue;
      const key = entry.name.toLowerCase();
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    }
    return map;
  });

  /** Frontmatter aliases per note, read from the index (a cache over the files). */
  private aliasRows = $state<NoteAliases[]>([]);
  /** Moves when the alias cache changes, so suggestion caches know they are stale. */
  aliasesVersion = $state(0);
  private aliasTimer: ReturnType<typeof setTimeout> | undefined;

  /** The aliases of a note by its path (lower-cased), as written. */
  private aliasesByPath = $derived.by(() => {
    const map = new Map<string, string[]>();
    for (const row of this.aliasRows) map.set(row.path.toLowerCase(), row.aliases);
    return map;
  });

  /** The notes that own an alias (lower-cased), for `[[Alias]]` resolution. */
  private entriesByAlias = $derived.by(() => {
    const map = new Map<string, VaultEntry[]>();
    for (const row of this.aliasRows) {
      const entry = this.fileByPath.get(row.path.toLowerCase());
      if (!entry) continue;
      for (const alias of row.aliases) {
        const key = alias.toLowerCase();
        const list = map.get(key);
        if (list) list.push(entry);
        else map.set(key, [entry]);
      }
    }
    return map;
  });

  /** The frontmatter aliases of a note, as written; empty when it has none. */
  aliasesFor(path: string): string[] {
    return this.aliasesByPath.get(path.toLowerCase()) ?? [];
  }

  /** Called with the paths of every batch of changes, for store plugins (`dvoix.vault.onChange`). */
  private changeListeners = new Set<(paths: string[], changes: VaultChangeKind[]) => void>();

  /**
   * Calls `fn` with the vault-relative paths of every batch of changes on
   * disk, and what happened to each; returns the unsubscribe.
   */
  onChanges(fn: (paths: string[], changes: VaultChangeKind[]) => void): () => void {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Our own recent writes, so their watcher echo does not read the file back. */
  private selfWrites: { path: string; size: number; modified: number; at: number }[] = [];
  private unlisten: (() => void) | undefined;
  private unlistenViews: (() => void) | undefined;
  private stopActiveWatch: (() => void) | undefined;
  /** What `active-file-change` last said, so it only fires on a real change. */
  private announced: { path: string | null; view: string | null } | null = null;
  private tearingDown = false;

  async init() {
    this.unlisten?.();
    this.unlistenViews?.();
    this.stopActiveWatch?.();
    // Every way the active file changes (switching tabs, opening a link,
    // renaming the open file, closing its tab) ends in `openPath`/`openView`,
    // so watching those two catches all of them, once per change.
    this.stopActiveWatch = $effect.root(() => {
      $effect(() => {
        if (!this.info || this.tearingDown) return;
        const next = { path: this.openPath, view: this.openView };
        untrack(() => {
          if (this.announced && next.path === this.announced.path && next.view === this.announced.view) return;
          this.announced = next;
          appEvents.emit("active-file-change", next);
        });
      });
    });
    this.unlistenViews = plugins.onViewRemoved((id) => {
      // When the whole vault closes, its tabs are dropped anyway (and saved before).
      if (!this.tearingDown) void this.closeTabsWhere((t) => t.view === id);
    });
    this.unlisten = await onVaultChanged((changes) => this.onVaultEvent(changes));
    const last = await api.lastVault();
    if (last) await this.open(last).catch(() => undefined);
  }

  async pick() {
    const selected = await openDialog({ directory: true, title: "Choose vault folder" });
    if (typeof selected === "string") await this.open(selected);
  }

  async open(path: string) {
    try {
      await this.teardown();
      const info = await api.openVault(path);
      // Settings, workspace and plugins of this vault, all from `<vault>/.dvoix/`.
      await Promise.all([settings.load(), ui.load(info.path), this.refresh()]);
      await snippets.refresh();
      this.tabs = [];
      this.activeTabId = 0;
      this.split = null;
      this.focusedPane = "left";
      this.buffers = {};
      this.error = null;
      await plugins.loadVault();
      await pluginStore.loadVault();
      this.info = info;
      await this.restoreTabs();
    } catch (e) {
      this.error = String(e);
      throw e;
    }
  }

  async close() {
    await this.teardown();
    await api.closeVault();
  }

  /** Saves everything of the open vault and unloads its plugins. */
  private async teardown() {
    this.navigationId++;
    if (!this.info) return;
    this.selfWrites = [];
    await this.flush();
    if (Object.values(this.buffers).some((buffer) => buffer.conflict)) {
      this.error = "Some files changed on disk while you have unsaved edits. Resolve the conflicts before closing the vault.";
      throw new Error(this.error);
    }
    if (Object.values(this.buffers).some((buffer) => buffer.dirty)) {
      this.error = "Some files could not be saved. Retry saving before closing the vault.";
      throw new Error(this.error);
    }
    ui.unload(); // stop saving the workspace: unloading plugins (e.g. tabs) must not change it
    snippets.clear();
    toasts.clear();
    await flushConfig();
    this.tearingDown = true;
    try {
      await plugins.unloadVault();
      pluginStore.reset();
    } finally {
      this.tearingDown = false;
    }
    settings.reset();
    this.info = null;
    this.entries = [];
    this.aliasRows = [];
    this.aliasesVersion++;
    clearTimeout(this.aliasTimer);
    this.entriesVersion++;
    this.trashVersion++;
    this.tabs = [];
    this.activeTabId = 0;
    this.split = null;
    this.focusedPane = "left";
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.writeJobs.clear();
    this.buffers = {};
    this.recent = [];
    this.navHistory = [];
    this.navIndex = -1;
    this.closingTabs.clear();
  }

  async refresh(changed: string[] = []) {
    const [entries, aliasRows] = await Promise.all([api.listEntries(), api.aliases()]);
    this.entries = entries;
    this.aliasRows = aliasRows;
    this.aliasesVersion++;
    this.entriesVersion++;
    // The list of the vault was replaced, so the tree of the vault changed.
    this.note(this.changes.structure, changed);
  }

  /**
   * Reads the aliases again shortly after notes changed: their frontmatter
   * (and with it their aliases) can change on every save, but the entry list
   * does not, so this is lighter than a full refresh.
   */
  private scheduleAliasRefresh() {
    clearTimeout(this.aliasTimer);
    const navigation = this.navigationId;
    this.aliasTimer = setTimeout(() => {
      void api
        .aliases()
        .then((rows) => {
          if (this.navigationId === navigation && this.info) {
            this.aliasRows = rows;
            this.aliasesVersion++;
          }
        })
        .catch(() => undefined);
    }, 150);
  }

  /**
   * A change the app made itself (create, move, trash): the entry list is
   * already right, so the panels are told right away and do not wait for
   * the watcher. The list is read again shortly after anyway: on file systems
   * without watcher events that is the only refresh there is, and it also
   * corrects sizes and times a rename keeps from the old entry.
   */
  private appliedOwnChange(paths: string[], notes: boolean) {
    this.entriesVersion++;
    this.note(this.changes.structure, paths);
    this.note(this.changes.files, paths);
    // A folder can hold notes: its own operation changes the panels of notes
    // too, although no single note path was named.
    if (notes) this.note(this.changes.notes, paths);
    this.scheduleRefresh(paths);
  }

  /**
   * Puts a new entry into the list right after the app created it, so the
   * next name generation, the rename row and the tree see it without waiting
   * for the watcher. Inserted where the list's order (by path) puts it; a
   * foreign order is kept and the entry is appended.
   */
  private insertEntry(entry: VaultEntry) {
    if (this.entryIndex(entry.path) >= 0) return;
    let i = this.entries.length;
    const key = entry.path.toLowerCase();
    if (this.entries.every((e, n) => n === 0 || this.entries[n - 1].path.toLowerCase() <= e.path.toLowerCase())) {
      i = this.entries.findIndex((e) => e.path.toLowerCase() > key);
      if (i < 0) i = this.entries.length;
    }
    this.entries.splice(i, 0, entry);
  }

  /** The place of a path in the list, by path ignoring case; -1 when absent. */
  private entryIndex(path: string): number {
    const key = path.toLowerCase();
    return this.entries.findIndex((e) => e.path.toLowerCase() === key);
  }

  /** Drops a path and everything inside it (a folder) from the list. */
  private removeEntries(path: string) {
    this.entries = this.entries.filter((e) => e.path !== path && !e.path.startsWith(`${path}/`));
  }

  private scheduleRefresh(changed: string[] = []) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(changed), 150);
  }

  /** One batch from the watcher: vanished tabs right away, the rest handed to the panels together. */
  private onVaultEvent(changes: VaultChange[]) {
    // Hidden files are not part of `entries` (only the hidden-files plugin lists them).
    const visible = changes.filter((c) => !c.hidden);
    if (visible.length) this.applyChanges(visible);
    for (const change of changes) {
      if (change.kind === "removed") void this.closeIfGone(change.path);
      else {
        // "created" on an open buffer means the file was recreated externally
        // (atomic replace, sync tool): same flow as a modification.
        const buffer = this.buffers[change.path];
        if (!buffer || this.isSelfWrite(change)) continue;
        // Unsaved edits must never be overwritten or reloaded away: stop
        // autosave and let the user decide (keep, take, merge).
        if (buffer.dirty || buffer.conflict) void this.markConflict(change.path, "modified", change.entry ?? null);
        else void this.reloadBuffer(change.path);
      }
    }
  }

  /**
   * A batch of watcher changes (a sync tool, a git checkout, our own saves)
   * is handed to the panels as one refresh: every change group moves once
   * per batch instead of once per file, so the panels read the index once.
   */
  private applyChanges(changes: VaultChange[]) {
    // One list for the whole batch, not one per change that was not patched.
    let listAgain = false;
    const lastAdded: string[] = [];
    const notePaths: string[] = [];
    let patched = false;
    for (const change of changes) {
      // A folder can hold notes: when it comes, goes or is renamed, the panels
      // of notes change too, although the watcher names only the folder.
      if (isNote(change.path) || this.isFolder(change)) notePaths.push(change.path);
      if (change.kind === "modified" && this.patchEntry(change)) {
        patched = true;
        continue;
      }
      // A file was added or removed: the vault has to be listed again.
      listAgain = true;
      lastAdded.push(change.path);
    }
    // The size and time of an entry changed: caches that only look at paths
    // and names stay right, but a view of a file (e.g. an embedded image) must
    // see the new version.
    if (patched) this.entriesVersion++;
    this.note(this.changes.files, changes.map((c) => c.path));
    if (notePaths.length) {
      this.note(this.changes.notes, notePaths);
      this.scheduleAliasRefresh();
    }
    if (listAgain) this.scheduleRefresh(lastAdded);
    const paths = [...new Set(changes.map((c) => c.path))];
    const kinds = changes.map((c) => ({ path: c.path, kind: c.kind }));
    for (const fn of this.changeListeners) {
      // A broken plugin must not stop the app's own panels from updating.
      try {
        fn(paths, kinds);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * True when the change is the watcher's echo of a write the app made
   * itself. The text is already on screen; reading it back would replace
   * the editor's content for nothing on every save.
   */
  private isSelfWrite(change: VaultChange): boolean {
    const entry = change.entry;
    if (!entry) return false;
    const now = Date.now();
    this.selfWrites = this.selfWrites.filter((w) => now - w.at < ECHO_WINDOW_MS);
    return this.selfWrites.some((w) => w.path === entry.path && w.size === entry.size && w.modified === entry.modified);
  }

  /**
   * Writes the new size and time of a changed file into its entry, so the
   * list of the vault stays right without listing the whole vault again.
   * False when the file is not in the list, then the vault has to be listed.
   */
  private patchEntry(change: VaultChange): boolean {
    const entry = change.entry;
    if (!entry) return false;
    const found = this.fileByPath.get(entry.path.toLowerCase());
    if (!found) return false;
    found.size = entry.size;
    found.modified = entry.modified;
    // The entry stays the same object: the lookup maps built from the list
    // stay right without building them again, and the tree does not change.
    return true;
  }

  /** True when the change is about a folder, also one that is already gone. */
  private isFolder(change: VaultChange): boolean {
    if (change.entry) return change.entry.isDir;
    return this.dirByPath.has(change.path.toLowerCase());
  }

  /**
   * An entry the app just wrote, remembered for the echo check. Only writes
   * whose new text the editor already shows belong here (saves, moves); a
   * helper that changes a note behind the editor (ticking a task) must not
   * register its write, or the editor would keep the old text.
   */
  noteSelfWrite(entry: VaultEntry): void {
    this.selfWrites = [{ path: entry.path, size: entry.size, modified: entry.modified, at: Date.now() }, ...this.selfWrites].slice(
      0,
      ECHO_MAX,
    );
  }

  /**
   * An entry the app just wrote, made known right away: the watcher reports
   * it only a moment later, and the views that depend on its size and time
   * must not wait for that.
   */
  private noteWritten(entry: VaultEntry): void {
    this.noteSelfWrite(entry);
    const found = this.fileByPath.get(entry.path.toLowerCase());
    if (found) {
      found.size = entry.size;
      found.modified = entry.modified;
      this.entriesVersion++;
    }
  }

  /** Notes a change in a group: the counter moves and the batch is remembered. */
  private note(group: ChangeGroup, paths: string[]) {
    group.number++;
    group.paths = [...new Set(paths)];
  }

  // ---------------------------------------------------------------- tabs

  get activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  paneTab(side: PaneSide): Tab | undefined {
    if (!this.split) return side === "left" ? this.activeTab : undefined;
    return this.tabs.find((t) => t.id === this.split![side]);
  }

  focusPane(side: PaneSide) {
    if (!this.split) {
      this.focusedPane = "left";
      return;
    }
    const tab = this.paneTab(side);
    if (!tab) return;
    this.focusedPane = side;
    if (this.activeTabId !== tab.id) void this.activateTab(tab.id);
  }

  private visibleTabWithPath(path: string): Tab | undefined {
    if (this.split) {
      const left = this.paneTab("left");
      if (left?.path === path) return left;
      const right = this.paneTab("right");
      if (right?.path === path) return right;
    }
    return undefined;
  }

  private visibleTabWithView(view: string): Tab | undefined {
    if (this.split) {
      const left = this.paneTab("left");
      if (left?.view === view) return left;
      const right = this.paneTab("right");
      if (right?.view === view) return right;
    }
    return undefined;
  }

  private showInFocusedPane(id: number) {
    this.navigationId++;
    this.activeTabId = id;
    if (this.split) this.split = { ...this.split, [this.focusedPane]: id };
  }

  /** Flushes a tab before it is replaced; false when the edit must stay visible. */
  private async flushBeforeReplace(tab: Tab, request: number): Promise<boolean> {
    if (tab.path) await this.flush(tab.path);
    if (request !== this.navigationId || !this.tabs.includes(tab)) return false;
    return !(tab.path && this.buffers[tab.path]?.dirty);
  }

  /**
   * Opens a file. If it is already open in a tab, that tab is activated.
   * Otherwise it replaces the active unpinned tab, or gets a new tab with `newTab`.
   */
  async openFile(path: string, opts: OpenOptions = {}) {
    const existing = this.visibleTabWithPath(path) ?? this.tabs.find((t) => t.path === path);
    if (existing) return this.activateTab(existing.id);
    const request = ++this.navigationId;
    const read = await this.read(path);
    if (read === null || request !== this.navigationId) return;
    const active = this.activeTab;
    if (active && !opts.newTab && !active.pinned && !(await this.flushBeforeReplace(active, request))) return;
    const target = this.activeTab;
    if (target && !opts.newTab && !target.pinned) {
      const previous = target.path;
      target.path = path;
      target.view = undefined;
      this.pruneBuffer(previous);
    } else {
      const tab = newTabObj(path);
      this.tabs.splice(target ? this.tabs.indexOf(target) + 1 : this.tabs.length, 0, tab);
      this.showInFocusedPane(tab.id);
    }
    this.show(path, read.content, null, read.entry);
  }

  /**
   * Opens a view of a plugin (see `PluginContext.registerView`) in a tab, like a file:
   * activates its tab if it has one, else replaces the active tab or opens a new one.
   */
  async openViewTab(id: string, opts: OpenOptions = {}) {
    if (!plugins.view(id)) return;
    const existing = this.visibleTabWithView(id) ?? this.tabs.find((t) => t.view === id);
    if (existing) return this.activateTab(existing.id);
    const request = ++this.navigationId;
    const active = this.activeTab;
    if (active && !opts.newTab && !active.pinned && !(await this.flushBeforeReplace(active, request))) return;
    if (!plugins.view(id)) return;
    const target = this.activeTab;
    if (target && !opts.newTab && !target.pinned) {
      const previous = target.path;
      target.path = null;
      target.view = id;
      this.pruneBuffer(previous);
    } else {
      const tab = newTabObj(null, id);
      this.tabs.splice(target ? this.tabs.indexOf(target) + 1 : this.tabs.length, 0, tab);
      this.showInFocusedPane(tab.id);
    }
    this.show(null, "", id);
  }

  async activateTab(id: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const request = ++this.navigationId;
    const path = tab.path;
    let read: ReadResult | null = null;
    if (path) {
      const buffer = this.buffers[path];
      if (buffer) read = { content: buffer.content, entry: null };
      else {
        read = await this.read(path);
        if (request !== this.navigationId || !this.tabs.includes(tab) || tab.path !== path) return;
        if (read === null) {
          tab.path = null;
          this.pruneBuffer(path);
        }
      }
    }
    if (request !== this.navigationId || !this.tabs.includes(tab)) return;
    if (this.split) {
      if (id === this.split.left) this.focusedPane = "left";
      else if (id === this.split.right) this.focusedPane = "right";
      else this.split = { ...this.split, [this.focusedPane]: id };
    }
    this.activeTabId = id;
    if (tab.view) return this.show(null, "", tab.view);
    if (!tab.path) return this.show(null, "");
    return this.show(tab.path, read?.content ?? this.contentFor(tab.path), null, read?.entry ?? null);
  }

  /** Opens an empty tab next to the active one. */
  async newTab() {
    const active = this.activeTab;
    const tab = newTabObj(null);
    this.tabs.splice(active ? this.tabs.indexOf(active) + 1 : this.tabs.length, 0, tab);
    this.showInFocusedPane(tab.id);
    this.show(null, "");
  }

  async closeTab(id: number) {
    if (this.closingTabs.has(id)) return;
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.closingTabs.add(id);
    const request = ++this.navigationId;
    try {
      if (tab.path) await this.flush(tab.path);
      const index = this.tabs.findIndex((t) => t.id === id);
      if (index < 0 || request !== this.navigationId) return;
      const current = this.tabs[index];
      if (current.path && this.buffers[current.path]?.dirty) return;
      const splitSide = this.split ? (this.split.left === id ? "left" : this.split.right === id ? "right" : null) : null;
      const wasActive = id === this.activeTabId;
      this.tabs.splice(index, 1);
      this.pruneBuffer(current.path);
      if (splitSide && this.split) {
        const otherId = splitSide === "left" ? this.split.right : this.split.left;
        this.split = null;
        this.focusedPane = "left";
        const other = this.tabs.find((t) => t.id === otherId);
        if (other) await this.activateTab(other.id);
        else await this.newTab();
      } else if (wasActive) {
        const next = this.tabs[index] ?? this.tabs[index - 1];
        if (next) await this.activateTab(next.id);
        else await this.newTab();
      } else {
        this.saveTabs();
      }
    } finally {
      this.closingTabs.delete(id);
    }
  }

  async closeOtherTabs(id: number) {
    const target = this.tabs.find((t) => t.id === id);
    if (!target) return;
    await this.activateTab(id);
    const request = ++this.navigationId;
    const paths = [...new Set(this.tabs.filter((t) => t.id !== id && !t.pinned && t.path).map((t) => t.path!))];
    await Promise.all(paths.map((path) => this.flush(path)));
    if (request !== this.navigationId || !this.tabs.includes(target)) return;
    const keep = new Set(
      this.tabs.filter((t) => t.id === id || t.pinned || (t.path && this.buffers[t.path]?.dirty)).map((t) => t.id),
    );
    const removed = this.tabs.filter((t) => !keep.has(t.id));
    this.tabs = this.tabs.filter((t) => keep.has(t.id));
    for (const tab of removed) this.pruneBuffer(tab.path);
    if (this.split && (!keep.has(this.split.left) || !keep.has(this.split.right))) {
      this.split = null;
      this.focusedPane = "left";
    }
    this.saveTabs();
  }

  /** Activates the tab `delta` steps to the right (negative: left), wrapping around. */
  async cycleTab(delta: number) {
    const n = this.tabs.length;
    if (n < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeTabId);
    await this.activateTab(this.tabs[(((i + delta) % n) + n) % n].id);
  }

  /** Drag & drop in the tab bar: moves a tab to position `to`. */
  moveTab(id: number, to: number) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(to, this.tabs.length)), 0, tab);
    this.saveTabs();
  }

  togglePin(id = this.activeTabId) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || (!tab.path && !tab.view)) return;
    tab.pinned = !tab.pinned;
    this.saveTabs();
  }

  private async ensureTabBuffer(tab: Tab, request = this.navigationId): Promise<boolean> {
    const path = tab.path;
    if (!path || this.buffers[path]) return this.tabs.includes(tab);
    const read = await this.read(path);
    if (request !== this.navigationId || !this.tabs.includes(tab) || tab.path !== path) return false;
    if (read === null) {
      tab.path = null;
      this.pruneBuffer(path);
      return false;
    }
    if (!this.buffers[path]) this.buffers[path] = newBuffer(read.content, read.entry);
    return true;
  }

  /** Shows a tab on the right. Without a split, the target tab is kept on the left. */
  async splitRight(id = this.activeTabId) {
    const target = this.tabs.find((t) => t.id === id);
    if (!target) return;
    const request = ++this.navigationId;
    await this.ensureTabBuffer(target, request);
    if (request !== this.navigationId || !this.tabs.includes(target)) return;
    if (!this.split) {
      const copy = newTabObj(target.path, target.view);
      this.tabs.splice(this.tabs.indexOf(target) + 1, 0, copy);
      this.split = { left: target.id, right: copy.id };
      this.focusedPane = "right";
      this.activeTabId = copy.id;
      this.show(copy.path, this.contentFor(copy.path), copy.view ?? null);
      return;
    }
    if (id === this.split.right) {
      this.focusPane("right");
      return;
    }
    let rightId = id;
    if (id === this.split.left) {
      const copy = newTabObj(target.path, target.view);
      this.tabs.splice(this.tabs.indexOf(target) + 1, 0, copy);
      rightId = copy.id;
    }
    this.split = { ...this.split, right: rightId };
    this.focusedPane = "right";
    this.activeTabId = rightId;
    const right = this.tabs.find((t) => t.id === rightId)!;
    this.show(right.path, this.contentFor(right.path), right.view ?? null);
  }

  async closeSplit() {
    if (!this.split) return;
    this.navigationId++;
    const leftId = this.split.left;
    this.split = null;
    this.focusedPane = "left";
    const left = this.tabs.find((t) => t.id === leftId);
    if (left) await this.activateTab(left.id);
    else this.saveTabs();
  }

  /** Reads `path` from its shared buffer or from disk; null if that fails. */
  private async read(path: string): Promise<ReadResult | null> {
    const buffer = this.buffers[path];
    if (buffer) return { content: buffer.content, entry: null };
    try {
      const fresh = await api.readFileMeta(path);
      return { content: fresh.content, entry: fresh.entry };
    } catch (e) {
      this.error = String(e);
      return null;
    }
  }

  /** Makes `path` (or the view `view`) the content of the active tab. */
  private show(path: string | null, content: string, view: string | null = null, base: VaultEntry | null = null) {
    if (path && !this.buffers[path]) this.buffers[path] = newBuffer(content, base ?? this.entryAt(path));
    if (path) {
      this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, RECENT_MAX);
      ui.reveal(path);
    }
    if (!this.navigatingHistory && (path !== null || view !== null)) {
      const next: HistoryEntry = { path, view: view ?? undefined };
      const cur = this.navHistory[this.navIndex];
      if (!cur || cur.path !== next.path || cur.view !== next.view) {
        this.navHistory = [...this.navHistory.slice(0, this.navIndex + 1), next].slice(-HISTORY_MAX);
        this.navIndex = this.navHistory.length - 1;
      }
    }
    this.saveTabs();
  }

  /** Navigates back in the file/view history of this vault session. */
  async goBack() {
    await this.navigateHistory(-1);
  }

  /** Navigates forward in the file/view history of this vault session. */
  async goForward() {
    await this.navigateHistory(1);
  }

  private async navigateHistory(delta: -1 | 1) {
    let idx = this.navIndex + delta;
    while (idx >= 0 && idx < this.navHistory.length) {
      const entry = this.navHistory[idx];
      if (entry.view && plugins.view(entry.view)) {
        this.navIndex = idx;
        this.navigatingHistory = true;
        try {
          await this.openViewTab(entry.view);
        } finally {
          this.navigatingHistory = false;
        }
        return;
      }
      if (entry.path && this.entryAt(entry.path)) {
        this.navIndex = idx;
        this.navigatingHistory = true;
        try {
          await this.openFile(entry.path);
        } finally {
          this.navigatingHistory = false;
        }
        return;
      }
      idx += delta;
    }
  }

  private saveTabs() {
    const pinned = this.tabs.flatMap((tab, index) => (tab.pinned ? [index] : []));
    const split = this.split
      ? {
          left: this.tabs.findIndex((tab) => tab.id === this.split!.left),
          right: this.tabs.findIndex((tab) => tab.id === this.split!.right),
        }
      : null;
    ui.saveTabs({
      paths: this.tabs.map((t) => (t.view ? VIEW_PREFIX + t.view : (t.path ?? ""))),
      active: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeTabId)),
      recent: this.recent,
      pinned,
      split: split && split.left >= 0 && split.right >= 0 && split.left !== split.right ? split : null,
    });
  }

  /** Reopens the tabs the vault had when the app was last closed. */
  private async restoreTabs() {
    const request = ++this.navigationId;
    const saved = ui.savedTabs();
    const files = new Set(this.entries.filter((e) => !e.isDir).map((e) => e.path));
    const view = (p: string) => (p.startsWith(VIEW_PREFIX) ? p.slice(VIEW_PREFIX.length) : undefined);
    // Views only come back if their plugin is still on.
    const keep = (p: string) => !p || files.has(p) || !!plugins.view(view(p) ?? "");
    const paths = saved?.paths ?? [];
    this.recent = (saved?.recent ?? []).filter((p) => files.has(p));
    this.split = null;
    this.focusedPane = "left";
    const indexMap: number[] = [];
    this.tabs = [];
    paths.forEach((path, original) => {
      if (!keep(path)) return;
      indexMap[original] = this.tabs.length;
      this.tabs.push(view(path) ? newTabObj(null, view(path)) : newTabObj(path || null));
    });
    if (!this.tabs.length) this.tabs = [newTabObj(null)];
    for (const original of saved?.pinned ?? []) {
      const index = indexMap[original];
      if (index !== undefined) this.tabs[index].pinned = true;
    }
    // The previously active tab, or the closest one left of it if its file is gone.
    const before = paths.slice(0, (saved?.active ?? 0) + 1).filter(keep).length;
    let tab = this.tabs[Math.max(0, before - 1)];
    if (saved?.split) {
      const left = indexMap[saved.split.left];
      const right = indexMap[saved.split.right];
      if (left !== undefined && right !== undefined && left !== right) {
        const leftReady = await this.ensureTabBuffer(this.tabs[left], request);
        const rightReady = await this.ensureTabBuffer(this.tabs[right], request);
        if (request !== this.navigationId) return;
        if (leftReady && rightReady) {
          this.split = { left: this.tabs[left].id, right: this.tabs[right].id };
          const active = indexMap[saved.active ?? 0];
          if (active === right) {
            tab = this.tabs[right];
            this.focusedPane = "right";
          } else {
            tab = this.tabs[left];
          }
        } else {
          tab = leftReady ? this.tabs[left] : rightReady ? this.tabs[right] : this.tabs[0];
        }
      }
    }
    if (request !== this.navigationId) return;
    this.activeTabId = 0;
    await this.activateTab(tab.id);
  }

  /** Closes the tabs whose file matches `gone` (deleted, or inside a deleted folder). */
  private async closeTabs(gone: (path: string) => boolean) {
    this.recent = this.recent.filter((p) => !gone(p));
    const kept: HistoryEntry[] = [];
    let newIndex = -1;
    for (let i = 0; i < this.navHistory.length; i++) {
      const h = this.navHistory[i];
      if (h.path && gone(h.path)) continue;
      const prev = kept[kept.length - 1];
      if (!prev || prev.path !== h.path || prev.view !== h.view) kept.push(h);
      if (i <= this.navIndex) newIndex = kept.length - 1;
    }
    this.navHistory = kept;
    this.navIndex = newIndex;
    await this.closeTabsWhere((t) => !!t.path && gone(t.path));
  }

  /** Closes the tabs matching `close`; the active one hands over to its neighbour. */
  private async closeTabsWhere(close: (tab: Tab) => boolean) {
    const matching = this.tabs.filter(close);
    if (!matching.length) return this.saveTabs();
    const active = this.activeTab;
    const activeGone = !!active && close(active);
    const i = active ? this.tabs.indexOf(active) : -1;
    const left = this.tabs.slice(0, i).reverse();
    const right = this.tabs.slice(i + 1);
    const splitSurvivor = this.split
      ? [this.paneTab("left"), this.paneTab("right")].find((tab) => tab && !close(tab))
      : undefined;
    const next = splitSurvivor ?? [...right, ...left].find((t) => !close(t));
    this.tabs = this.tabs.filter((t) => !close(t));
    await Promise.all(matching.map((tab) => (tab.path ? this.writeJobs.get(tab.path) : undefined)));
    for (const tab of matching) if (tab.path) this.discardBuffer(tab.path);
    if (this.split && (!this.tabs.some((t) => t.id === this.split!.left) || !this.tabs.some((t) => t.id === this.split!.right))) {
      this.split = null;
      this.focusedPane = "left";
    }
    if (!activeGone) return this.saveTabs();
    if (next) await this.activateTab(next.id);
    else {
      this.tabs = [];
      await this.newTab();
    }
  }

  /** A file was removed on disk: close its tabs if it is really gone (not just rewritten). */
  private async closeIfGone(path: string) {
    const gone = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
    if (!this.tabs.some((t) => !!t.path && gone(t.path)) && !Object.keys(this.buffers).some(gone)) return;
    const exists = await api.readFile(path).then(
      () => true,
      () => false,
    );
    if (exists) return;
    for (const buffered of Object.keys(this.buffers)) {
      if (!gone(buffered)) continue;
      const buffer = this.buffers[buffered];
      // Unsaved edits must survive an external deletion: the buffer stays
      // and the user decides (keep mine recreates the file, take theirs closes).
      if (buffer.dirty || buffer.conflict) void this.markConflict(buffered, "removed", null);
      else this.discardBuffer(buffered);
    }
    const unprotected = (p: string) => gone(p) && !this.buffers[p]?.dirty && !this.buffers[p]?.conflict;
    await this.closeTabs(unprotected);
  }

  // ---------------------------------------------------------------- files

  /** Opens a link target: a vault path (`folder/note.md`) or a wikilink name (`note`). */
  async openLink(target: string, opts: OpenOptions = {}) {
    const path = this.resolveLink(target);
    if (path) return this.openFile(path, opts);
    // Like Obsidian: following a link to a missing note creates it.
    const name = target.endsWith(".md") ? target : `${target}.md`;
    await this.createFileAt(name, `# ${target.split("/").pop()}\n\n`, opts);
  }

  resolveLink(target: string, fromPath: string | null = this.openPath): string | undefined {
    // Exact path, path without `.md`, file name, then frontmatter alias. When
    // several files share a name or alias, the one closest to `fromPath` wins
    // (most shared parent folders, then path order). The maps are built once
    // per change of the list, so this is a lookup and not a walk.
    const t = target.toLowerCase();
    const exact = this.fileByPath.get(t) ?? this.fileByPath.get(`${t}.md`);
    if (exact) return exact.path;
    const byName = this.filesByName.get(t) ?? this.filesByName.get(`${t}.md`);
    if (byName?.length) return this.closestTo(byName, fromPath).path;
    const byAlias = this.entriesByAlias.get(t);
    if (byAlias?.length) return this.closestTo(byAlias, fromPath).path;
    return undefined;
  }

  /** The candidate with the most parent folders shared with `fromPath`; ties go to path order. */
  private closestTo(candidates: VaultEntry[], fromPath: string | null): VaultEntry {
    const from = (fromPath ?? "").toLowerCase().split("/");
    let best = candidates[0];
    let bestShared = -1;
    for (const candidate of candidates) {
      const parts = candidate.path.toLowerCase().split("/");
      let shared = 0;
      while (shared < from.length - 1 && shared < parts.length - 1 && from[shared] === parts[shared]) shared++;
      const key = candidate.path.toLowerCase();
      if (shared > bestShared || (shared === bestShared && key < best.path.toLowerCase())) {
        best = candidate;
        bestShared = shared;
      }
    }
    return best;
  }

  /** The entry of a vault path, as a lookup instead of a walk over the list. */
  entryAt(path: string): VaultEntry | undefined {
    return this.fileByPath.get(path.toLowerCase());
  }

  /** Called by file-type views on every edit; saves shortly after typing stops. */
  update(content: string, path = this.openPath) {
    if (!path) return;
    let buffer = this.buffers[path];
    if (!buffer) {
      buffer = newBuffer(content, this.entryAt(path));
      this.buffers[path] = buffer;
    }
    if (content === buffer.content) return;
    buffer.content = content;
    buffer.dirty = true;
    buffer.saveState = "pending";
    buffer.revision++;
    this.scheduleSave(path);
  }

  private scheduleSave(path: string) {
    clearTimeout(this.saveTimers.get(path));
    this.saveTimers.delete(path);
    // An unresolved conflict stops autosave: only a resolution writes again.
    if (this.buffers[path]?.conflict) return;
    this.saveTimers.set(
      path,
      setTimeout(() => {
        this.saveTimers.delete(path);
        void this.flush(path);
      }, SAVE_DELAY_MS),
    );
  }

  /** Saves one buffer, or every pending buffer when no path is given. */
  async flush(path?: string | null): Promise<void> {
    if (path === undefined) {
      await Promise.all(Object.keys(this.buffers).map((buffered) => this.flush(buffered)));
      return;
    }
    if (!path) return;
    for (;;) {
      const timer = this.saveTimers.get(path);
      if (timer) {
        clearTimeout(timer);
        this.saveTimers.delete(path);
      }
      const buffer = this.buffers[path];
      if (!buffer?.dirty || buffer.conflict) return;
      const job = this.writeJobs.get(path);
      if (job) {
        await job;
        continue;
      }
      const revision = buffer.revision;
      const content = buffer.content;
      // The disk state of the last read or save: the backend refuses the
      // write when the file changed in between (optimistic locking).
      const expected =
        buffer.baseModified !== null && buffer.baseSize !== null
          ? { modified: buffer.baseModified, size: buffer.baseSize }
          : undefined;
      buffer.saveState = "saving";
      const task = (async () => {
        try {
          const entry = await api.writeFile(path, content, expected);
          // Remember our write, so its watcher echo does not read the file back.
          this.noteWritten(entry);
          appEvents.emit("file-save", { path });
          if (this.buffers[path] === buffer && buffer.revision === revision) {
            buffer.baseModified = entry.modified;
            buffer.baseSize = entry.size;
            // A conflict that appeared while the write ran stays unresolved:
            // the buffer must keep its protection until the user decides.
            if (!buffer.conflict) {
              buffer.dirty = false;
              buffer.saveState = "saved";
              this.pruneBuffer(path);
            }
          }
        } catch (e) {
          if (this.buffers[path] === buffer) {
            buffer.dirty = true;
            // The file changed on disk between read and write (the watcher
            // had not reported it yet): conflict flow instead of a save error.
            // String(e) of an Error adds the "Error: " prefix, so match inside.
            if (String(e).includes("The file changed on disk:")) {
              buffer.saveState = "conflict";
              await this.markConflict(path, "modified", null);
            } else {
              buffer.saveState = "error";
              this.error = `Saving failed: ${e}`;
            }
          } else {
            this.error = `Saving failed: ${e}`;
          }
        } finally {
          this.writeJobs.delete(path);
        }
      })();
      this.writeJobs.set(path, task);
      await task;
      if (this.buffers[path] !== buffer || buffer.revision === revision) return;
    }
  }

  private pruneBuffer(path: string | null) {
    if (!path || this.tabs.some((tab) => tab.path === path) || this.buffers[path]?.dirty) return;
    this.discardBuffer(path);
  }

  private hasDirty(match: (path: string) => boolean): boolean {
    return Object.entries(this.buffers).some(([path, buffer]) => buffer.dirty && match(path));
  }

  private discardBuffer(path: string) {
    clearTimeout(this.saveTimers.get(path));
    this.saveTimers.delete(path);
    delete this.buffers[path];
  }

  private async reloadBuffer(path: string) {
    const buffer = this.buffers[path];
    if (!buffer || buffer.dirty || buffer.conflict) return;
    const revision = buffer.revision;
    const fresh = await api.readFileMeta(path).catch(() => null);
    const current = this.buffers[path];
    if (fresh !== null && current === buffer && !current.dirty && !current.conflict && current.revision === revision) {
      current.baseModified = fresh.entry.modified;
      current.baseSize = fresh.entry.size;
      if (current.content !== fresh.content) {
        current.content = fresh.content;
        current.saveState = "saved";
      }
    }
  }

  /**
   * An external change collided with unsaved edits: stop autosave and keep
   * both versions until the user resolves it (keep mine, take theirs, merge).
   * For "modified" the current disk text is read; when it matches the buffer
   * exactly (e.g. a sync tool rewrote the same bytes), the new disk state is
   * adopted silently instead of bothering the user.
   */
  private async markConflict(path: string, kind: "modified" | "removed", entry: VaultEntry | null): Promise<void> {
    const buffer = this.buffers[path];
    if (!buffer) return;
    clearTimeout(this.saveTimers.get(path));
    this.saveTimers.delete(path);
    if (kind === "removed") {
      buffer.conflict = { kind: "removed", diskContent: null, diskEntry: null };
      return;
    }
    const fresh = await api.readFileMeta(path).catch(() => null);
    const current = this.buffers[path];
    if (current !== buffer) return;
    // The file vanished between the event and the read: it was deleted.
    if (!fresh) return this.markConflict(path, "removed", null);
    // A save finished while the disk was read: nothing to resolve anymore.
    if (!buffer.dirty && !buffer.conflict) return this.reloadBuffer(path);
    if (fresh.content === buffer.content) {
      buffer.baseModified = fresh.entry.modified;
      buffer.baseSize = fresh.entry.size;
      buffer.conflict = null;
      buffer.dirty = false;
      buffer.saveState = "saved";
      this.pruneBuffer(path);
      return;
    }
    // A later external edit refreshes the disk side of an open conflict.
    buffer.conflict = { kind: "modified", diskContent: fresh.content, diskEntry: fresh.entry ?? entry };
  }

  /**
   * Resolves a conflict by writing the local text over the disk version
   * ("Keep mine"). The write is checked against the disk state the conflict
   * was detected at, so yet another external edit raises a new conflict.
   * A file deleted on disk is recreated.
   */
  async resolveConflictKeepMine(path: string) {
    const buffer = this.buffers[path];
    if (!buffer?.conflict) return;
    await this.resolveConflictMerged(path, buffer.content);
  }

  /**
   * Resolves a conflict by taking the disk version ("Take theirs"): the
   * buffer shows the disk text, the local edits are deliberately dropped.
   * For a file deleted on disk the tab is closed and the buffer discarded.
   */
  async resolveConflictTakeTheirs(path: string) {
    const buffer = this.buffers[path];
    if (!buffer?.conflict) return;
    const conflict = buffer.conflict;
    if (conflict.kind === "removed") {
      this.discardBuffer(path);
      await this.closeTabs((p) => p === path);
      return;
    }
    buffer.content = conflict.diskContent ?? "";
    buffer.baseModified = conflict.diskEntry?.modified ?? null;
    buffer.baseSize = conflict.diskEntry?.size ?? null;
    buffer.dirty = false;
    buffer.saveState = "saved";
    buffer.conflict = null;
    buffer.revision++;
    this.pruneBuffer(path);
  }

  /**
   * Resolves a conflict with a merged text (from the compare dialog): the
   * merge becomes the buffer and is saved against the disk state of the
   * conflict, so a further external edit raises a new conflict instead of
   * being overwritten.
   */
  async resolveConflictMerged(path: string, merged: string) {
    const buffer = this.buffers[path];
    if (!buffer?.conflict) return;
    const conflict = buffer.conflict;
    buffer.conflict = null;
    buffer.content = merged;
    buffer.baseModified = conflict.diskEntry?.modified ?? null;
    buffer.baseSize = conflict.diskEntry?.size ?? null;
    buffer.dirty = true;
    buffer.saveState = "pending";
    buffer.revision++;
    await this.flush(path);
    // "Keep mine" on a deleted file recreated it: the tree gets its entry
    // back right away, without waiting for the watcher.
    if (conflict.kind === "removed" && !buffer.dirty && !buffer.conflict && !this.entryAt(path)) {
      const entry = this.entryFromBuffer(path, buffer);
      if (entry) {
        this.insertEntry(entry);
        this.appliedOwnChange([path], isNote(path));
        appEvents.emit("file-create", { path, isDir: false });
      }
    }
  }

  /** The disk state of a saved buffer as an entry, for a recreated file. */
  private entryFromBuffer(path: string, buffer: FileBuffer): VaultEntry | null {
    if (buffer.baseModified === null || buffer.baseSize === null) return null;
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      extension: name.includes(".") ? (name.split(".").pop() ?? "") : "",
      isDir: false,
      size: buffer.baseSize,
      modified: buffer.baseModified,
    };
  }

  /**
   * Writes `content` to `path` for a plugin (`dvoix.vault.write`), creating
   * the file if it does not exist yet.
   */
  async writePluginFile(path: string, content: string): Promise<void> {
    if (!this.entryAt(path)) {
      try {
        const entry = await api.createFile(path, content);
        if (!entry.path.split("/").some((p) => p.startsWith("."))) {
          this.insertEntry(entry);
          this.appliedOwnChange([entry.path], isNote(entry.path));
        }
        appEvents.emit("file-create", { path: entry.path, isDir: false });
        return;
      } catch (e) {
        if (!String(e).startsWith("path already exists:")) throw e;
      }
    }
    const entry = await api.writeFile(path, content);
    const found = this.fileByPath.get(entry.path.toLowerCase());
    if (found) {
      found.size = entry.size;
      found.modified = entry.modified;
      this.entriesVersion++;
    }
  }

  creatable(): FileType[] {
    return creatableFileTypes();
  }
  /** Creates "Untitled.ext" (or "Untitled 2.ext", ...) of a file type in `folder`. */
  async createFile(type: FileType, folder = "") {
    const ext = type.extensions[0];
    const prefix = folder ? `${folder}/` : "";
    const taken = new Set(this.entries.map((e) => e.path.toLowerCase()));
    let name = "Untitled";
    for (let n = 2; taken.has(`${prefix}${name}.${ext}`.toLowerCase()); n++) name = `Untitled ${n}`;
    // New files get their own tab, unless the active tab is empty anyway.
    await this.createFileAt(`${prefix}${name}.${ext}`, type.template?.(name) ?? "", { newTab: !!this.openPath });
  }

  private async createFileAt(path: string, content: string, opts: OpenOptions = {}) {
    try {
      await this.flush();
      const entry = await api.createFile(path, content);
      // The entry is known right away: a second "new note" must not compute
      // the same name again, and the tree works without watcher events.
      this.insertEntry(entry);
      this.appliedOwnChange([path], isNote(path));
      appEvents.emit("file-create", { path, isDir: false });
      await this.openFile(path, opts);
    } catch (e) {
      this.error = String(e);
    }
  }

  /**
   * Opens `path`, creating it with `content` when it does not exist yet
   * (daily notes, "new note from template"). Returns the opened path, or null
   * when something went wrong (then `error` says what). A file that appears
   * between the check and the create (double click, sync) is opened, not an error.
   */
  async openOrCreateFile(path: string, content: string, opts: OpenOptions = {}): Promise<string | null> {
    const existing = this.entryAt(path);
    if (existing && !existing.isDir) {
      await this.openFile(existing.path, opts);
      return existing.path;
    }
    try {
      await this.flush();
      const entry = await api.createFile(path, content);
      this.insertEntry(entry);
      this.appliedOwnChange([path], isNote(path));
      appEvents.emit("file-create", { path, isDir: false });
    } catch (e) {
      if (!String(e).startsWith("path already exists:")) {
        this.error = String(e);
        return null;
      }
      // Created between the check and the write: open what is there.
    }
    await this.openFile(path, opts);
    return this.entryAt(path)?.path ?? path;
  }

  async createFolder(parent = "") {
    const prefix = parent ? `${parent}/` : "";
    const taken = new Set(this.entries.map((e) => e.path.toLowerCase()));
    let name = "New folder";
    for (let n = 2; taken.has(`${prefix}${name}`.toLowerCase()); n++) name = `New folder ${n}`;
    try {
      const entry = await api.createFolder(`${prefix}${name}`);
      // The row exists right away, so the inline rename has something to edit.
      this.insertEntry(entry);
      this.appliedOwnChange([entry.path], true);
      appEvents.emit("file-create", { path: entry.path, isDir: true });
      if (parent) ui.reveal(`${prefix}${name}`);
      return `${prefix}${name}`;
    } catch (e) {
      this.error = String(e);
    }
  }

  async rename(from: string, newName: string) {
    const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
    if (!newName.trim()) return;
    await this.moveTo(from, `${parent}${newName.trim()}`, { verb: "rename" });
  }

  /** Moves a file or folder into another folder ("" = vault root), e.g. by drag & drop. */
  async move(from: string, folder: string) {
    const name = from.split("/").pop()!;
    if (folder === from || folder.startsWith(`${from}/`)) return; // not into itself
    const to = folder ? `${folder}/${name}` : name;
    if (to === from) return;
    await this.moveTo(from, to, { verb: "move" });
  }

  private async undoMove(from: string, to: string) {
    // The link-aware undo restores the notes the rename rewrote; a plain
    // move back is the fallback for a rename that predates the snapshots.
    const snapshots = this.renameSnapshots.get(to);
    if (!snapshots) {
      const ok = await this.moveTo(from, to, { undo: false });
      if (!ok && this.error) toasts.error(this.error);
      return;
    }
    try {
      this.renameSnapshots.delete(to);
      const result = await api.undoRenameWithLinks(from, to, snapshots);
      // The backend moved the entry back already; take the new paths into
      // the tree, the tabs and the buffers without moving anything again.
      this.applyMovedEntry(to, from, result.entry);
      await this.refresh();
      if (result.skipped.length) {
        toasts.error(
          `${result.skipped.length} note(s) changed since the rename and kept their text.`,
        );
      }
    } catch (e) {
      toasts.error(String(e));
    }
  }

  /** The notes `renameWithLinks` rewrote, by their new path, for the undo. */
  private renameSnapshots = new Map<string, UpdatedLinkFile[]>();

  private async moveTo(
    from: string,
    to: string,
    opts: { undo?: boolean; verb?: "move" | "rename"; snapshots?: boolean } = {},
  ): Promise<boolean> {
    if (to === from) return true;
    try {
      await this.flush();
      const affected = (path: string) => path === from || path.startsWith(`${from}/`);
      if (this.hasDirty(affected)) {
        this.error = "Some files could not be saved. Retry saving before moving them.";
        return false;
      }
      const result = await api.renameWithLinks(from, to);
      const entry = result.entry;
      if (opts.snapshots !== false && result.updatedFiles.length) {
        this.renameSnapshots.set(to, result.updatedFiles);
      }
      // The backend rewrote other notes on disk. An open, clean buffer of one
      // of them still holds the old text and would write it back on the next
      // save, so it is read again; a dirty one cannot be here (checked above).
      for (const updated of result.updatedFiles) {
        if (this.buffers[updated.entry.path]) void this.reloadBuffer(updated.entry.path);
      }
      this.applyMovedEntry(from, to, entry);
      if (opts.undo !== false) {
        const oldName = from.split("/").pop() ?? from;
        const newName = to.split("/").pop() ?? to;
        const destFolder = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
        const message =
          opts.verb === "rename"
            ? `Renamed "${oldName}" to "${newName}"`
            : `Moved "${oldName}" to ${destFolder ? `"${destFolder}"` : "vault root"}`;
        toasts.undo(message, () => this.undoMove(from, to));
      }
      return true;
    } catch (e) {
      this.error = String(e);
      return false;
    }
  }

  /**
   * Takes a rename the backend already performed into the client state:
   * entries, buffers, tabs, history, the tree and the own-change bookkeeping.
   */
  private applyMovedEntry(from: string, to: string, entry: VaultEntry) {
    const remap = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    // The entries move with the file right away: the tree, the link lookups
    // and the next name generation see the new paths without the watcher.
    const movedEntries = this.entries.filter((e) => e.path === from || e.path.startsWith(`${from}/`));
    const movedPaths = movedEntries.map((e) => e.path);
    // The entry of the moved path comes back from the command with its real
    // size and time; everything inside a moved folder keeps its metadata,
    // only its path changes.
    this.entries = this.entries.map((e) => {
      if (e.path === from) return { ...entry, path: to, name: to.split("/").pop()! };
      if (!e.path.startsWith(`${from}/`)) return e;
      const path = remap(e.path);
      return { ...e, path, name: path.split("/").pop()! };
    });
    // The moved file was written by us: its watcher echo must not read it
    // back over the editor.
    this.noteSelfWrite({ ...entry, path: to });
    ui.moved(from, to);
    for (const t of this.tabs) if (t.path) t.path = remap(t.path);
    const movedBuffers: Record<string, FileBuffer> = {};
    for (const [path, buffer] of Object.entries(this.buffers)) movedBuffers[remap(path)] = buffer;
    this.buffers = movedBuffers;
    for (const [path, buffer] of Object.entries(this.buffers)) if (buffer.dirty) this.scheduleSave(path);
    this.recent = this.recent.map(remap);
    this.navHistory = this.navHistory.map((h) => (h.path ? { ...h, path: remap(h.path) } : h));
    this.saveTabs();
    if (to.includes("/")) ui.reveal(to);
    this.appliedOwnChange(
      [...movedPaths, ...movedPaths.map(remap)],
      movedEntries.some((e) => e.isDir || isNote(e.path)),
    );
    appEvents.emit("file-rename", { from, to, isDir: entry.isDir });
  }

  async trash(path: string, opts: { undo?: boolean } = {}) {
    try {
      await this.flush();
      const wasActiveFile = this.openPath === path;
      const gone = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
      if (this.hasDirty(gone)) {
        this.error = "Some files could not be saved. Retry saving before deleting them.";
        return;
      }
      const trashed = await api.trashEntry(path);
      this.trashVersion++;
      // Don't let a pending save recreate the file after it was trashed.
      for (const buffered of Object.keys(this.buffers)) if (gone(buffered)) this.discardBuffer(buffered);
      // The entry goes right away; a new note may take its name again.
      const removed = this.entries.filter((e) => e.path === path || e.path.startsWith(`${path}/`));
      this.removeEntries(path);
      await this.closeTabs(gone);
      this.appliedOwnChange(
        removed.length ? removed.map((e) => e.path) : [path],
        removed.some((e) => e.isDir || isNote(e.path)),
      );
      appEvents.emit("file-delete", { path, isDir: removed.some((e) => e.path === path && e.isDir) });
      if (opts.undo !== false) {
        const label = path.split("/").pop() ?? path;
        toasts.undo(`Moved "${label}" to trash`, async () => {
          try {
            await this.restoreTrash(trashed.name, trashed.originalPath, { reopenIfFile: wasActiveFile });
          } catch (e) {
            toasts.error(String(e));
          }
        });
      }
    } catch (e) {
      this.error = String(e);
    }
  }

  async restoreTrash(
    trashName: string,
    target: string | null = null,
    opts: { renameOnConflict?: boolean; reopenIfFile?: boolean } = {},
  ): Promise<VaultEntry> {
    const entry = await api.restoreTrashEntry(trashName, target, opts.renameOnConflict ?? false);
    this.trashVersion++;
    await this.refresh([entry.path]);
    this.note(this.changes.files, [entry.path]);
    if (entry.isDir || isNote(entry.path)) this.note(this.changes.notes, [entry.path]);
    if (entry.path.includes("/")) ui.reveal(entry.path);
    if (opts.reopenIfFile && !entry.isDir) await this.openFile(entry.path);
    return entry;
  }

  async deleteTrashed(trashName: string) {
    await api.deleteTrashEntry(trashName);
    this.trashVersion++;
  }

  async emptyTrash() {
    await api.emptyTrash();
    this.trashVersion++;
  }
}

export const vault = new VaultStore();
