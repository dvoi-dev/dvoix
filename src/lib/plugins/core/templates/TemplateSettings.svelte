<script lang="ts">
  // Settings of the templates plugin: folder, date and time format, with a
  // live preview of what {{date}} and {{time}} expand to right now.
  import { cleanFolder } from "../../../attachments";
  import Setting from "../../../components/settings/Setting.svelte";
  import { formatDate, templatesInFolder } from "../../../templates";
  import { vault } from "../../../vault.svelte";
  import { templateSettings } from "./settings";

  const input = "w-56 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-violet-500";
  // Literal token names: braces in markup would be read as expressions.
  const dateToken = "{{date}}";
  const timeToken = "{{time}}";

  const s = $derived(templateSettings.value);
  const count = $derived(templatesInFolder(vault.entries, s.folder).length);
  const preview = $derived(`{{date}} → ${formatDate(new Date(), s.dateFormat || "YYYY-MM-DD")}, {{time}} → ${formatDate(new Date(), s.timeFormat || "HH:mm")}`);

  function setFolder(value: string) {
    templateSettings.value.folder = cleanFolder(value);
    templateSettings.save();
    return templateSettings.value.folder;
  }
  function setDateFormat(value: string) {
    templateSettings.value.dateFormat = value.trim() || "YYYY-MM-DD";
    templateSettings.save();
    return templateSettings.value.dateFormat;
  }
  function setTimeFormat(value: string) {
    templateSettings.value.timeFormat = value.trim() || "HH:mm";
    templateSettings.save();
    return templateSettings.value.timeFormat;
  }
</script>

<Setting
  name="Template folder"
  description="Notes in this vault folder (subfolders included) are offered as templates. {count} found."
>
  <input
    class={input}
    aria-label="Template folder"
    value={s.folder}
    placeholder="Templates"
    onchange={(e) => (e.currentTarget.value = setFolder(e.currentTarget.value))}
  />
</Setting>
<Setting name="Date format" description="For {dateToken}. Tokens: YYYY, MM, DD, MMMM, dddd, … (like Obsidian). {preview}">
  <input
    class={input}
    aria-label="Date format"
    value={s.dateFormat}
    placeholder="YYYY-MM-DD"
    onchange={(e) => (e.currentTarget.value = setDateFormat(e.currentTarget.value))}
  />
</Setting>
<Setting name="Time format" description="For {timeToken}. Tokens: HH, mm, ss, …">
  <input
    class={input}
    aria-label="Time format"
    value={s.timeFormat}
    placeholder="HH:mm"
    onchange={(e) => (e.currentTarget.value = setTimeFormat(e.currentTarget.value))}
  />
</Setting>
