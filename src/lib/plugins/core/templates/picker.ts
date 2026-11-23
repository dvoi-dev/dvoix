// The list of the template picker, without UI: the notes of the template
// folder, filtered by a fuzzy query and labelled relative to that folder.
// Kept out of the component so the ordering and the labels can be tested.
import type { VaultEntry } from "../../../api";
import { fuzzyMatch } from "../../../fuzzy";
import { cleanFolder } from "../../../attachments";
import { templatesInFolder } from "../../../templates";

/** How many templates the picker shows at most; the rest is found by typing. */
export const PICKER_LIMIT = 60;

export interface TemplateOption {
  path: string;
  /** Shown and searched: the path below the template folder, without ".md". */
  label: string;
  /** Indices of the matched characters in `label`, for highlighting. */
  indices: number[];
}

/**
 * The templates offered for `query`: without a query all of them in path
 * order, with one only the matches, best first. `folder` is the template
 * folder setting; "" means the vault root.
 */
export function templateOptions(entries: VaultEntry[], folder: string, query: string): TemplateOption[] {
  const base = cleanFolder(folder);
  const prefix = base ? `${base}/` : "";
  const q = query.trim();
  const scored: { option: TemplateOption; score: number }[] = [];
  for (const note of templatesInFolder(entries, base)) {
    const label = note.path.slice(prefix.length).replace(/\.md$/i, "");
    const match = fuzzyMatch(q, label);
    if (match) scored.push({ option: { path: note.path, label, indices: match.indices }, score: match.score });
  }
  if (q) scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, PICKER_LIMIT).map((s) => s.option);
}

/**
 * Name of a new note created from a template: its own name, with " 2", " 3", …
 * when that is taken in the target folder (like the file explorer does).
 */
export function freeNoteName(entries: VaultEntry[], folder: string, base: string): string {
  const target = folder ? `${folder}/` : "";
  const taken = new Set(entries.map((e) => e.path.toLowerCase()));
  let candidate = base;
  for (let n = 2; taken.has(`${target}${candidate}.md`.toLowerCase()); n++) candidate = `${base} ${n}`;
  return candidate;
}