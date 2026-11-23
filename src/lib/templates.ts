// Template variables and date formats, shared by the core plugins "templates"
// and "daily-notes" (a plugin must not import from another plugin's folder).
// Pure logic: no vault access, no UI. The date tokens follow the moment.js
// conventions Obsidian uses, so formats can be copied from there:
// YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd, ddd, HH, H, mm, m, ss, s.
// Text in square brackets stays as it is ("[Daily]/YYYY-MM-DD"), everything
// outside tokens is literal. Names of months and weekdays are always English.
import type { VaultEntry } from "./api";
import { cleanFolder } from "./attachments";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Longest tokens first, so "MMMM" is not read as "MM" + "MM". */
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|m|ss|s/g;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Formats a date with tokens like `YYYY-MM-DD` (local time). */
export function formatDate(date: Date, pattern: string): string {
  return pattern.replace(TOKEN, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "YYYY": return String(date.getFullYear()).padStart(4, "0");
      case "YY": return pad2(date.getFullYear() % 100);
      case "MMMM": return MONTHS[date.getMonth()];
      case "MMM": return MONTHS[date.getMonth()].slice(0, 3);
      case "MM": return pad2(date.getMonth() + 1);
      case "M": return String(date.getMonth() + 1);
      case "DD": return pad2(date.getDate());
      case "D": return String(date.getDate());
      case "dddd": return WEEKDAYS[date.getDay()];
      case "ddd": return WEEKDAYS[date.getDay()].slice(0, 3);
      case "HH": return pad2(date.getHours());
      case "H": return String(date.getHours());
      case "mm": return pad2(date.getMinutes());
      case "m": return String(date.getMinutes());
      case "ss": return pad2(date.getSeconds());
      case "s": return String(date.getSeconds());
      default: return token;
    }
  });
}

/** What each capture group of a `parseDate` pattern means. */
type Part = "year" | "shortYear" | "month" | "monthName" | "day" | "hour" | "minute" | "second" | null;

const escapeLiteral = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads a date written with `pattern` (the inverse of `formatDate`); null when
 * the text does not fit or is not a real date (e.g. February 30). The pattern
 * must contain a year, a month and a day token; weekday tokens are matched but
 * ignored. Used to find the neighboring daily note of one that is open.
 */
export function parseDate(text: string, pattern: string): Date | null {
  let source = "^";
  let last = 0;
  const parts: Part[] = [];
  const group = (part: Part, re: string) => {
    parts.push(part);
    return `(${re})`;
  };
  // A fresh matcher: `TOKEN` is global and shared with `formatDate`, so its
  // `lastIndex` must not decide where this pattern is read from.
  const tokens = new RegExp(TOKEN.source, "g");
  for (const m of pattern.matchAll(tokens)) {
    source += escapeLiteral(pattern.slice(last, m.index));
    last = m.index + m[0].length;
    const token = m[0];
    if (m[1] !== undefined) source += escapeLiteral(m[1]);
    else if (token === "YYYY") source += group("year", "\\d{4}");
    else if (token === "YY") source += group("shortYear", "\\d{2}");
    else if (token === "MMMM") source += group("monthName", MONTHS.join("|"));
    else if (token === "MMM") source += group("monthName", MONTHS.map((n) => n.slice(0, 3)).join("|"));
    else if (token === "MM") source += group("month", "\\d{2}");
    else if (token === "M") source += group("month", "\\d{1,2}");
    else if (token === "DD") source += group("day", "\\d{2}");
    else if (token === "D") source += group("day", "\\d{1,2}");
    else if (token === "dddd") source += group(null, WEEKDAYS.join("|"));
    else if (token === "ddd") source += group(null, WEEKDAYS.map((n) => n.slice(0, 3)).join("|"));
    else if (token === "HH" || token === "H") source += group("hour", "\\d{1,2}");
    else if (token === "mm" || token === "m") source += group("minute", "\\d{1,2}");
    else if (token === "ss" || token === "s") source += group("second", "\\d{1,2}");
  }
  source += escapeLiteral(pattern.slice(last)) + "$";
  const match = new RegExp(source).exec(text);
  if (!match) return null;
  const values: Partial<Record<Exclude<Part, null>, number>> = {};
  parts.forEach((part, i) => {
    if (!part) return;
    const raw = match[i + 1];
    values[part] = part === "monthName" ? MONTHS.findIndex((n) => n === raw || n.slice(0, 3) === raw) + 1 : Number(raw);
  });
  if (values.shortYear !== undefined) values.year = 2000 + values.shortYear;
  if (values.monthName !== undefined) values.month = values.monthName;
  const { year, month, day, hour = 0, minute = 0, second = 0 } = values;
  if (year === undefined || !month || !day) return null;
  if (month > 12 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  // setFullYear keeps years below 100 (new Date(26, ...) would mean 1926).
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  // Rejects days that rolled over into the next month (2026-02-30 -> March 2).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export interface TemplateVars {
  /** Note title for `{{title}}` (file name without ".md"). */
  title: string;
  /** The moment `{{date}}` and `{{time}}` refer to. */
  now: Date;
  dateFormat: string;
  timeFormat: string;
}

/**
 * Fills the variables of a template: `{{title}}`, `{{date}}`, `{{time}}`, each
 * optionally with its own format (`{{date:YYYY}}`). Unknown placeholders stay
 * as they are, so a template can contain `{{...}}` for other tools.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (whole, inner: string) => {
    const colon = inner.indexOf(":");
    const name = (colon < 0 ? inner : inner.slice(0, colon)).trim();
    const format = colon < 0 ? undefined : inner.slice(colon + 1).trim();
    switch (name) {
      case "title": return vars.title;
      case "date": return formatDate(vars.now, format || vars.dateFormat);
      case "time": return formatDate(vars.now, format || vars.timeFormat);
      default: return whole;
    }
  });
}

/** The title of a note: its file name without folders and without ".md". */
export function noteTitle(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The notes of the template folder (including its subfolders), sorted like the
 * picker shows them: by the path below the folder without ".md", naturally
 * ("Note 2" before "Note 10"). Comparing the raw paths would let the extension
 * reorder siblings ("Meeting-Planning" before "Meeting").
 * `folder` is cleaned like a user-typed folder setting; "" means the vault root.
 */
export function templatesInFolder(entries: VaultEntry[], folder: string): VaultEntry[] {
  const prefix = cleanFolder(folder).toLowerCase();
  const withSlash = prefix ? `${prefix}/` : "";
  return entries
    .filter((e) => !e.isDir && e.path.toLowerCase().endsWith(".md") && e.path.toLowerCase().startsWith(withSlash))
    .map((entry) => ({ entry, key: entry.path.slice(withSlash.length, -3) }))
    .sort((a, b) => collator.compare(a.key, b.key))
    .map((k) => k.entry);
}
