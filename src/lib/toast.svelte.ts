// App-wide transient notifications (e.g. undo after deleting or moving files).

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastItem {
  id: number;
  message: string;
  action?: ToastAction;
  tone?: "default" | "error";
}

const DEFAULT_DURATION_MS = 5000;
const UNDO_DURATION_MS = 8000;
const MAX_TOASTS = 4;

let nextId = 1;

class ToastStore {
  items = $state<ToastItem[]>([]);
  private timers = new Map<number, { timer: ReturnType<typeof setTimeout>; remaining: number; startedAt: number }>();

  show(message: string, opts: { action?: ToastAction; tone?: "default" | "error"; durationMs?: number } = {}): number {
    const id = nextId++;
    const duration = opts.durationMs ?? (opts.action ? UNDO_DURATION_MS : DEFAULT_DURATION_MS);
    const item: ToastItem = { id, message, action: opts.action, tone: opts.tone ?? "default" };
    // Keep the stack compact; drop the oldest toast if too many pile up.
    while (this.items.length >= MAX_TOASTS) {
      this.dismiss(this.items[0].id);
    }
    this.items = [...this.items, item];
    this.startTimer(id, duration);
    return id;
  }

  undo(message: string, run: () => void | Promise<void>): number {
    return this.show(message, { action: { label: "Undo", run }, durationMs: UNDO_DURATION_MS });
  }

  error(message: string): number {
    return this.show(message, { tone: "error", durationMs: DEFAULT_DURATION_MS });
  }

  dismiss(id: number) {
    const entry = this.timers.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.timers.delete(id);
    }
    this.items = this.items.filter((t) => t.id !== id);
  }

  pause(id: number) {
    const entry = this.timers.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    const elapsed = Date.now() - entry.startedAt;
    entry.remaining = Math.max(1000, entry.remaining - elapsed);
  }

  resume(id: number) {
    const entry = this.timers.get(id);
    if (!entry) return;
    this.startTimer(id, entry.remaining);
  }

  clear() {
    for (const entry of this.timers.values()) clearTimeout(entry.timer);
    this.timers.clear();
    this.items = [];
  }

  private startTimer(id: number, duration: number) {
    const prev = this.timers.get(id);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => this.dismiss(id), duration);
    this.timers.set(id, { timer, remaining: duration, startedAt: Date.now() });
  }
}

export const toasts = new ToastStore();
