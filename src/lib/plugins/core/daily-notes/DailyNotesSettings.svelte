<script lang="ts">
  // Settings of the daily notes plugin: folder, file name format (may contain
  // folders) and an optional template, with a live preview of today's path.
  import { cleanFolder } from "../../../attachments";
  import Select from "../../../components/Select.svelte";
  import Setting from "../../../components/settings/Setting.svelte";
  import { vault } from "../../../vault.svelte";
  import { dailyNotePath } from "./paths";
  import { dailySettings } from "./settings";

  const input = "w-56 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-violet-500";
  // Literal token names: braces in markup would be read as expressions.
  const tokens = "{{title}}, {{date}} and {{time}}";

  const s = $derived(dailySettings.value);
  const preview = $derived(dailyNotePath(new Date(), s.folder, s.dateFormat));
  const templateOptions = $derived([
    { value: "", label: "None (plain heading)" },
    ...vault.entries
      .filter((e) => !e.isDir && e.path.toLowerCase().endsWith(".md"))
      .map((e) => ({ value: e.path, label: e.path.replace(/\.md$/i, "") }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]);
</script>

<Setting name="Daily notes folder" description="Vault folder for daily notes. It is created when needed. Today: {preview}">
  <input
    class={input}
    aria-label="Daily notes folder"
    value={s.folder}
    placeholder="Daily"
    onchange={(e) => {
      dailySettings.value.folder = cleanFolder(e.currentTarget.value);
      e.currentTarget.value = dailySettings.value.folder;
      dailySettings.save();
    }}
  />
</Setting>
<Setting
  name="Date format"
  description="File name of a daily note, tokens like YYYY-MM-DD (as in Obsidian). Folders are allowed, e.g. YYYY/MM/YYYY-MM-DD."
>
  <input
    class={input}
    aria-label="Date format"
    value={s.dateFormat}
    placeholder="YYYY-MM-DD"
    onchange={(e) => {
      dailySettings.value.dateFormat = e.currentTarget.value.trim() || "YYYY-MM-DD";
      e.currentTarget.value = dailySettings.value.dateFormat;
      dailySettings.save();
    }}
  />
</Setting>
<Setting
  name="Template"
  description="Note used as the template for new daily notes. {tokens} are filled in; works without the Templates plugin."
>
  <Select
    label="Template"
    class="w-56"
    value={s.templatePath}
    options={templateOptions}
    onchange={(v) => {
      dailySettings.value.templatePath = v;
      dailySettings.save();
    }}
  />
</Setting>
