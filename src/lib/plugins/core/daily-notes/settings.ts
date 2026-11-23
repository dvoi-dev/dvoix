// Settings of the daily notes plugin, in `.dvoix/plugins/daily-notes/data.json`.
import { pluginSettings } from "../../pluginSettings.svelte";

export const dailySettings = pluginSettings({
  /** Vault folder the daily notes are created in (created when needed). */
  folder: "Daily",
  /** File name format, may contain folders: "YYYY/MM/YYYY-MM-DD". */
  dateFormat: "YYYY-MM-DD",
  /** Optional template note (vault-relative path); "" = plain heading. */
  templatePath: "",
  /** Format of `{{time}}` in the template; `{{date}}` uses the format above. */
  timeFormat: "HH:mm",
});
