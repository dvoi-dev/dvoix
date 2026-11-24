// Wording for the vault-wide replace: the preview/confirmation and the toast
// after it. Pure functions, so the counts read the same everywhere.
import type { ReplaceOutcome } from "../../api";

const plural = (count: number, singular: string, pluralForm: string) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/** "3 matches in 2 notes" (or the singular forms). */
export function replaceSummary(outcome: Pick<ReplaceOutcome, "paths" | "replacements">): string {
  return `${plural(outcome.replacements, "match", "matches")} in ${plural(outcome.paths.length, "note", "notes")}`;
}

/** The question shown before anything is written. */
export function replaceQuestion(outcome: Pick<ReplaceOutcome, "paths" | "replacements">): string {
  return `Replace ${replaceSummary(outcome)}? Only the affected lines change.`;
}

/** The message of the undo toast after a successful replacement. */
export function replaceDone(outcome: Pick<ReplaceOutcome, "paths" | "replacements">): string {
  return `Replaced ${replaceSummary(outcome)}`;
}
