// Loads, applies, and manages user CSS snippets in `<vault>/.dvoix/snippets/*.css`.
import { api } from "./api";
import { settings } from "./settings.svelte";

const SNIPPET_DIR = "snippets";

const DEFAULT_SNIPPET_CSS = `/* Custom CSS snippet for dvoix.
 * Edit variables from src/app.css or style .reading .prose, tabs, and panels.
 */
`;

/** Sanitizes a user-typed snippet name into `<name>.css`, or null if invalid. */
export function normalizeSnippetName(raw: string): string | null {
  let name = raw.trim();
  if (!name) return null;
  if (!name.toLowerCase().endsWith(".css")) name = `${name}.css`;
  if (name.startsWith(".") || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  if (name.length <= 4) return null;
  return name;
}

class SnippetStore {
  /** Available `.css` filenames in `.dvoix/snippets/`, sorted case-insensitively. */
  files = $state<string[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  private styles = new Map<string, HTMLStyleElement>();
  private generation = 0;

  isEnabled(file: string): boolean {
    return settings.appearance.cssSnippets.includes(file);
  }

  /** Lists `.dvoix/snippets/` and applies all enabled snippets to `document.head`. */
  async refresh() {
    const run = ++this.generation;
    this.loading = true;
    this.error = null;
    try {
      const files = await api.listSnippets();
      if (run !== this.generation) return;
      this.files = files;
      await this.syncStyles(run);
    } catch (e) {
      if (run === this.generation) this.error = String(e);
    } finally {
      if (run === this.generation) this.loading = false;
    }
  }

  async setEnabled(file: string, on: boolean) {
    const current = settings.appearance.cssSnippets;
    const next = on ? (current.includes(file) ? current : [...current, file]) : current.filter((f) => f !== file);
    settings.appearance.cssSnippets = next;
    settings.saveAppearance();
    await this.syncStyles(this.generation);
  }

  async read(file: string): Promise<string> {
    return (await api.readConfig(`${SNIPPET_DIR}/${file}`)) ?? "";
  }

  async create(rawName: string, content = DEFAULT_SNIPPET_CSS): Promise<string> {
    const file = normalizeSnippetName(rawName);
    if (!file) throw new Error("Snippet name must be a valid filename without slashes or leading dots.");
    if (this.files.some((f) => f.toLowerCase() === file.toLowerCase())) {
      throw new Error(`A snippet named "${file}" already exists.`);
    }
    await api.writeConfig(`${SNIPPET_DIR}/${file}`, content);
    if (!this.isEnabled(file)) {
      settings.appearance.cssSnippets = [...settings.appearance.cssSnippets, file];
      settings.saveAppearance();
    }
    await this.refresh();
    return file;
  }

  async save(file: string, css: string) {
    await api.writeConfig(`${SNIPPET_DIR}/${file}`, css);
    const existing = this.styles.get(file);
    if (existing) existing.textContent = css;
    else if (this.isEnabled(file)) await this.syncStyles(this.generation);
  }

  clear() {
    this.generation++;
    for (const el of this.styles.values()) el.remove();
    this.styles.clear();
    this.files = [];
    this.error = null;
    this.loading = false;
  }

  private async syncStyles(run: number) {
    const available = new Set(this.files);
    const enabled = settings.appearance.cssSnippets.filter((f) => available.has(f));
    const enabledSet = new Set(enabled);

    for (const [file, el] of this.styles) {
      if (!enabledSet.has(file)) {
        el.remove();
        this.styles.delete(file);
      }
    }

    const loaded = await Promise.all(
      enabled.map(async (file) => ({
        file,
        css: await api.readConfig(`${SNIPPET_DIR}/${file}`).catch(() => null),
      })),
    );
    if (run !== this.generation) return;

    // Re-append in deterministic order so CSS cascade matches the list order.
    for (const { file, css } of loaded) {
      if (css === null) continue;
      let el = this.styles.get(file);
      if (!el) {
        el = document.createElement("style");
        el.dataset.dvoixSnippet = file;
        this.styles.set(file, el);
      }
      el.textContent = css;
      document.head.append(el);
    }
  }
}

export const snippets = new SnippetStore();
