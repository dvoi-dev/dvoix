// Typed wrappers around the Rust commands in `src-tauri/src/commands.rs`.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface VaultInfo {
  name: string;
  path: string;
}

export interface VaultEntry {
  path: string;
  name: string;
  extension: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface TrashedEntry {
  name: string;
  trashPath: string;
  originalPath: string | null;
  isDir: boolean;
  size: number;
  deletedAt: number;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}

export interface NoteSummary {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

export interface TagCount {
  tag: string;
  count: number;
}

/** Everything the graph view needs (see `Index::graph` in `crates/dvoix-core/src/index.rs`). */
export interface GraphData {
  notes: { path: string; title: string; tags: string[] }[];
  /** `target` is the link text as written (lower-cased), not yet resolved to a file. */
  links: { source: string; target: string }[];
}

export type Priority = "high" | "medium" | "low";

/** A markdown checkbox somewhere in the vault (see `crates/dvoix-core/src/tasks.rs`). */
export interface TaskItem {
  path: string;
  noteTitle: string;
  /** 0-based line in the file. */
  line: number;
  done: boolean;
  text: string;
  due: string | null;
  priority: Priority | null;
  tags: string[];
  indent: number;
}

export interface VaultChange {
  kind: "created" | "modified" | "removed";
  path: string;
  /** In a hidden folder or a dot-file; only of interest to the hidden-files plugin. */
  hidden: boolean;
  /**
   * The entry of the path, as far as it could be read: its size and the time
   * it was changed. Missing when the file is gone, so the list of the vault
   * can be corrected without listing the whole vault again.
   */
  entry?: VaultEntry;
}

/** Which hidden entries `listHiddenEntries` returns (see `dvoix_core::HiddenFilter`). */
export interface HiddenFilter {
  includeFiles: boolean;
  includeAppDir: boolean;
  exclude: string[];
}

/** A note rendered for the reading view (see `dvoix_core::markdown::render`). */
export interface RenderedNote {
  /** The body as HTML, without the frontmatter. */
  html: string;
  /** Frontmatter as JSON, shown as properties. */
  frontmatter: Record<string, unknown>;
}

/** What a store plugin may use of the API (see `dvoix_core::store::PERMISSIONS`). */
export type PluginPermission = "vault:read" | "vault:write" | "editor" | "process";

/** Output of a program started for a plugin (see `src-tauri/src/process.rs`). */
export type ProcessEvent =
  | { event: "stdout"; data: string }
  | { event: "stderr"; data: string }
  | { event: "exit"; data: number | null };

/** The `manifest.json` of a store plugin (see `dvoix_core::store::PluginManifest`). */
export interface StoreManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  minAppVersion?: string;
  permissions: PluginPermission[];
}

/** One plugin in the plugin list (see `dvoix_core::store::RegistryEntry`). */
export interface RegistryEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  /** GitHub repository `owner/name`. */
  repo: string;
  channel: "official" | "community";
  /** The release the store installs (its tag). */
  version: string;
  /** SHA-256 of every file of that release, by file name; checked before installing. */
  sha256: Record<string, string>;
}

/** One release of a plugin with its notes (see `dvoix_core::store::ReleaseNote`). */
export interface ReleaseNote {
  version: string;
  name: string | null;
  /** Markdown as the author wrote it; shown as plain text. */
  notes: string;
  published: string | null;
}

/** A plugin in `.dvoix/plugins/<id>/` (see `dvoix_core::store::InstalledPlugin`). */
export interface InstalledPlugin {
  manifest: StoreManifest;
  hasStyles: boolean;
}

export const api = {
  lastVault: () => invoke<string | null>("last_vault"),
  openVault: (path: string) => invoke<VaultInfo>("open_vault", { path }),
  closeVault: () => invoke<void>("close_vault"),
  /** Starts a program in the vault folder; returns its id for `processKill`. */
  processSpawn: (
    command: string,
    args: string[],
    stdin: string | null,
    env: Record<string, string> | null,
    onEvent: (e: ProcessEvent) => void,
  ) => {
    const channel = new Channel<ProcessEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("process_spawn", { command, args, stdin, env, onEvent: channel });
  },
  processKill: (id: number) => invoke<void>("process_kill", { id }),
  listEntries: () => invoke<VaultEntry[]>("list_entries"),
  listHiddenEntries: (filter: HiddenFilter) => invoke<VaultEntry[]>("list_hidden_entries", { filter }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<VaultEntry>("write_file", { path, content }),
  renderMarkdown: (content: string) => invoke<RenderedNote>("render_markdown", { content }),
  createFile: (path: string, content: string) => invoke<VaultEntry>("create_file", { path, content }),
  /** Reads any file as bytes (images and other attachments). */
  readBinary: (path: string) => invoke<ArrayBuffer>("read_binary", { path }),
  /** Creates a binary file; fails if it exists. The bytes travel as the raw request body. */
  createBinary: (path: string, bytes: Uint8Array) =>
    invoke<VaultEntry>("create_binary", bytes, { headers: { path: encodeURIComponent(path) } }),
  createFolder: (path: string) => invoke<VaultEntry>("create_folder", { path }),
  renameEntry: (from: string, to: string) => invoke<VaultEntry>("rename_entry", { from, to }),
  trashEntry: (path: string) => invoke<TrashedEntry>("trash_entry", { path }),
  listTrash: () => invoke<TrashedEntry[]>("list_trash"),
  restoreTrashEntry: (name: string, target: string | null = null, renameOnConflict = false) =>
    invoke<VaultEntry>("restore_trash_entry", { name, target, renameOnConflict }),
  deleteTrashEntry: (name: string) => invoke<void>("delete_trash_entry", { name }),
  emptyTrash: () => invoke<void>("empty_trash"),
  listSnippets: () => invoke<string[]>("list_snippets"),
  search: (query: string) => invoke<SearchHit[]>("search", { query }),
  tags: () => invoke<TagCount[]>("tags"),
  notesWithTag: (tag: string) => invoke<NoteSummary[]>("notes_with_tag", { tag }),
  notesWhere: (key: string, value: string) => invoke<NoteSummary[]>("notes_where", { key, value }),
  backlinks: (path: string) => invoke<NoteSummary[]>("backlinks", { path }),
  graph: () => invoke<GraphData>("graph"),
  /** The graph data of only these notes; a path missing from the answer is not a note (anymore). */
  graphNotes: (paths: string[]) => invoke<GraphData>("graph_notes", { paths }),
  tasks: () => invoke<TaskItem[]>("tasks"),
  setTaskDone: (path: string, line: number, text: string, done: boolean) =>
    invoke<VaultEntry>("set_task_done", { path, line, text, done }),
  readConfig: (path: string) => invoke<string | null>("read_config", { path }),
  writeConfig: (path: string, content: string) => invoke<void>("write_config", { path, content }),
  rebuildIndex: () => invoke<number>("rebuild_index"),


  storeRegistry: () => invoke<RegistryEntry[]>("store_registry"),
  /** The manifest of the release the entry pins, checked against its checksum. */
  storeManifest: (entry: RegistryEntry) => invoke<StoreManifest>("store_manifest", { entry }),
  /** Release notes of the newest releases of a repository, newest first. */
  storeChangelog: (repo: string) => invoke<ReleaseNote[]>("store_changelog", { repo }),
  /** Installs the release the entry pins; refused if a file does not match its checksum. */
  storeInstall: (entry: RegistryEntry) => invoke<StoreManifest>("store_install", { entry }),
  storeUninstall: (id: string) => invoke<void>("store_uninstall", { id }),
  storeInstalled: () => invoke<InstalledPlugin[]>("store_installed"),
};

/**
 * The vault changed on disk. The backend sends one event per batch of
 * changes (see `Workspace::open` in `src-tauri/src/lib.rs`), so a burst
 * arrives together; a single change is a batch of one.
 */
export function onVaultChanged(handler: (changes: VaultChange[]) => void): Promise<UnlistenFn> {
  return listen<VaultChange[]>("vault://changed", (e) => handler(e.payload));
}
