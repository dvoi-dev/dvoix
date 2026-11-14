// Tests for the app updater state: quiet and manual checks, and that an
// install saves everything pending before the installer can end the process.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const state = { dirty: false };

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.2.0") }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => calls.push("relaunch")) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("./config", () => ({ flushConfig: vi.fn(async () => calls.push("flushConfig")) }));
vi.mock("./vault.svelte", () => ({
  vault: {
    flush: vi.fn(async () => calls.push("vault.flush")),
    get dirty() {
      return state.dirty;
    },
  },
}));

import { check } from "@tauri-apps/plugin-updater";
import { updater } from "./updater.svelte";

type Progress = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } };

function fakeUpdate(events: Progress[] = [], fail?: Error) {
  return {
    version: "0.3.0",
    body: "Notes",
    close: vi.fn(async () => {}),
    downloadAndInstall: vi.fn(async (onEvent: (e: Progress) => void) => {
      calls.push("install");
      for (const e of events) onEvent(e);
      if (fail) throw fail;
    }),
  };
}

function reset() {
  calls.length = 0;
  state.dirty = false;
  Object.assign(updater, { status: "idle", version: null, notes: null, progress: 0, error: null, dismissed: false });
  (updater as unknown as { update: unknown }).update = null;
}

describe("updater", () => {
  beforeEach(reset);

  it("offers a found update", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate() as never);
    await updater.check();
    expect(updater.status).toBe("available");
    expect(updater.version).toBe("0.3.0");
    expect(updater.notes).toBe("Notes");
  });

  it("stays quiet when a silent check finds nothing or fails", async () => {
    vi.mocked(check).mockResolvedValue(null);
    await updater.check(true);
    expect(updater.status).toBe("idle");
    vi.mocked(check).mockRejectedValue(new Error("offline"));
    await updater.check(true);
    expect(updater.status).toBe("idle");
    expect(updater.error).toBeNull();
  });

  it("reports a failed manual check", async () => {
    vi.mocked(check).mockRejectedValue(new Error("offline"));
    await updater.check();
    expect(updater.status).toBe("error");
    expect(updater.error).toContain("offline");
    expect(updater.version).toBeNull();
  });

  it("releases the previous update when a new check replaces it", async () => {
    const first = fakeUpdate();
    vi.mocked(check).mockResolvedValue(first as never);
    await updater.check();
    vi.mocked(check).mockResolvedValue(null);
    await updater.check();
    expect(first.close).toHaveBeenCalled();
  });

  it("saves pending edits and settings before installing", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate() as never);
    await updater.check();
    await updater.install();
    expect(calls).toEqual(["vault.flush", "flushConfig", "install", "relaunch"]);
  });

  it("does not install when the edits could not be saved", async () => {
    const update = fakeUpdate();
    vi.mocked(check).mockResolvedValue(update as never);
    await updater.check();
    state.dirty = true;
    await updater.install();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(updater.status).toBe("error");
    expect(updater.error).toMatch(/could not be saved/);
    expect(updater.version).toBe("0.3.0"); // still offered for a retry
  });

  it("keeps the update for a retry after a failed install", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate([], new Error("bad signature")) as never);
    await updater.check();
    updater.dismissed = true;
    await updater.install();
    expect(updater.status).toBe("error");
    expect(updater.error).toBe("bad signature");
    expect(updater.version).toBe("0.3.0");
    expect(updater.dismissed).toBe(false);
  });

  it("tracks progress, and marks it unknown without a content length", async () => {
    const seen: (number | null)[] = [];
    const known = fakeUpdate();
    known.downloadAndInstall.mockImplementation(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      seen.push(updater.progress);
    });
    vi.mocked(check).mockResolvedValue(known as never);
    await updater.check();
    await updater.install();
    expect(seen).toEqual([0.4]);

    reset();
    const unknown = fakeUpdate();
    unknown.downloadAndInstall.mockImplementation(async (onEvent) => {
      onEvent({ event: "Started", data: {} });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      seen.push(updater.progress);
    });
    vi.mocked(check).mockResolvedValue(unknown as never);
    await updater.check();
    await updater.install();
    expect(seen).toEqual([0.4, null]);
  });
});
