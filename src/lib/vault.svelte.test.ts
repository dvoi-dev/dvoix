// Tests for the vault state: tabs, deferred saving, link resolution and the
// file operations. The Rust commands are mocked, so no Tauri window is needed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultEntry } from "./api";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./api", () => ({
  api: {
    lastVault: vi.fn(async () => null),
    openVault: vi.fn(),
    closeVault: vi.fn(),
    listEntries: vi.fn(async () => []),
    readFile: vi.fn(async () => ""),
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
  saveTimer?: ReturnType<typeof setTimeout>;
  refreshTimer?: ReturnType<typeof setTimeout>;
}

function reset() {
  const priv = vault as unknown as Privates;
  clearTimeout(priv.saveTimer);
  clearTimeout(priv.refreshTimer);
  priv.navHistory = [];
  priv.navIndex = -1;
  priv.selfWrites = [];
  vault.info = null;
  vault.entries = [];
  vault.tabs = [];
  vault.activeTabId = 0;
  vault.openPath = null;
  vault.openView = null;
  vault.content = "";
  vault.dirty = false;
  vault.error = null;
  vault.recent = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
  vi.useFakeTimers();
  vi.mocked(api.listEntries).mockImplementation(async () => [...vault.entries]);
  vi.mocked(api.readFile).mockImplementation(async (path) => `content of ${path}`);
  vi.mocked(api.writeFile).mockImplementation(async (path) => entry(path));
  vi.mocked(api.createFile).mockImplementation(async (path) => entry(path));
  vi.mocked(api.createFolder).mockImplementation(async (path) => entry(path, true));
  vi.mocked(api.renameEntry).mockImplementation(async (_from, to) => entry(to));
  vi.mocked(api.trashEntry).mockResolvedValue(undefined);
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
    expect(api.writeFile).toHaveBeenCalledWith("a.md", "two");
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
    await vault.trash("a.md");
    await vi.advanceTimersByTimeAsync(400);
    expect(api.writeFile).not.toHaveBeenCalled();
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
