// Reactive state for `.trash/` entries, kept in sync with watcher events and vault actions.
import { api, onVaultChanged, type TrashedEntry } from "../../api";

const REFRESH_DELAY_MS = 150;

class TrashState {
  items = $state.raw<TrashedEntry[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  async refresh() {
    clearTimeout(this.timer);
    const run = ++this.generation;
    this.loading = true;
    try {
      const list = await api.listTrash();
      if (run === this.generation) {
        this.items = list;
        this.error = null;
      }
    } catch (e) {
      if (run === this.generation) this.error = String(e);
    } finally {
      if (run === this.generation) this.loading = false;
    }
  }

  scheduleRefresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }

  async watch(): Promise<() => void> {
    const unlisten = await onVaultChanged((changes) => {
      if (changes.some((c) => c.path === ".trash" || c.path.startsWith(".trash/"))) {
        this.scheduleRefresh();
      }
    });
    return () => {
      unlisten();
      clearTimeout(this.timer);
      this.generation++;
      this.items = [];
      this.error = null;
      this.loading = false;
    };
  }
}

export const trashState = new TrashState();
