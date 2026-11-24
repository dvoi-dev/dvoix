// Tests for vault-specific hotkeys: normalizing, detecting a shortcut from a
// key event, and the conflict rules when a shortcut is assigned or replaced.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  readJsonRaw: vi.fn(async () => null),
  writeJson: vi.fn(),
}));

import { hotkeys, hotkeyFromEvent, hotkeyId, type BoundCommand } from "./hotkeys.svelte";
import type { Hotkey } from "./plugins/types";

const cmd = (fullId: string, hotkeys?: Hotkey[]): BoundCommand => ({ fullId, hotkeys });

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init } as KeyboardEvent;
}

describe("hotkeyId", () => {
  it("ignores the case of a single key and the order of the flags", () => {
    expect(hotkeyId({ mod: true, key: "K" })).toBe("100:k");
    expect(hotkeyId({ mod: true, shift: true, alt: true, key: "k" })).toBe("111:k");
    expect(hotkeyId({ key: "F5" })).toBe("000:f5");
  });
});

describe("hotkeyFromEvent", () => {
  it("ignores a modifier pressed on its own", () => {
    expect(hotkeyFromEvent(key({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(hotkeyFromEvent(key({ key: "Shift", shiftKey: true }))).toBeNull();
  });

  it("takes Ctrl or Cmd, Shift and Alt, but not a bare letter", () => {
    expect(hotkeyFromEvent(key({ key: "k", ctrlKey: true }))).toEqual({ mod: true, key: "k" });
    expect(hotkeyFromEvent(key({ key: "K", metaKey: true, shiftKey: true }))).toEqual({ mod: true, shift: true, key: "k" });
    expect(hotkeyFromEvent(key({ key: "k", altKey: true }))).toEqual({ alt: true, key: "k" });
    expect(hotkeyFromEvent(key({ key: "k" }))).toBeNull();
  });

  it("accepts a bare function key", () => {
    expect(hotkeyFromEvent(key({ key: "F5" }))).toEqual({ key: "F5" });
  });
});

describe("HotkeyStore", () => {
  const a = cmd("core:a", [{ mod: true, key: "a" }]);
  const b = cmd("core:b", [{ mod: true, key: "b" }]);
  const c = cmd("core:c", []);

  beforeEach(() => {
    hotkeys.reset();
  });

  it("returns the registered defaults until an override exists", () => {
    expect(hotkeys.forCommand(a)).toEqual([{ mod: true, key: "a" }]);
    expect(hotkeys.isOverridden("core:a")).toBe(false);
    expect(hotkeys.forCommand(c)).toEqual([]);
  });

  it("reports a conflict without changing anything", () => {
    const conflicts = hotkeys.assign(b, { mod: true, key: "a" }, null, [a, b]);
    expect(conflicts).toEqual([a]);
    expect(hotkeys.forCommand(b)).toEqual([{ mod: true, key: "b" }]);
  });

  it("replaces the conflicting binding when asked", () => {
    hotkeys.assign(b, { mod: true, key: "a" }, null, [a, b], true);
    // The new shortcut is added next to the command's own default.
    expect(hotkeys.forCommand(b)).toEqual([{ mod: true, key: "b" }, { mod: true, key: "a" }]);
    expect(hotkeys.forCommand(a)).toEqual([]);
    expect(hotkeys.isOverridden("core:a")).toBe(true);
  });

  it("assigns at an index and removes the duplicates", () => {
    hotkeys.assign(c, { mod: true, key: "b" }, null, [a, b, c]);
    hotkeys.assign(c, { mod: true, key: "b" }, 0, [a, b, c], true);
    expect(hotkeys.forCommand(c)).toEqual([{ mod: true, key: "b" }]);
    expect(hotkeys.forCommand(b)).toEqual([]);
  });

  it("removes one binding and keeps an empty list as deliberate", () => {
    hotkeys.assign(a, { mod: true, key: "x" }, null, [a, b]);
    hotkeys.remove(a, 0);
    expect(hotkeys.forCommand(a)).toEqual([{ mod: true, key: "x" }]);
    expect(hotkeys.isOverridden("core:a")).toBe(true);
  });

  it("drops an override that matches the defaults again", () => {
    hotkeys.assign(a, { mod: true, key: "x" }, 0, [a, b]);
    expect(hotkeys.isOverridden("core:a")).toBe(true);
    hotkeys.assign(a, { mod: true, key: "a" }, 0, [a, b]);
    expect(hotkeys.isOverridden("core:a")).toBe(false);
  });

  it("resets one command or everything", () => {
    hotkeys.assign(a, { mod: true, key: "x" }, null, [a, b]);
    hotkeys.resetCommand(a);
    expect(hotkeys.isOverridden("core:a")).toBe(false);
    hotkeys.assign(a, { mod: true, key: "x" }, null, [a, b]);
    hotkeys.resetAll();
    expect(hotkeys.overrides).toEqual({});
  });

  it("finds conflicts only among other commands", () => {
    expect(hotkeys.conflicts({ mod: true, key: "a" }, [a, b], "core:c")).toEqual([a]);
    expect(hotkeys.conflicts({ mod: true, key: "a" }, [a, b], "core:a")).toEqual([]);
  });
});
