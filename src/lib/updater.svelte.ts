// App updates: checks the GitHub release feed for a new version, downloads it
// and restarts into it (tauri-plugin-updater). The check runs once at startup
// (quietly) and on demand in the settings. Nothing here is stored in the vault:
// updates are a property of the installed app, not of the notes.
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdaterStatus = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "error";

class UpdaterStore {
  status = $state<UpdaterStatus>("idle");
  /** Version of the running app, from the Tauri config. */
  appVersion = $state("");
  /** The new version, when one is available. */
  version = $state<string | null>(null);
  /** Release notes of the new version. */
  notes = $state<string | null>(null);
  /** Download progress, from 0 to 1. */
  progress = $state(0);
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
      this.update = update;
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
      this.update = null;
      this.status = silent ? "idle" : "error";
      if (!silent) this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  /** Downloads the available update and restarts the app into it. */
  async install() {
    const update = this.update;
    if (!update || this.status === "downloading") return;
    this.status = "downloading";
    this.progress = 0;
    this.error = null;
    let total = 0;
    let loaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          loaded += event.data.chunkLength;
          this.progress = total > 0 ? Math.min(1, loaded / total) : 0;
        }
      });
      await relaunch();
    } catch (e) {
      this.status = "error";
      this.error = String(e);
    }
  }
}

export const updater = new UpdaterStore();
