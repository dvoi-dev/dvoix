// Settings of the templates plugin, in `.dvoix/plugins/templates/data.json`.
import { pluginSettings } from "../../pluginSettings.svelte";

export const templateSettings = pluginSettings({
  /** Vault folder with the template notes (subfolders included). */
  folder: "Templates",
  /** Format of `{{date}}`, tokens like in Obsidian (moment.js). */
  dateFormat: "YYYY-MM-DD",
  /** Format of `{{time}}`. */
  timeFormat: "HH:mm",
});
