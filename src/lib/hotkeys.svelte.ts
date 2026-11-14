// Vault-specific keyboard overrides. Missing commands use their registered
// defaults; an empty array means that a command is deliberately unbound.
import { readJsonRaw, writeJson } from "./config";
import type { Hotkey } from "./plugins/types";

const HOTKEYS_FILE = "hotkeys.json";
const MODIFIER_KEYS = new Set(["control", "meta", "shift", "alt", "altgraph", "capslock", "hyper", "super"]);

export interface BoundCommand {
  fullId: string;
  hotkeys?: Hotkey[];
}

function clean(hotkey: Hotkey): Hotkey {
  const key = hotkey.key.length === 1 ? hotkey.key.toLowerCase() : hotkey.key;
  return {
    ...(hotkey.mod ? { mod: true } : {}),
    ...(hotkey.shift ? { shift: true } : {}),
    ...(hotkey.alt ? { alt: true } : {}),
    key,
  };
}

export function hotkeyId(hotkey: Hotkey): string {
  return `${hotkey.mod ? 1 : 0}${hotkey.shift ? 1 : 0}${hotkey.alt ? 1 : 0}:${hotkey.key.toLowerCase()}`;
}

export function hotkeyFromEvent(event: KeyboardEvent): Hotkey | null {
  const key = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  const mod = event.ctrlKey || event.metaKey;
  if (!mod && !event.altKey && !/^f\d{1,2}$/.test(key)) return null;
  return clean({ mod, shift: event.shiftKey, alt: event.altKey, key: event.key });
}

function isHotkey(value: unknown): value is Hotkey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hotkey = value as Partial<Hotkey>;
  return (
    typeof hotkey.key === "string" &&
    hotkey.key.length > 0 &&
    (hotkey.mod === undefined || typeof hotkey.mod === "boolean") &&
    (hotkey.shift === undefined || typeof hotkey.shift === "boolean") &&
    (hotkey.alt === undefined || typeof hotkey.alt === "boolean")
  );
}

function unique(hotkeys: Hotkey[]): Hotkey[] {
  const seen = new Set<string>();
  return hotkeys.filter((hotkey) => {
    const id = hotkeyId(hotkey);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function same(a: Hotkey[], b: Hotkey[]): boolean {
  return a.length === b.length && a.every((hotkey, index) => hotkeyId(hotkey) === hotkeyId(b[index]));
}

function sanitize(raw: unknown): Record<string, Hotkey[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Hotkey[]> = {};
  for (const [command, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    out[command] = unique(value.filter(isHotkey).map(clean));
  }
  return out;
}

class HotkeyStore {
  overrides = $state<Record<string, Hotkey[]>>({});
  capturing = $state(false);

  async load() {
    this.overrides = sanitize(await readJsonRaw(HOTKEYS_FILE));
    this.capturing = false;
  }

  reset() {
    this.overrides = {};
    this.capturing = false;
  }

  save() {
    writeJson(HOTKEYS_FILE, $state.snapshot(this.overrides));
  }

  forCommand(command: BoundCommand): Hotkey[] {
    return this.overrides[command.fullId] ?? command.hotkeys ?? [];
  }

  isOverridden(fullId: string): boolean {
    return Object.hasOwn(this.overrides, fullId);
  }

  conflicts(hotkey: Hotkey, commands: BoundCommand[], except: string): BoundCommand[] {
    const id = hotkeyId(hotkey);
    return commands.filter((command) => command.fullId !== except && this.forCommand(command).some((bound) => hotkeyId(bound) === id));
  }

  /** Returns conflicting commands without changing anything, unless `replace` is true. */
  assign(command: BoundCommand, hotkey: Hotkey, index: number | null, commands: BoundCommand[], replace = false): BoundCommand[] {
    const conflicts = this.conflicts(hotkey, commands, command.fullId);
    if (conflicts.length && !replace) return conflicts;
    if (replace) {
      const id = hotkeyId(hotkey);
      for (const other of conflicts) {
        this.set(other, this.forCommand(other).filter((bound) => hotkeyId(bound) !== id));
      }
    }
    const next = [...this.forCommand(command)];
    if (index === null) next.push(clean(hotkey));
    else next[index] = clean(hotkey);
    this.set(command, unique(next));
    return [];
  }

  remove(command: BoundCommand, index: number) {
    this.set(command, this.forCommand(command).filter((_, position) => position !== index));
  }

  resetCommand(command: BoundCommand) {
    delete this.overrides[command.fullId];
    this.save();
  }

  resetAll() {
    this.overrides = {};
    this.save();
  }

  private set(command: BoundCommand, hotkeys: Hotkey[]) {
    if (same(hotkeys, command.hotkeys ?? [])) delete this.overrides[command.fullId];
    else this.overrides[command.fullId] = hotkeys;
    this.save();
  }
}

export const hotkeys = new HotkeyStore();
