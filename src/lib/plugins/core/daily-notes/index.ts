// Daily notes: one note per day, opened or created from the ribbon or the
// command palette, with commands for the neighboring existing notes. The
// optional template uses the same variables as the Templates plugin, through
// the shared engine in `src/lib/templates.ts` (works with Templates off).
import { CalendarDays } from "@lucide/svelte";
import type { Plugin } from "../../types";
import { openNeighbor, openToday } from "./actions";
import DailyNotesSettings from "./DailyNotesSettings.svelte";
import { dailySettings } from "./settings";

export const dailyNotesPlugin: Plugin = {
  manifest: {
    id: "daily-notes",
    name: "Daily notes",
    description: "Open or create a note for today, with commands for the previous and next daily note.",
    version: "1.0.0",
  },
  icon: CalendarDays,
  async onload(ctx) {
    await dailySettings.load(ctx);
    ctx.addRibbonAction({ id: "open-today", label: "Open today's daily note", icon: CalendarDays, action: () => void openToday(), order: 35 });
    ctx.addSettingTab({ component: DailyNotesSettings });
    ctx.addCommand({
      id: "open-today",
      name: "Open today's daily note",
      hotkeys: [{ mod: true, shift: true, key: "d" }],
      run: () => openToday(),
    });
    ctx.addCommand({
      id: "open-previous",
      name: "Open previous daily note",
      hotkeys: [{ mod: true, alt: true, key: "ArrowLeft" }],
      run: () => openNeighbor(-1),
    });
    ctx.addCommand({
      id: "open-next",
      name: "Open next daily note",
      hotkeys: [{ mod: true, alt: true, key: "ArrowRight" }],
      run: () => openNeighbor(1),
    });
  },
};
