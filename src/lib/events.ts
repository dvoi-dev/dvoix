// Events of the app that plugins can listen to (`PluginContext.on`, and the
// `on…` calls of the store plugin API). Only the app's own code emits them,
// right where it changes the vault (`vault.svelte.ts`, the store API's
// `vault.write`, pasted attachments); plugins only listen. Changes on disk
// from outside the app (sync tools, git, other editors) are not part of
// this: they arrive through the file watcher, see `vault.onChanges`.

export interface AppEvents {
  /**
   * The active tab shows another file or view. `path` is null for a view
   * (then `view` is its id) and for an empty tab.
   */
  "active-file-change": { path: string | null; view: string | null };
  /** The editor wrote the open file to disk (after typing, or before switching away). */
  "file-save": { path: string };
  /** dvoix created a file or folder: file explorer, a followed link, a pasted image, a plugin. */
  "file-create": { path: string; isDir: boolean };
  /** dvoix renamed or moved a file or folder. Everything inside a folder moves along with it. */
  "file-rename": { from: string; to: string; isDir: boolean };
  /** dvoix moved a file or folder to `.trash/`. */
  "file-delete": { path: string; isDir: boolean };
}

export type AppEventName = keyof AppEvents;
export type AppEventHandler<K extends AppEventName> = (event: AppEvents[K]) => void;

class AppEventBus {
  private handlers = new Map<AppEventName, Set<(event: never) => void>>();

  /** Calls `fn` for every `event`; returns the unsubscribe. */
  on<K extends AppEventName>(event: K, fn: AppEventHandler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit<K extends AppEventName>(event: K, payload: AppEvents[K]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) {
      // A broken plugin must not keep the others (or the app) from hearing it.
      try {
        (fn as AppEventHandler<K>)({ ...payload });
      } catch (e) {
        console.error(`A handler of "${event}" failed`, e);
      }
    }
  }
}

export const appEvents = new AppEventBus();
