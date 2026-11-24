// Tests for the plugin store state: reading store.json, the install, update
// and uninstall flows, and the registry matching that decides about updates.
// The Rust commands and the plugin manager are mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, RegistryEntry, StoreManifest } from "../../api";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.2.0") }));
vi.mock("../../config", () => ({ readJsonRaw: vi.fn(async () => null), writeJson: vi.fn() }));
vi.mock("../manager.svelte", () => ({
  plugins: {
    isBuiltIn: vi.fn(() => false),
    isLoaded: vi.fn(() => false),
    extra: [],
    loadExtra: vi.fn(async () => {}),
    unloadExtra: vi.fn(async () => {}),
  },
}));
vi.mock("./api", () => ({ createApi: vi.fn(() => ({})) }));
vi.mock("./component", () => ({ iconComponent: vi.fn(() => ({})) }));
vi.mock("../../api", () => ({
  api: {
    storeInstalled: vi.fn(async () => []),
    storeInstall: vi.fn(),
    storeUninstall: vi.fn(),
    storeRegistry: vi.fn(async () => []),
    storeManifest: vi.fn(),
    storeChangelog: vi.fn(async () => []),
    readConfig: vi.fn(async () => null),
  },
}));

import { api } from "../../api";
import { readJsonRaw, writeJson } from "../../config";
import { plugins } from "../manager.svelte";
import { isNewer, pluginStore } from "./store.svelte";

const manifest = (id: string, version = "1.0.0", minAppVersion?: string): StoreManifest => ({
  id,
  name: id,
  version,
  description: `${id} plugin`,
  permissions: [],
  ...(minAppVersion ? { minAppVersion } : {}),
});

const entry = (id: string, version = "1.0.0", channel: RegistryEntry["channel"] = "official", repo = `dvoi-dev/dvoix-${id}`): RegistryEntry => ({
  id,
  name: id,
  author: "dvoi",
  description: `${id} plugin`,
  repo,
  channel,
  version,
  sha256: {},
});

const installed = (id: string, version = "1.0.0"): InstalledPlugin => ({ manifest: manifest(id, version), hasStyles: false });

describe("isNewer", () => {
  it("compares each part as a number", () => {
    expect(isNewer("1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.1", "1.0")).toBe(true);
  });
});

describe("loadVault", () => {
  beforeEach(() => {
    pluginStore.reset();
    pluginStore.appVersion = "0.2.0";
  });

  it("reads store.json, fills defaults and loads enabled plugins", async () => {
    vi.mocked(readJsonRaw).mockResolvedValue({
      allowCommunity: true,
      plugins: { demo: { enabled: true, repo: "dvoi-dev/dvoix-demo", channel: "official" } },
    });
    vi.mocked(api.storeInstalled).mockResolvedValue([installed("demo")]);

    await pluginStore.loadVault();

    expect(pluginStore.file).toMatchObject({ allowCommunity: true, checkUpdates: true });
    expect(pluginStore.installed).toHaveLength(1);
    expect(plugins.loadExtra).toHaveBeenCalledTimes(1);
    const loaded = vi.mocked(plugins.loadExtra).mock.calls[0][0];
    expect(loaded.manifest.id).toBe("demo");
  });

  it("does not load a community plugin while community plugins are blocked", async () => {
    vi.mocked(readJsonRaw).mockResolvedValue({
      plugins: { demo: { enabled: true, repo: "someone/dvoix-demo", channel: "community" } },
    });
    vi.mocked(api.storeInstalled).mockResolvedValue([installed("demo")]);

    await pluginStore.loadVault();

    expect(pluginStore.isEnabled("demo")).toBe(false);
    expect(plugins.loadExtra).not.toHaveBeenCalled();
  });

  it("loads the registry in the background when there is something to update", async () => {
    vi.mocked(readJsonRaw).mockResolvedValue({
      plugins: { demo: { enabled: false, repo: "dvoi-dev/dvoix-demo", channel: "official" } },
    });
    vi.mocked(api.storeInstalled).mockResolvedValue([installed("demo")]);
    vi.mocked(api.storeRegistry).mockResolvedValue([entry("demo", "1.1.0")]);

    await pluginStore.loadVault();
    await vi.waitFor(() => expect(pluginStore.registry).toHaveLength(1));
  });
});

describe("install", () => {
  beforeEach(() => {
    pluginStore.reset();
    pluginStore.appVersion = "0.2.0";
    vi.mocked(api.storeInstall).mockReset();
    vi.mocked(plugins.loadExtra).mockClear();
    vi.mocked(plugins.unloadExtra).mockClear();
  });

  it("installs an official plugin right away and turns it on", async () => {
    const e = entry("demo");
    vi.mocked(api.storeInstall).mockResolvedValue(manifest("demo"));
    vi.mocked(api.storeInstalled).mockResolvedValue([installed("demo")]);

    await pluginStore.install(e);

    expect(api.storeInstall).toHaveBeenCalledWith(e);
    expect(pluginStore.file.plugins.demo).toMatchObject({ enabled: true, repo: e.repo, channel: "official" });
    expect(pluginStore.manifests.demo).toMatchObject({ version: "1.0.0" });
    expect(plugins.loadExtra).toHaveBeenCalled();
    expect(pluginStore.busy.demo).toBeUndefined();
  });

  it("refuses a community plugin while community plugins are blocked", async () => {
    await pluginStore.install(entry("demo", "1.0.0", "community", "someone/dvoix-demo"));
    expect(api.storeInstall).not.toHaveBeenCalled();
    expect(pluginStore.file.plugins.demo).toBeUndefined();
  });

  it("records the error and clears the busy flag when the download fails", async () => {
    vi.mocked(api.storeInstall).mockRejectedValue(new Error("checksum mismatch"));
    await pluginStore.install(entry("demo"));
    expect(pluginStore.errors.demo).toContain("checksum mismatch");
    expect(pluginStore.busy.demo).toBeUndefined();
  });
});

describe("update", () => {
  beforeEach(() => {
    pluginStore.reset();
    pluginStore.appVersion = "0.2.0";
    pluginStore.installed = [installed("demo", "1.0.0")];
    pluginStore.file.plugins = { demo: { enabled: true, repo: "dvoi-dev/dvoix-demo", channel: "official" } };
    pluginStore.registry = [entry("demo", "2.0.0")];
    vi.mocked(api.storeInstall).mockReset();
    vi.mocked(api.storeManifest).mockReset();
    vi.mocked(plugins.loadExtra).mockClear();
    vi.mocked(plugins.unloadExtra).mockClear();
  });

  it("keeps the old release when the new one needs a newer app", async () => {
    vi.mocked(api.storeManifest).mockResolvedValue(manifest("demo", "2.0.0", "9.0.0"));

    await pluginStore.update("demo");

    expect(api.storeInstall).not.toHaveBeenCalled();
    expect(pluginStore.errors.demo).toContain("needs dvoix 9.0.0");
    expect(plugins.loadExtra).not.toHaveBeenCalled();
  });

  it("installs the pinned release and loads the new version", async () => {
    vi.mocked(api.storeManifest).mockResolvedValue(manifest("demo", "2.0.0"));
    vi.mocked(api.storeInstall).mockResolvedValue(manifest("demo", "2.0.0"));
    vi.mocked(api.storeInstalled).mockResolvedValue([installed("demo", "2.0.0")]);

    await pluginStore.update("demo");

    expect(plugins.unloadExtra).toHaveBeenCalledWith("demo");
    expect(api.storeInstall).toHaveBeenCalledWith(entry("demo", "2.0.0"));
    expect(pluginStore.file.plugins.demo).toMatchObject({ enabled: true, repo: "dvoi-dev/dvoix-demo" });
    expect(pluginStore.errors.demo).toBeUndefined();
  });

  it("does nothing without a registry entry", async () => {
    pluginStore.registry = [];
    await pluginStore.update("demo");
    expect(api.storeInstall).not.toHaveBeenCalled();
  });
});

describe("uninstall", () => {
  beforeEach(() => {
    pluginStore.reset();
    pluginStore.installed = [installed("demo")];
    pluginStore.file.plugins = { demo: { enabled: true, repo: "dvoi-dev/dvoix-demo", channel: "official" } };
    vi.mocked(api.storeUninstall).mockReset();
    vi.mocked(api.storeInstalled).mockResolvedValue([]);
  });

  it("unloads, removes the folder and forgets the record", async () => {
    await pluginStore.uninstall("demo");
    expect(plugins.unloadExtra).toHaveBeenCalledWith("demo");
    expect(api.storeUninstall).toHaveBeenCalledWith("demo");
    expect(pluginStore.file.plugins.demo).toBeUndefined();
    expect(pluginStore.installed).toEqual([]);
  });
});

describe("registry matching", () => {
  beforeEach(() => {
    pluginStore.reset();
  });

  it("matches the repository case-insensitively", () => {
    pluginStore.registry = [entry("demo", "1.0.0", "official", "Dvoi-Dev/Dvoix-Demo")];
    pluginStore.file.plugins = { demo: { enabled: true, repo: "dvoi-dev/dvoix-demo", channel: "official" } };
    expect(pluginStore.entryFor("demo")?.repo).toBe("Dvoi-Dev/Dvoix-Demo");
  });

  it("falls back to the official entry when the repo moved", () => {
    // The list no longer knows the old repository; the official entry of the
    // same plugin is the only match left.
    pluginStore.registry = [entry("demo", "1.0.0", "official", "dvoi-dev/dvoix-demo")];
    pluginStore.file.plugins = { demo: { enabled: true, repo: "someone/old", channel: "community" } };
    expect(pluginStore.entryFor("demo")?.channel).toBe("official");
  });

  it("reports an update only when the list pins a newer release", () => {
    pluginStore.installed = [installed("demo", "1.0.0")];
    pluginStore.registry = [entry("demo", "1.0.0")];
    pluginStore.file.plugins = { demo: { enabled: true, repo: "dvoi-dev/dvoix-demo", channel: "official" } };
    expect(pluginStore.hasUpdate("demo")).toBe(false);
    pluginStore.registry = [entry("demo", "1.1.0")];
    expect(pluginStore.hasUpdate("demo")).toBe(true);
    expect(pluginStore.updateCount).toBe(1);
  });

  it("counts a plugin copied into the folder by hand as community", () => {
    pluginStore.installed = [installed("demo")];
    expect(pluginStore.channelOf("demo")).toBe("community");
    expect(pluginStore.isBlocked("demo")).toBe(true);
    pluginStore.file.allowCommunity = true;
    expect(pluginStore.isEnabled("demo")).toBe(false);
  });
});

describe("changelog", () => {
  beforeEach(() => {
    pluginStore.reset();
    vi.mocked(api.storeChangelog).mockReset();
  });

  it("loads the notes once per repository and keeps errors", async () => {
    vi.mocked(api.storeChangelog).mockResolvedValue([{ version: "1.0.0", name: null, notes: "First", published: null }]);
    await pluginStore.fetchChangelog(entry("demo"));
    await pluginStore.fetchChangelog(entry("demo"));
    expect(api.storeChangelog).toHaveBeenCalledTimes(1);
    expect(pluginStore.changelogs["dvoi-dev/dvoix-demo"]).toHaveLength(1);

    pluginStore.reset();
    vi.mocked(api.storeChangelog).mockRejectedValue(new Error("offline"));
    await pluginStore.fetchChangelog(entry("other"));
    expect(pluginStore.changelogs["dvoi-dev/dvoix-other"]).toEqual({ error: "Error: offline" });
  });
});

describe("saving", () => {
  it("writes store.json through config", async () => {
    pluginStore.reset();
    pluginStore.setCheckUpdates(false);
    expect(writeJson).toHaveBeenCalledWith("store.json", expect.objectContaining({ checkUpdates: false }));
  });
});
