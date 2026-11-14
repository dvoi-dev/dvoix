// Core feature: Trash panel in the sidebar for browsing `.trash/` and restoring deleted items.
import { Trash2 } from "@lucide/svelte";
import type { Plugin } from "../../plugins/types";
import { ui } from "../../ui.svelte";
import TrashActions from "./TrashActions.svelte";
import TrashPanel from "./TrashPanel.svelte";
import { trashState } from "./state.svelte";

export const trashFeature: Plugin = {
  manifest: {
    id: "trash",
    name: "Trash",
    description: "View deleted files and folders in .trash/, restore them, or delete them permanently.",
    version: "1.0.0",
  },
  icon: Trash2,
  async onload(ctx) {
    ctx.addPanel({
      id: "trash",
      label: "Trash",
      icon: Trash2,
      component: TrashPanel,
      actions: TrashActions,
      order: 50,
    });
    ctx.addCommand({
      id: "open",
      name: "Open trash",
      run: () => ui.showPanel("trash"),
    });
    ctx.register(await trashState.watch());
    void trashState.refresh();
  },
};
