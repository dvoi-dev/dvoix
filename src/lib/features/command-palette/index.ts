// The command palette makes every registered command discoverable, including
// commands that have no default shortcut. Settings is a command too, so its
// shortcut can be rebound like the rest.
import { SquareTerminal } from "@lucide/svelte";
import type { Plugin } from "../../plugins/types";
import { ui, SETTINGS } from "../../ui.svelte";
import CommandPalette from "./CommandPalette.svelte";

export const commandPaletteFeature: Plugin = {
  manifest: {
    id: "command-palette",
    name: "Command palette",
    description: "Search and run every available command.",
    version: "1.0.0",
  },
  icon: SquareTerminal,
  onload(ctx) {
    ctx.addOverlay({ id: "palette", component: CommandPalette });
    ctx.addCommand({
      id: "open",
      name: "Open command palette",
      hotkeys: [{ mod: true, key: "p" }],
      run: () => ui.toggleModal("command-palette"),
    });
    ctx.addCommand({
      id: "settings",
      name: "Open settings",
      hotkeys: [{ mod: true, key: "," }],
      inModal: true,
      run: () => ui.toggleModal(SETTINGS),
    });
  },
};
