// Tests for the plugin manager's context menu contributions: registration,
// ordering, separators between plugins and the cleanup when a plugin unloads.
import { describe, expect, it, vi } from "vitest";
import type { VaultEntry } from "../api";

vi.mock("../config", () => ({
  readJsonRaw: vi.fn(async () => null),
  readJson: vi.fn(async (_path: string, defaults: object) => ({ ...defaults })),
  writeJson: vi.fn(),
}));
vi.mock("../vault.svelte", () => ({ vault: { error: null } }));
vi.mock("../hotkeys.svelte", () => ({ hotkeys: { load: vi.fn(), reset: vi.fn(), forCommand: () => [] } }));
vi.mock("../filetypes", () => ({ registerFileType: () => () => {} }));

import { plugins } from "./manager.svelte";
import type { Plugin, PluginContext } from "./types";

const entry: VaultEntry = { path: "Notes", name: "Notes", extension: "", isDir: true, size: 0, modified: 0 };
const tab = { id: 1, path: "a.md" };

function menuPlugin(id: string, onload: (ctx: PluginContext) => void): Plugin {
  return { manifest: { id, name: id, description: "Test plugin.", version: "1.0.0" }, onload };
}

describe("context menu contributions", () => {
  it("collects items in order, separates plugins and drops empty groups", async () => {
    const first = menuPlugin("menu-first", (ctx) => {
      ctx.addFileMenu({ id: "items", order: 1, items: () => [{ label: "First", action: () => {} }] });
      ctx.addTabMenu({ id: "items", order: 1, items: (t) => (t.path ? [{ label: `Tab ${t.path}`, action: () => {} }] : []) });
    });
    const second = menuPlugin("menu-second", (ctx) => {
      ctx.addFileMenu({ id: "items", order: 2, items: (c) => [{ label: `Folder ${c.folder}`, action: () => {} }] });
      ctx.addFileMenu({ id: "empty", order: 3, items: () => [] });
    });
    await plugins.loadExtra(first);
    await plugins.loadExtra(second);

    expect(plugins.fileMenuItems({ entry, folder: "Notes" })).toEqual([
      { label: "First", action: expect.any(Function) },
      "separator",
      { label: "Folder Notes", action: expect.any(Function) },
    ]);
    expect(plugins.fileMenuItems({ entry: null, folder: "" })[2]).toEqual({ label: "Folder ", action: expect.any(Function) });
    expect(plugins.tabMenuItems(tab)).toEqual([{ label: "Tab a.md", action: expect.any(Function) }]);
    expect(plugins.tabMenuItems({ id: 2, path: null })).toEqual([]);

    await plugins.unloadExtra("menu-first");
    expect(plugins.fileMenuItems({ entry, folder: "Notes" })).toEqual([{ label: "Folder Notes", action: expect.any(Function) }]);
    expect(plugins.tabMenuItems(tab)).toEqual([]);

    await plugins.unloadExtra("menu-second");
    expect(plugins.fileMenuItems({ entry, folder: "Notes" })).toEqual([]);
  });

  it("a throwing contributor does not take the menu down", async () => {
    const broken = menuPlugin("menu-broken", (ctx) => {
      ctx.addFileMenu({ id: "boom", order: 1, items: () => { throw new Error("boom"); } });
      ctx.addFileMenu({ id: "fine", order: 2, items: () => [{ label: "Fine", action: () => {} }] });
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await plugins.loadExtra(broken);
    expect(plugins.fileMenuItems({ entry: null, folder: "" })).toEqual([{ label: "Fine", action: expect.any(Function) }]);
    await plugins.unloadExtra("menu-broken");
    spy.mockRestore();
  });

  it("refuses a duplicate contributor id within one plugin", async () => {
    let failed = false;
    const dup = menuPlugin("menu-dup", (ctx) => {
      ctx.addFileMenu({ id: "same", items: () => [] });
      try {
        ctx.addFileMenu({ id: "same", items: () => [] });
      } catch {
        failed = true;
      }
    });
    await plugins.loadExtra(dup);
    expect(failed).toBe(true);
    await plugins.unloadExtra("menu-dup");
  });
});
