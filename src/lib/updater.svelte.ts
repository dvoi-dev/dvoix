// App updates: checks the GitHub release feed for a new version, downloads it
// and restarts into it (tauri-plugin-updater). The check runs once at startup
// (quietly) and on demand in the settings. Nothing here is stored in the vault:
// updates are a property of the installed app, not of the notes.
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { flushConfig } from "./config";
import { vault } from "./vault.svelte";

export type UpdaterStatus = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "error";

class UpdaterStore {
  status = $state<UpdaterStatus>("idle");
  /** Version of the running app, from the Tauri config. */
  appVersion = $state("");
  /** The new version, when one is available (also after a failed install, for a retry). */
  version = $state<string | null>(null);
  /** Release notes of the new version. */
  notes = $state<string | null>(null);
  /** Download progress from 0 to 1; null while the size is unknown. */
  progress = $state<number | null>(0);
  error = $state<string | null>(null);
  /** The update banner was dismissed for this session. */
  dismissed = $state(false);

  private update: Update | null = null;
  private busy = false;

  /** Called once at startup: reads the app version and checks quietly. */
  async init() {
    if (!isTauri()) return;
    this.appVersion = await getVersion().catch(() => "");
    if (!import.meta.env.DEV) await this.check(true);
  }

  /** Looks for a new release. `silent` keeps the UI calm when nothing is found. */
  async check(silent = false) {
    if (!isTauri() || this.busy || this.status === "downloading") return;
    this.busy = true;
    this.error = null;
    if (!silent) this.status = "checking";
    try {
      const update = await check({ timeout: 15000 });
      this.replaceUpdate(update);
      if (update) {
        this.version = update.version;
        this.notes = update.body ?? null;
        this.dismissed = false;
        this.status = "available";
      } else {
        this.version = null;
        this.notes = null;
        this.status = silent ? "idle" : "up-to-date";
      }
    } catch (e) {
      this.replaceUpdate(null);
      this.version = null;
      this.notes = null;
      this.status = silent ? "idle" : "error";
      if (!silent) this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  /** Saves pending edits, downloads the available update and restarts the app into it. */
  async install() {
    const update = this.update;
    if (!update || this.status === "downloading") return;
    this.status = "downloading";
    this.progress = 0;
    this.error = null;
    this.dismissed = false;
    let total = 0;
    let loaded = 0;
    try {
      // The installer may end the process (on Windows it always does), and
      // the restart does not wait for `beforeunload`: everything still
      // waiting to be written must be on disk first.
      await vault.flush();
      await flushConfig();
      if (vault.dirty) throw new Error("Your changes could not be saved, so the update was not installed.");
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          this.progress = total > 0 ? 0 : null;
        } else if (event.event === "Progress") {
          loaded += event.data.chunkLength;
          this.progress = total > 0 ? Math.min(1, loaded / total) : null;
        }
      });
      await relaunch();
    } catch (e) {
      this.status = "error";
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Swaps the pending update and releases the native resource of the old one. */
  private replaceUpdate(next: Update | null) {
    const old = this.update;
    this.update = next;
    if (old && old !== next) void old.close().catch(() => {});
  }
}

export const updater = new UpdaterStore();
