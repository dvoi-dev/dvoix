// Opening daily notes: today's note is created when missing (optionally from
// a template), the neighbor commands only open notes that already exist.
import { api } from "../../../api";
import { noteTitle, renderTemplate } from "../../../templates";
import { toasts } from "../../../toast.svelte";
import { vault } from "../../../vault.svelte";
import { dailyNotePath, neighborDailyNote } from "./paths";
import { dailySettings } from "./settings";

/** Content of a new daily note: the template filled in, or a plain heading. */
async function contentFor(path: string, date: Date): Promise<string> {
  const s = dailySettings.value;
  const title = noteTitle(path);
  const fallback = `# ${title}\n\n`;
  if (!s.templatePath) return fallback;
  try {
    const text = await api.readFile(s.templatePath);
    return renderTemplate(text, { title, now: date, dateFormat: s.dateFormat || "YYYY-MM-DD", timeFormat: s.timeFormat || "HH:mm" });
  } catch {
    toasts.error(`Template "${s.templatePath}" could not be read. The daily note was created without it.`);
    return fallback;
  }
}

/** Opens today's daily note, creating it (and its folders) when missing. */
export async function openToday(): Promise<void> {
  const s = dailySettings.value;
  const now = new Date();
  const path = dailyNotePath(now, s.folder, s.dateFormat);
  await vault.openOrCreateFile(path, await contentFor(path, now));
}

/**
 * Opens the closest existing daily note before/after the open one (or today).
 * Creates nothing, so a wrong click cannot litter the vault with empty notes.
 */
export async function openNeighbor(direction: -1 | 1): Promise<void> {
  const s = dailySettings.value;
  const path = neighborDailyNote(vault.entries, vault.openPath, s.folder, s.dateFormat, direction);
  if (!path) {
    toasts.show(direction < 0 ? "No earlier daily note." : "No later daily note.");
    return;
  }
  await vault.openFile(path);
}
