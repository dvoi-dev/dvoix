// Path logic of the daily notes plugin, without vault access: where the note
// of a day lives and which existing note is the neighbor of the open one.
// The date format may contain folders ("YYYY/MM/YYYY-MM-DD"), so notes can
// be grouped by year and month. Everything stays inside the target folder.
import type { VaultEntry } from "../../../api";
import { cleanFolder } from "../../../attachments";
import { formatDate, parseDate } from "../../../templates";

/**
 * Vault-relative path of the daily note of `date`. The format is cleaned of
 * traversal segments (".." cannot escape the folder); ".md" is appended.
 */
export function dailyNotePath(date: Date, folder: string, dateFormat: string): string {
  const name = cleanFolder(formatDate(date, dateFormat || "YYYY-MM-DD"));
  const base = cleanFolder(folder);
  return `${base ? `${base}/` : ""}${name || formatDate(date, "YYYY-MM-DD")}.md`;
}

/** The date a daily note path stands for, or null when it is not one. */
export function dateOfDailyNote(path: string, folder: string, dateFormat: string): Date | null {
  const base = cleanFolder(folder);
  const prefix = base ? `${base}/` : "";
  if (!path.toLowerCase().startsWith(prefix.toLowerCase()) || !path.toLowerCase().endsWith(".md")) return null;
  const rest = path.slice(prefix.length, -3);
  return parseDate(rest, dateFormat || "YYYY-MM-DD");
}

/**
 * The closest existing daily note before (`direction: -1`) or after (`1`)
 * `currentPath`; when that is not a daily note (or null), before/after today.
 * Only opens what exists, so navigating never creates empty notes.
 */
export function neighborDailyNote(
  entries: VaultEntry[],
  currentPath: string | null,
  folder: string,
  dateFormat: string,
  direction: -1 | 1,
  now = new Date(),
): string | null {
  const current = currentPath ? dateOfDailyNote(currentPath, folder, dateFormat) : null;
  const pivot = startOfDay(current ?? now).getTime();
  let best: { path: string; time: number } | null = null;
  for (const entry of entries) {
    if (entry.isDir) continue;
    const date = dateOfDailyNote(entry.path, folder, dateFormat);
    if (!date) continue;
    const time = startOfDay(date).getTime();
    if (direction < 0 ? time >= pivot : time <= pivot) continue;
    if (!best || (direction < 0 ? time > best.time : time < best.time)) best = { path: entry.path, time };
  }
  return best?.path ?? null;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
