// Tests for the store plugin API's context menu hooks: ids are namespaced,
// items keep their labels and actions, and everything is gone on unload.
import { describe, expect, it, vi } from "vitest";
import type { StoreManifest } from "../../api";

vi.mock("../../config", () => ({
  readJsonRaw: vi.fn(async () => null),
  readJson: vi.fn(async (_path: string, defaults: object) => ({ ...defaults })),
  writeJson: vi.fn(),
}));
vi.mock("../../vault.svelte", () => ({ vault: { error: null, entries: [], openPath: null, activeTab: null } }));
vi.mock("../../hotkeys.svelte", () => ({ hotkeys: { load: vi.fn(), reset: vi.fn(), forCommand: () => [] } }));
vi.mock("../../filetypes", () => ({ registerFileType: () => () => {} }));

import { plugins } from "../manager.svelte";
import type { Plugin } from "../types";
import { createApi } from "./api";

const manifest: StoreManifest = {
  id: "menu-demo",
  name: "Menu demo",
  version: "1.0.0",
  description: "Adds context menu items.",
  permissions: [],
};

describe("store API context menus", () => {
  it("passes the context through, keeps labels and actions, and cleans up", async () => {
    const action = vi.fn();
    const plugin: Plugin = {
      manifest,
      onload(ctx) {
        const dvoix = createApi(ctx, manifest);
        dvoix.addFileMenu({
          id: "items",
          items: ({ entry, folder }) => [{ label: entry ? entry.path : `root:${folder}`, action }],
        });
        dvoix.addTabMenu({ id: "items", items: (tab) => (tab.path ? [{ label: tab.path, danger: true, action }] : []) });
      },
    };
    await plugins.loadExtra(plugin);

    const entry = { path: "a.md", name: "a.md", extension: "md", isDir: false, size: 1, modified: 1 };
    const items = plugins.fileMenuItems({ entry, folder: "" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: "a.md", action });
    expect(plugins.fileMenuItems({ entry: null, folder: "" })[0]).toMatchObject({ label: "root:" });
    expect(plugins.tabMenuItems({ id: 1, path: "b.md" })[0]).toMatchObject({ label: "b.md", danger: true, action });
    expect(plugins.tabMenuItems({ id: 2, path: null })).toEqual([]);

    await plugins.unloadExtra(manifest.id);
    expect(plugins.fileMenuItems({ entry, folder: "" })).toEqual([]);
    expect(plugins.tabMenuItems({ id: 1, path: "b.md" })).toEqual([]);
    expect(action).not.toHaveBeenCalled();
  });
});