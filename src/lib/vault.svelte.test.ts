// Tests for the vault state: tabs, deferred saving, link resolution and the
// file operations. The Rust commands are mocked, so no Tauri window is needed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultChange, VaultEntry } from "./api";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./api", () => ({
  api: {
    lastVault: vi.fn(async () => null),
    openVault: vi.fn(),
    closeVault: vi.fn(),
    listEntries: vi.fn(async () => []),
    readFile: vi.fn(async () => ""),
    readFileMeta: vi.fn(),
    writeFile: vi.fn(),
    createFile: vi.fn(),
    createFolder: vi.fn(),
    renameEntry: vi.fn(),
    trashEntry: vi.fn(),
    readConfig: vi.fn(async () => null),
    writeConfig: vi.fn(async () => {}),
  },
  onVaultChanged: vi.fn(async () => () => {}),
}));
vi.mock("./filetypes", () => ({
  creatableFileTypes: () => [{ id: "markdown", label: "Note", extensions: ["md"] }],
}));
vi.mock("./plugins/manager.svelte", () => ({
  plugins: {
    loadVault: vi.fn(async () => {}),
    unloadVault: vi.fn(async () => {}),
    view: vi.fn(() => undefined),
    onViewRemoved: vi.fn(() => () => {}),
    explorerEntries: [],
  },
}));
vi.mock("./plugins/store/store.svelte", () => ({
  pluginStore: { loadVault: vi.fn(async () => {}), reset: vi.fn() },
}));
vi.mock("./settings.svelte", () => ({
  settings: { load: vi.fn(async () => {}), reset: vi.fn() },
}));

import { api } from "./api";
import { vault } from "./vault.svelte";

function entry(path: string, isDir = false): VaultEntry {
  const name = path.split("/").pop()!;
  return { path, name, extension: isDir || !name.includes(".") ? "" : name.split(".").pop()!, isDir, size: 10, modified: 1000 };
}

/** The private bookkeeping of the store, reset between tests. */
interface Privates {
  navHistory: unknown[];
  navIndex: number;
  selfWrites: unknown[];
  saveTimers: Map<string, ReturnType<typeof setTimeout>>;
  writeJobs: Map<string, Promise<void>>;
  refreshTimer?: ReturnType<typeof setTimeout>;
}

function reset() {
  const priv = vault as unknown as Privates;
  for (const timer of priv.saveTimers.values()) clearTimeout(timer);
  priv.saveTimers.clear();
  priv.writeJobs.clear();
  clearTimeout(priv.refreshTimer);
  priv.navHistory = [];
  priv.navIndex = -1;
  priv.selfWrites = [];
  vault.info = null;
  vault.entries = [];
  vault.tabs = [];
  vault.activeTabId = 0;
  vault.split = null;
  vault.focusedPane = "left";
  (vault as unknown as { buffers: Record<string, unknown> }).buffers = {};
  vault.error = null;
  vault.recent = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
  vi.useFakeTimers();
  vi.mocked(api.listEntries).mockImplementation(async () => [...vault.entries]);
  vi.mocked(api.readFile).mockImplementation(async (path) => `content of ${path}`);
  vi.mocked(api.readFileMeta).mockImplementation(async (path) => ({ content: `content of ${path}`, entry: entry(path) }));
  vi.mocked(api.writeFile).mockImplementation(async (path) => entry(path));
  vi.mocked(api.createFile).mockImplementation(async (path) => entry(path));
  vi.mocked(api.createFolder).mockImplementation(async (path) => entry(path, true));
  vi.mocked(api.renameEntry).mockImplementation(async (_from, to) => entry(to));
  vi.mocked(api.trashEntry).mockImplementation(async (path) => ({ name: path, originalPath: path }) as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tabs", () => {
  it("opens a file in the active tab and remembers it as recent", async () => {
    await vault.newTab();
    await vault.openFile("a.md");
    expect(vault.openPath).toBe("a.md");
    expect(vault.content).toBe("content of a.md");
    expect(vault.tabs).toHaveLength(1);
    expect(vault.recent[0]).toBe("a.md");
  });

  it("activates the tab of a file that is already open", async () => {
    await vault.newTab();
    await vault.openFile("a.md");
    await vault.openFile("b.md", { newTab: true });
    await vault.openFile("a.md");
    expect(vault.tabs).toHaveLength(2);
    expect(vault.activeTab?.path).toBe("a.md");
  });

  it("closing the active tab hands over to its neighbour", async () => {
    await vault.newTab();
    await vault.openFile("a.md");
    await vault.openFile("b.md", { newTab: true });
    await vault.openFile("c.md", { newTab: true });
    const [tabA, tabB, tabC] = vault.tabs;
    await vault.closeTab(tabC.id);
    expect(vault.openPath).toBe("b.md");
    await vault.closeTab(tabB.id);
    expect(vault.openPath).toBe("a.md");
    await vault.closeTab(tabA.id);
    expect(vault.tabs).toHaveLength(1);
    expect(vault.openPath).toBeNull();
  });

  it("cycles through the tabs with wrap-around", async () => {
    await vault.newTab();
    await vault.openFile("a.md");
    await vault.openFile("b.md", { newTab: true });
    await vault.openFile("c.md", { newTab: true });
    await vault.activateTab(vault.tabs[0].id);
    await vault.cycleTab(-1);
    expect(vault.openPath).toBe("c.md");
    await vault.cycleTab(1);
    expect(vault.openPath).toBe("a.md");
  });

  it("navigates back and forward through the history", async () => {
    vault.entries = [entry("a.md"), entry("b.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    await vault.openFile("b.md");
    expect(vault.canGoBack).toBe(true);
    await vault.goBack();
    expect(vault.openPath).toBe("a.md");
    expect(vault.canGoForward).toBe(true);
    await vault.goForward();
    expect(vault.openPath).toBe("b.md");
    expect(vault.canGoForward).toBe(false);
  });
});

describe("saving", () => {
  it("saves once after typing stops", async () => {
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("one");
    vault.update("two");
    expect(vault.dirty).toBe(true);
    expect(api.writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(api.writeFile).toHaveBeenCalledWith("a.md", "two", { modified: 1000, size: 10 });
    expect(vault.dirty).toBe(false);
  });

  it("ignores an update that changes nothing", async () => {
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update(vault.content);
    expect(vault.dirty).toBe(false);
  });

  it("flush saves right away and cancels the pending save", async () => {
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("changed");
    await vault.flush();
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the content dirty when saving fails", async () => {
    vi.mocked(api.writeFile).mockRejectedValueOnce(new Error("disk full"));
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("changed");
    await vi.advanceTimersByTimeAsync(400);
    expect(vault.dirty).toBe(true);
    expect(vault.error).toContain("Saving failed");
  });

  it("chains saves: each write expects the disk state of the previous one", async () => {
    vi.mocked(api.writeFile).mockImplementation(async (path) => ({ ...entry(path), size: 42, modified: 2000 }));
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("one");
    await vault.flush();
    expect(api.writeFile).toHaveBeenLastCalledWith("a.md", "one", { modified: 1000, size: 10 });
    vault.update("two");
    await vault.flush();
    expect(api.writeFile).toHaveBeenLastCalledWith("a.md", "two", { modified: 2000, size: 42 });
  });
});

describe("external change conflicts", () => {
  /** Delivers a watcher batch to the store, like `onVaultChanged` would. */
  function emit(changes: VaultChange[]) {
    (vault as unknown as { onVaultEvent(changes: VaultChange[]): void }).onVaultEvent(changes);
  }

  function change(kind: VaultChange["kind"], path: string, e?: VaultEntry): VaultChange {
    return { kind, path, hidden: false, entry: e };
  }

  /** Opens a.md with unsaved edits and an external modification on disk. */
  async function conflicted(diskContent = "their version", diskEntry = { ...entry("a.md"), size: 13, modified: 2000 }) {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("my edits");
    vi.mocked(api.readFileMeta).mockImplementation(async () => ({ content: diskContent, entry: diskEntry }));
    emit([change("modified", "a.md", diskEntry)]);
    await vi.advanceTimersByTimeAsync(0);
    return diskEntry;
  }

  it("an external edit on a dirty buffer stops autosave and raises a conflict", async () => {
    await conflicted();
    expect(vault.conflictFor("a.md")).toEqual({
      kind: "modified",
      diskContent: "their version",
      diskEntry: { ...entry("a.md"), size: 13, modified: 2000 },
    });
    expect(vault.saveStateFor("a.md")).toBe("conflict");
    expect(vault.content).toBe("my edits");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.writeFile).not.toHaveBeenCalled();
    // Typing during a conflict must not restart autosave either.
    vault.update("my edits, more");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it("an external edit on a clean buffer reloads without a conflict", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vi.mocked(api.readFileMeta).mockImplementation(async () => ({
      content: "fresh from disk",
      entry: { ...entry("a.md"), size: 15, modified: 2000 },
    }));
    emit([change("modified", "a.md", { ...entry("a.md"), size: 15, modified: 2000 })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.conflictFor("a.md")).toBeNull();
    expect(vault.content).toBe("fresh from disk");
  });

  it("identical disk content is adopted silently instead of raising a conflict", async () => {
    await conflicted("my edits", { ...entry("a.md"), size: 8, modified: 2000 });
    expect(vault.conflictFor("a.md")).toBeNull();
    expect(vault.dirty).toBe(false);
    // The next save is checked against the adopted disk state.
    vault.update("next");
    await vault.flush();
    expect(api.writeFile).toHaveBeenLastCalledWith("a.md", "next", { modified: 2000, size: 8 });
  });

  it("the echo of our own save never raises a conflict", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("saved text");
    await vault.flush();
    vault.update("more edits");
    emit([change("modified", "a.md", entry("a.md"))]);
    await vi.advanceTimersByTimeAsync(400);
    expect(vault.conflictFor("a.md")).toBeNull();
    expect(api.writeFile).toHaveBeenCalledTimes(2);
  });

  it("keep mine writes the local text against the disk state of the conflict", async () => {
    const diskEntry = await conflicted();
    await vault.resolveConflictKeepMine("a.md");
    expect(api.writeFile).toHaveBeenCalledWith("a.md", "my edits", { modified: diskEntry.modified, size: diskEntry.size });
    expect(vault.conflictFor("a.md")).toBeNull();
    expect(vault.dirty).toBe(false);
    expect(vault.content).toBe("my edits");
  });

  it("take theirs loads the disk version and drops the local edits", async () => {
    const diskEntry = await conflicted();
    await vault.resolveConflictTakeTheirs("a.md");
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(vault.conflictFor("a.md")).toBeNull();
    expect(vault.content).toBe("their version");
    expect(vault.dirty).toBe(false);
    // The next save expects the taken disk state.
    vault.update("edit after take");
    await vault.flush();
    expect(api.writeFile).toHaveBeenLastCalledWith("a.md", "edit after take", { modified: diskEntry.modified, size: diskEntry.size });
  });

  it("a merged version is saved against the disk state of the conflict", async () => {
    const diskEntry = await conflicted();
    await vault.resolveConflictMerged("a.md", "merged text");
    expect(api.writeFile).toHaveBeenCalledWith("a.md", "merged text", { modified: diskEntry.modified, size: diskEntry.size });
    expect(vault.conflictFor("a.md")).toBeNull();
    expect(vault.content).toBe("merged text");
    expect(vault.dirty).toBe(false);
  });

  it("a second external edit during resolution raises a new conflict", async () => {
    await conflicted();
    vi.mocked(api.writeFile).mockRejectedValueOnce(new Error("The file changed on disk: a.md"));
    vi.mocked(api.readFileMeta).mockImplementation(async () => ({
      content: "yet another version",
      entry: { ...entry("a.md"), size: 19, modified: 3000 },
    }));
    await vault.resolveConflictKeepMine("a.md");
    expect(vault.conflictFor("a.md")?.diskContent).toBe("yet another version");
    expect(vault.dirty).toBe(true);
  });

  it("a write refused by the backend becomes a conflict, not a save error", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("my edits");
    vi.mocked(api.writeFile).mockRejectedValueOnce(new Error("The file changed on disk: a.md"));
    vi.mocked(api.readFileMeta).mockImplementation(async () => ({
      content: "their version",
      entry: { ...entry("a.md"), size: 13, modified: 2000 },
    }));
    await vault.flush();
    expect(vault.conflictFor("a.md")?.kind).toBe("modified");
    expect(vault.error).toBeNull();
    expect(vault.dirty).toBe(true);
  });

  it("an external deletion keeps the dirty buffer and its tab open", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("my edits");
    vi.mocked(api.readFile).mockRejectedValueOnce(new Error("not found"));
    emit([change("removed", "a.md")]);
    await vi.advanceTimersByTimeAsync(400);
    expect(vault.conflictFor("a.md")?.kind).toBe("removed");
    expect(vault.openPath).toBe("a.md");
    expect(vault.content).toBe("my edits");
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it("keep mine on a deleted file recreates it and its entry", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("my edits");
    vi.mocked(api.readFile).mockRejectedValueOnce(new Error("not found"));
    emit([change("removed", "a.md")]);
    await vi.advanceTimersByTimeAsync(0);
    vault.entries = [];
    await vault.resolveConflictKeepMine("a.md");
    // No expected state: the file is gone, the write recreates it.
    expect(api.writeFile).toHaveBeenCalledWith("a.md", "my edits", undefined);
    expect(vault.conflictFor("a.md")).toBeNull();
    expect(vault.entryAt("a.md")).toBeDefined();
  });

  it("take theirs on a deleted file closes the tab and drops the buffer", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("my edits");
    vi.mocked(api.readFile).mockRejectedValueOnce(new Error("not found"));
    emit([change("removed", "a.md")]);
    await vi.advanceTimersByTimeAsync(0);
    await vault.resolveConflictTakeTheirs("a.md");
    expect(vault.openPath).toBeNull();
    expect(vault.conflictFor("a.md")).toBeNull();
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it("an external deletion of a clean buffer still closes its tab", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vi.mocked(api.readFile).mockRejectedValueOnce(new Error("not found"));
    emit([change("removed", "a.md")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.openPath).toBeNull();
    expect(vault.conflictFor("a.md")).toBeNull();
  });
});

describe("links", () => {
  it("resolves paths, names and different case", async () => {
    vault.entries = [entry("Projects/Meeting-Planning.md")];
    expect(vault.resolveLink("projects/meeting-planning.md")).toBe("Projects/Meeting-Planning.md");
    expect(vault.resolveLink("Meeting-Planning")).toBe("Projects/Meeting-Planning.md");
    expect(vault.resolveLink("meeting-planning.md")).toBe("Projects/Meeting-Planning.md");
    expect(vault.resolveLink("does-not-exist")).toBeUndefined();
  });

  it("creates a missing note when following a link to it", async () => {
    await vault.newTab();
    await vault.openLink("Fresh Note");
    expect(api.createFile).toHaveBeenCalledWith("Fresh Note.md", "# Fresh Note\n\n");
    expect(vault.openPath).toBe("Fresh Note.md");
  });
});

describe("file operations", () => {
  it("creates the next free Untitled name", async () => {
    vault.entries = [entry("Untitled.md")];
    await vault.newTab();
    await vault.createFile(vault.creatable()[0]);
    expect(api.createFile).toHaveBeenCalledWith("Untitled 2.md", "");
    expect(vault.openPath).toBe("Untitled 2.md");
  });

  it("rename moves the open file, its tab and the recent list", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    await vault.rename("a.md", "b.md");
    expect(api.renameEntry).toHaveBeenCalledWith("a.md", "b.md");
    expect(vault.openPath).toBe("b.md");
    expect(vault.tabs[0].path).toBe("b.md");
    expect(vault.recent[0]).toBe("b.md");
    expect(vault.entries.map((e) => e.path)).toEqual(["b.md"]);
  });

  it("moves a folder with everything inside it", async () => {
    vault.entries = [entry("a", true), entry("a/b.md"), entry("target", true)];
    await vault.newTab();
    await vault.openFile("a/b.md");
    await vault.move("a", "target");
    expect(api.renameEntry).toHaveBeenCalledWith("a", "target/a");
    expect(vault.openPath).toBe("target/a/b.md");
    // The list keeps its order until the next refresh sorts it again.
    expect(vault.entries.map((e) => e.path)).toEqual(["target/a", "target/a/b.md", "target"]);
  });

  it("refuses to move a folder into itself", async () => {
    vault.entries = [entry("a", true), entry("a/b.md")];
    await vault.move("a", "a");
    await vault.move("a", "a/sub");
    expect(api.renameEntry).not.toHaveBeenCalled();
  });

  it("trash removes entries and closes the tabs of what is gone", async () => {
    vault.entries = [entry("a.md"), entry("dir", true), entry("dir/b.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    await vault.openFile("dir/b.md", { newTab: true });
    await vault.trash("a.md");
    expect(vault.entries.map((e) => e.path)).toEqual(["dir", "dir/b.md"]);
    expect(vault.tabs.map((t) => t.path)).toEqual(["dir/b.md"]);
    await vault.trash("dir");
    expect(vault.entries).toEqual([]);
    expect(vault.openPath).toBeNull();
    expect(vault.tabs).toHaveLength(1);
    expect(vault.tabs[0].path).toBeNull();
  });

  it("a pending save must not recreate a trashed file", async () => {
    vault.entries = [entry("a.md")];
    await vault.newTab();
    await vault.openFile("a.md");
    vault.update("changed");
    // Pending edits are saved before trashing, so the trash keeps them.
    await vault.trash("a.md");
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it("own changes move the change counters of the panels", async () => {
    vault.entries = [entry("a.md")];
    const before = { structure: vault.changes.structure.number, notes: vault.changes.notes.number };
    await vault.newTab();
    await vault.createFile(vault.creatable()[0]);
    expect(vault.changes.structure.number).toBeGreaterThan(before.structure);
    expect(vault.changes.notes.number).toBeGreaterThan(before.notes);
  });
});
