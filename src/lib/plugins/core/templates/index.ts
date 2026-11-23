// Templates: insert Markdown notes from a template folder at the cursor,
// with {{title}}, {{date}} and {{time}} filled in, or create a new note from
// one via the file explorer's right-click menu.
import { FilePlus2, LayoutTemplate } from "@lucide/svelte";
import { ui } from "../../../ui.svelte";
import type { Plugin } from "../../types";
import { canInsert } from "./actions";
import { TEMPLATE_PICKER } from "./modal";
import { pickerState } from "./pickerState";
import { templateSettings } from "./settings";
import TemplatePicker from "./TemplatePicker.svelte";
import TemplateSettings from "./TemplateSettings.svelte";

export const templatesPlugin: Plugin = {
  manifest: {
    id: "templates",
    name: "Templates",
    description: "Insert Markdown templates at the cursor or create new notes from them.",
    version: "1.0.0",
  },
  icon: LayoutTemplate,
  async onload(ctx) {
    await templateSettings.load(ctx);
    ctx.addOverlay({ id: TEMPLATE_PICKER, component: TemplatePicker });
    ctx.addSettingTab({ component: TemplateSettings });
    ctx.addCommand({
      id: "insert",
      name: "Insert template",
      hotkeys: [{ mod: true, shift: true, key: "i" }],
      when: canInsert,
      run: () => {
        pickerState.openInsert();
        ui.modal = TEMPLATE_PICKER;
      },
    });
    ctx.addCommand({
      id: "create",
      name: "New note from template",
      run: () => {
        pickerState.openCreate("");
        ui.modal = TEMPLATE_PICKER;
      },
    });
    // Offered on folders and on the empty area of the explorer (vault root).
    ctx.addFileMenu({
      id: "new-from-template",
      items: ({ entry }) =>
        entry && !entry.isDir
          ? []
          : [
              {
                label: "New note from template",
                icon: FilePlus2,
                action: () => {
                  pickerState.openCreate(entry?.path ?? "");
                  ui.modal = TEMPLATE_PICKER;
                },
              },
            ],
    });
    ctx.register(() => {
      if (ui.modal === TEMPLATE_PICKER) ui.modal = null;
    });
  },
};
