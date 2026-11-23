// The core plugins: optional functions that ship with the app and can be turned
// off in the settings. Basic functions that are always there live in
// `src/lib/features/` instead. Order = load order (also the order in the
// settings list). See `../types.ts` for what a plugin can register.
import type { Plugin } from "../types";
import { hiddenFilesPlugin } from "./hidden-files";
import { bookmarksPlugin } from "./bookmarks";
import { templatesPlugin } from "./templates";
import { dailyNotesPlugin } from "./daily-notes";
import { tasksPlugin } from "./tasks";
import { canvasPlugin } from "./canvas";
import { graphPlugin } from "./graph";
import { rightSidebarPlugin } from "./right-sidebar";

export const corePlugins: Plugin[] = [
  hiddenFilesPlugin,
  bookmarksPlugin,
  templatesPlugin,
  dailyNotesPlugin,
  tasksPlugin,
  canvasPlugin,
  graphPlugin,
  rightSidebarPlugin,
];
