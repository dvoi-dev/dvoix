//! Access to the vault folder. All paths exchanged with the outside world are
//! relative to the vault root and use `/` as separator, on every platform.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::{APP_DIR, Error, Result};

/// Folder (inside the vault) that deleted files are moved to, like in Obsidian.
pub const TRASH_DIR: &str = ".trash";

/// Metadata file inside `.dvoix/` mapping trashed entry names to their original vault paths.
const TRASH_META_FILE: &str = "trash.json";

/// Folder inside `.dvoix/` for user CSS snippets.
pub const SNIPPETS_DIR: &str = "snippets";

/// Upper bound for `Vault::list_hidden`: a hidden folder like `node_modules`
/// or `.git` can hold tens of thousands of files, and the explorer would
/// freeze on all of them. What lies beyond is simply not listed.
pub const MAX_HIDDEN_ENTRIES: usize = 10_000;

/// The entry of a path with the metadata that is already known about it.
fn entry_of(rel: &str, meta: &fs::Metadata) -> VaultEntry {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let extension = if meta.is_dir() {
        String::new()
    } else {
        match Path::new(rel).extension().and_then(|e| e.to_str()) {
            // Most extensions are already lower-case ASCII; only then is no
            // second copy needed. Non-ASCII always goes through
            // `to_lowercase`, which knows more characters than ASCII does.
            Some(e) if e.is_ascii() && !e.bytes().any(|b| b.is_ascii_uppercase()) => e.to_string(),
            Some(e) => e.to_lowercase(),
            None => String::new(),
        }
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    VaultEntry {
        path: rel.to_string(),
        name: name.to_string(),
        extension,
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified,
    }
}

/// True for names of hidden files and folders (`.git`, `.dvoix`, ...). Looks
/// at the bytes, so no copy of the name is made for every entry of a walk.
#[cfg(unix)]
fn is_dot_name(name: &std::ffi::OsStr) -> bool {
    use std::os::unix::ffi::OsStrExt;
    name.as_bytes().first() == Some(&b'.')
}

#[cfg(not(unix))]
fn is_dot_name(name: &std::ffi::OsStr) -> bool {
    name.as_encoded_bytes().first() == Some(&b'.')
}

/// The key the listings are sorted by: the path in lower case, built once
/// per entry instead of once per comparison. Plain ASCII paths (almost all)
/// only need the copy itself, without the Unicode machinery.
fn sort_key(entry: &VaultEntry) -> String {
    if entry.path.is_ascii() {
        entry.path.to_ascii_lowercase()
    } else {
        entry.path.to_lowercase()
    }
}

/// Which hidden entries `Vault::list_hidden` returns. Set by the
/// "Hidden files" plugin from its settings.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenFilter {
    /// Also dot-files (`.gitignore`), not only dot-folders and their content.
    pub include_files: bool,
    /// Also dvoix's own `.dvoix/` folder.
    pub include_app_dir: bool,
    /// Names that stay hidden anyway, wherever they occur (e.g. `.git`).
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    /// Path relative to the vault root, `/`-separated.
    pub path: String,
    pub name: String,
    /// Lower-case extension without the dot, empty for folders and files without one.
    pub extension: String,
    pub is_dir: bool,
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch.
    pub modified: u64,
}

/// A file's text together with the disk state it was read at. The editor
/// keeps the entry as its save base: a later write can prove with it that
/// nobody else changed the file in between (see `Vault::write_checked`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    pub content: String,
    pub entry: VaultEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashedEntry {
    /// Entry name inside `.trash/` (e.g. `inbox.md` or `1 inbox.md`).
    pub name: String,
    /// Vault-relative path inside `.trash/` (e.g. `.trash/inbox.md`).
    pub trash_path: String,
    /// Original vault-relative path before deletion, if known from `.dvoix/trash.json`.
    pub original_path: Option<String>,
    pub is_dir: bool,
    pub size: u64,
    /// Deletion time in milliseconds since the Unix epoch (falls back to file modified time).
    pub deleted_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashRecord {
    original_path: String,
    deleted_at: u64,
}

type TrashMeta = HashMap<String, TrashRecord>;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn validate_trash_name(name: &str) -> Result<()> {
    let mut parts = Path::new(name).components();
    match (parts.next(), parts.next()) {
        (Some(Component::Normal(_)), None)
            if name != "." && name != ".." && !name.ends_with(".dvoix-tmp") =>
        {
            Ok(())
        }
        _ => Err(Error::OutsideVault(name.to_string())),
    }
}

fn is_protected_vault_path(rel: &str) -> bool {
    let trimmed = rel.trim();
    trimmed.is_empty()
        || trimmed == TRASH_DIR
        || trimmed.starts_with(".trash/")
        || trimmed == APP_DIR
        || trimmed.starts_with(".dvoix/")
}

impl Vault {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if !root.is_dir() {
            return Err(Error::VaultNotFound(root));
        }
        let root = root.canonicalize()?;
        fs::create_dir_all(root.join(APP_DIR))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn app_dir(&self) -> PathBuf {
        self.root.join(APP_DIR)
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Vault".into())
    }

    /// Resolves a vault-relative path to an absolute one, refusing anything
    /// that would escape the vault.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let rel_path = Path::new(rel);
        let mut out = self.root.clone();
        for c in rel_path.components() {
            match c {
                Component::Normal(part) => out.push(part),
                Component::CurDir => {}
                _ => return Err(Error::OutsideVault(rel.to_string())),
            }
        }
        Ok(out)
    }

    /// Turns an absolute path back into a vault-relative, `/`-separated one.
    pub fn relative(&self, abs: &Path) -> Option<String> {
        let rel = abs.strip_prefix(&self.root).ok()?;
        let mut out = String::with_capacity(rel.as_os_str().len());
        for part in rel.components() {
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(&part.as_os_str().to_string_lossy());
        }
        if out.is_empty() {
            return None;
        }
        Some(out)
    }

    /// True for paths dvoix should never show or index (hidden folders like
    /// `.dvoix`, `.git`, `.trash`, `.obsidian`).
    pub fn is_ignored(rel: &str) -> bool {
        rel.split('/').any(|part| part.starts_with('.'))
    }

    /// All files and folders in the vault (hidden ones excluded), sorted by path.
    pub fn list(&self) -> Result<Vec<VaultEntry>> {
        let mut entries = Vec::new();
        let walker = WalkDir::new(&self.root)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| !is_dot_name(e.file_name()));
        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            // The metadata of the walk is used, so nothing has to be asked
            // from the file system a second time.
            let Some(rel) = self.relative(entry.path()) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            entries.push(entry_of(&rel, &meta));
        }
        // Plain path order; the UI builds the tree and decides how to group it.
        entries.sort_by_cached_key(sort_key);
        Ok(entries)
    }

    /// Only the files below the folder `rel`, sorted by path. The folder
    /// itself is not in the list. Nothing if `rel` is not a folder of the
    /// vault, so a caller does not have to check.
    pub fn files_below(&self, rel: &str) -> Result<Vec<VaultEntry>> {
        let dir = self.resolve(rel)?;
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        let walker = WalkDir::new(&dir)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| !is_dot_name(e.file_name()));
        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(path) = self.relative(entry.path()) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            entries.push(entry_of(&path, &meta));
        }
        entries.sort_by_cached_key(sort_key);
        Ok(entries)
    }

    /// The hidden entries that `list` leaves out: dot-folders with everything
    /// in them and (with `include_files`) dot-files, sorted by path. Only for
    /// showing them; they are never indexed. Temp files of `write` are never
    /// returned, and the list stops at `MAX_HIDDEN_ENTRIES`.
    pub fn list_hidden(&self, filter: &HiddenFilter) -> Result<Vec<VaultEntry>> {
        let mut entries = Vec::new();
        let walker = WalkDir::new(&self.root)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name();
                if filter.exclude.iter().any(|x| x.as_str() == name) {
                    return false;
                }
                let name = name.to_string_lossy();
                if name.ends_with(".dvoix-tmp") {
                    return false;
                }
                !(e.depth() == 1 && name == APP_DIR && !filter.include_app_dir)
            });
        for entry in walker {
            let Ok(entry) = entry else { continue };
            let Some(rel) = self.relative(entry.path()) else {
                continue;
            };
            if !Self::is_ignored(&rel) {
                continue;
            }
            // A dot-file outside a hidden folder only shows with `include_files`.
            let in_hidden_dir = rel
                .rsplit_once('/')
                .is_some_and(|(parent, _)| Self::is_ignored(parent));
            if !entry.file_type().is_dir() && !in_hidden_dir && !filter.include_files {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            entries.push(entry_of(&rel, &meta));
            if entries.len() >= MAX_HIDDEN_ENTRIES {
                break;
            }
        }
        entries.sort_by_cached_key(sort_key);
        Ok(entries)
    }

    /// Only the files of the vault (no folders).
    pub fn files(&self) -> Result<Vec<VaultEntry>> {
        Ok(self.list()?.into_iter().filter(|e| !e.is_dir).collect())
    }

    fn entry_for(&self, rel: &str, abs: &Path) -> Result<VaultEntry> {
        let meta = fs::metadata(abs)?;
        Ok(entry_of(rel, &meta))
    }

    pub fn entry(&self, rel: &str) -> Result<VaultEntry> {
        let abs = self.resolve(rel)?;
        let norm = self.relative(&abs);
        self.entry_for(norm.as_deref().unwrap_or(rel), &abs)
    }

    pub fn read(&self, rel: &str) -> Result<String> {
        Ok(fs::read_to_string(self.resolve(rel)?)?)
    }

    /// Reads a file together with its metadata (size, modification time), so
    /// the caller can detect later external changes before writing.
    pub fn read_with_meta(&self, rel: &str) -> Result<FileRead> {
        let content = self.read(rel)?;
        let entry = self.entry(rel)?;
        Ok(FileRead { content, entry })
    }

    /// Writes atomically: content goes to a temp file first which is then
    /// renamed over the target, so a crash never leaves a half-written note.
    pub fn write(&self, rel: &str, content: &str) -> Result<VaultEntry> {
        self.write_bytes(rel, content.as_bytes())
    }

    /// Writes like `write`, but refuses when the file no longer matches the
    /// state the caller last saw (`expected_modified`/`expected_size` from a
    /// read or an earlier write). An external edit in between then ends in
    /// `Error::Conflict` instead of being silently overwritten. Both values
    /// are compared because some file systems only have whole-second mtimes.
    /// Without expectations this behaves exactly like `write`.
    pub fn write_checked(
        &self,
        rel: &str,
        content: &str,
        expected_modified: Option<u64>,
        expected_size: Option<u64>,
    ) -> Result<VaultEntry> {
        if expected_modified.is_some() || expected_size.is_some() {
            let current = match self.entry(rel) {
                Ok(entry) => Some(entry),
                Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e),
            };
            let matches = current.is_some_and(|entry| {
                expected_modified.is_none_or(|m| entry.modified == m)
                    && expected_size.is_none_or(|s| entry.size == s)
            });
            if !matches {
                return Err(Error::Conflict(rel.to_string()));
            }
        }
        self.write(rel, content)
    }

    /// Reads any file as bytes (images and other attachments).
    pub fn read_bytes(&self, rel: &str) -> Result<Vec<u8>> {
        Ok(fs::read(self.resolve(rel)?)?)
    }

    /// Writes bytes atomically, the same way as `write`.
    pub fn write_bytes(&self, rel: &str, content: &[u8]) -> Result<VaultEntry> {
        let path = self.resolve(rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let tmp = path.with_file_name(format!(".{file_name}.dvoix-tmp"));
        fs::write(&tmp, content)?;
        fs::rename(&tmp, &path)?;
        self.entry(rel)
    }

    /// Creates a new binary file (an attachment) and fails if it already exists.
    pub fn create_bytes(&self, rel: &str, content: &[u8]) -> Result<VaultEntry> {
        if self.resolve(rel)?.exists() {
            return Err(Error::AlreadyExists(rel.to_string()));
        }
        self.write_bytes(rel, content)
    }

    /// Creates a new file and fails if it already exists.
    pub fn create(&self, rel: &str, content: &str) -> Result<VaultEntry> {
        if self.resolve(rel)?.exists() {
            return Err(Error::AlreadyExists(rel.to_string()));
        }
        self.write(rel, content)
    }

    pub fn create_dir(&self, rel: &str) -> Result<VaultEntry> {
        let path = self.resolve(rel)?;
        if path.exists() {
            return Err(Error::AlreadyExists(rel.to_string()));
        }
        fs::create_dir_all(&path)?;
        self.entry(rel)
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<VaultEntry> {
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if dst.exists() {
            return Err(Error::AlreadyExists(to.to_string()));
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(src, dst)?;
        self.entry(to)
    }

    /// Resolves a path inside the vault's `.dvoix/` config folder, e.g.
    /// `app.json` or `plugins/tasks/data.json`. Only plain names are allowed:
    /// no `..`, no absolute paths, no hidden parts.
    pub fn config_path(&self, rel: &str) -> Result<PathBuf> {
        let mut out = self.app_dir();
        let mut parts = 0;
        for c in Path::new(rel).components() {
            match c {
                Component::Normal(part) if !part.to_string_lossy().starts_with('.') => {
                    out.push(part);
                    parts += 1;
                }
                _ => return Err(Error::OutsideVault(rel.to_string())),
            }
        }
        if parts == 0 {
            return Err(Error::OutsideVault(rel.to_string()));
        }
        Ok(out)
    }

    /// Reads a config file from `.dvoix/`; `None` if it does not exist yet.
    pub fn read_config(&self, rel: &str) -> Result<Option<String>> {
        match fs::read_to_string(self.config_path(rel)?) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Writes a config file in `.dvoix/` atomically (temp file, then rename).
    pub fn write_config(&self, rel: &str, content: &str) -> Result<()> {
        let path = self.config_path(rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let tmp = path.with_file_name(format!(".{file_name}.dvoix-tmp"));
        fs::write(&tmp, content)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    fn read_trash_meta(&self) -> (TrashMeta, bool) {
        match self.read_config(TRASH_META_FILE) {
            Ok(Some(text)) => (serde_json::from_str(&text).unwrap_or_default(), true),
            _ => (HashMap::new(), false),
        }
    }

    fn write_trash_meta(&self, meta: &TrashMeta) -> Result<()> {
        let json =
            serde_json::to_string_pretty(meta).map_err(|e| std::io::Error::other(e.to_string()))?;
        self.write_config(TRASH_META_FILE, &(json + "\n"))
    }

    fn free_restore_path(&self, rel: &str, is_dir: bool) -> Result<String> {
        if !self.resolve(rel)?.exists() {
            return Ok(rel.to_string());
        }
        let (parent, name) = match rel.rsplit_once('/') {
            Some((p, n)) => (Some(p), n),
            None => (None, rel),
        };
        let (stem, ext) = if !is_dir {
            match name.rsplit_once('.') {
                Some((s, e)) if !s.is_empty() => (s, Some(e)),
                _ => (name, None),
            }
        } else {
            (name, None)
        };
        for n in 2.. {
            let candidate_name = match ext {
                Some(e) => format!("{stem} {n}.{e}"),
                None => format!("{stem} {n}"),
            };
            let candidate = match parent {
                Some(p) => format!("{p}/{candidate_name}"),
                None => candidate_name,
            };
            if !self.resolve(&candidate)?.exists() {
                return Ok(candidate);
            }
        }
        unreachable!()
    }

    /// Moves a file or folder into the vault's `.trash` folder instead of
    /// deleting it for good, recording its original path in `.dvoix/trash.json`.
    pub fn trash(&self, rel: &str) -> Result<TrashedEntry> {
        if is_protected_vault_path(rel) {
            return Err(Error::OutsideVault(rel.to_string()));
        }
        let src = self.resolve(rel)?;
        let trash = self.root.join(TRASH_DIR);
        fs::create_dir_all(&trash)?;
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() {
            return Err(Error::OutsideVault(rel.to_string()));
        }
        let mut dst_name = name.clone();
        let mut dst = trash.join(&dst_name);
        let mut n = 1;
        while dst.exists() {
            dst_name = format!("{n} {name}");
            dst = trash.join(&dst_name);
            n += 1;
        }
        fs::rename(&src, &dst)?;
        let meta = fs::metadata(&dst)?;
        let deleted_at = now_millis();
        let (mut records, _) = self.read_trash_meta();
        records.insert(
            dst_name.clone(),
            TrashRecord {
                original_path: rel.to_string(),
                deleted_at,
            },
        );
        self.write_trash_meta(&records)?;
        Ok(TrashedEntry {
            name: dst_name.clone(),
            trash_path: format!("{TRASH_DIR}/{dst_name}"),
            original_path: Some(rel.to_string()),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            deleted_at,
        })
    }

    /// Top-level items currently in `.trash/`, newest deleted first.
    pub fn list_trash(&self) -> Result<Vec<TrashedEntry>> {
        let trash = self.root.join(TRASH_DIR);
        if !trash.is_dir() {
            return Ok(Vec::new());
        }
        let (mut records, had_meta) = self.read_trash_meta();
        let mut present = HashSet::new();
        let mut entries = Vec::new();
        for item in fs::read_dir(&trash)? {
            let Ok(item) = item else { continue };
            let name = item.file_name().to_string_lossy().into_owned();
            if name.ends_with(".dvoix-tmp") {
                continue;
            }
            let Ok(meta) = item.metadata() else { continue };
            present.insert(name.clone());
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let record = records.get(&name);
            entries.push(TrashedEntry {
                trash_path: format!("{TRASH_DIR}/{name}"),
                original_path: record.map(|r| r.original_path.clone()),
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
                deleted_at: record.map(|r| r.deleted_at).unwrap_or(modified),
                name,
            });
        }
        if had_meta {
            let before = records.len();
            records.retain(|k, _| present.contains(k));
            if records.len() != before {
                let _ = self.write_trash_meta(&records);
            }
        }
        entries.sort_by(|a, b| {
            b.deleted_at
                .cmp(&a.deleted_at)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    /// Restores an item from `.trash/` back to `target` (or its original path,
    /// or the vault root if unknown).
    pub fn restore_from_trash(
        &self,
        trash_name: &str,
        target: Option<&str>,
        rename_on_conflict: bool,
    ) -> Result<VaultEntry> {
        validate_trash_name(trash_name)?;
        let src = self.root.join(TRASH_DIR).join(trash_name);
        if !src.exists() {
            return Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("Trashed item not found: {trash_name}"),
            )));
        }
        let (mut records, had_meta) = self.read_trash_meta();
        let desired = target
            .map(str::to_string)
            .or_else(|| records.get(trash_name).map(|r| r.original_path.clone()))
            .unwrap_or_else(|| trash_name.to_string());
        if is_protected_vault_path(&desired) {
            return Err(Error::OutsideVault(desired));
        }
        let is_dir = src.is_dir();
        let final_rel = if self.resolve(&desired)?.exists() {
            if !rename_on_conflict {
                return Err(Error::AlreadyExists(desired));
            }
            self.free_restore_path(&desired, is_dir)?
        } else {
            desired
        };
        let dst = self.resolve(&final_rel)?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&src, &dst)?;
        if had_meta && records.remove(trash_name).is_some() {
            let _ = self.write_trash_meta(&records);
        }
        self.entry(&final_rel)
    }

    /// Permanently removes a single item from `.trash/`.
    pub fn delete_trashed(&self, trash_name: &str) -> Result<()> {
        validate_trash_name(trash_name)?;
        let target = self.root.join(TRASH_DIR).join(trash_name);
        if target.is_dir() {
            fs::remove_dir_all(&target)?;
        } else if target.exists() {
            fs::remove_file(&target)?;
        }
        let (mut records, had_meta) = self.read_trash_meta();
        if had_meta && records.remove(trash_name).is_some() {
            let _ = self.write_trash_meta(&records);
        }
        Ok(())
    }

    /// Permanently removes every item from `.trash/`.
    pub fn empty_trash(&self) -> Result<()> {
        let trash = self.root.join(TRASH_DIR);
        if trash.is_dir() {
            for item in fs::read_dir(&trash)? {
                let Ok(item) = item else { continue };
                let path = item.path();
                if path.is_dir() {
                    fs::remove_dir_all(&path)?;
                } else {
                    fs::remove_file(&path)?;
                }
            }
        }
        let (_, had_meta) = self.read_trash_meta();
        if had_meta {
            self.write_trash_meta(&HashMap::new())?;
        }
        Ok(())
    }

    /// CSS snippet file names in `.dvoix/snippets/`, sorted case-insensitively.
    pub fn list_snippets(&self) -> Result<Vec<String>> {
        let dir = self.app_dir().join(SNIPPETS_DIR);
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut files = Vec::new();
        for item in fs::read_dir(&dir)? {
            let Ok(item) = item else { continue };
            let Ok(ft) = item.file_type() else { continue };
            if !ft.is_file() {
                continue;
            }
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.ends_with(".dvoix-tmp") {
                continue;
            }
            if Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("css"))
            {
                files.push(name);
            }
        }
        files.sort_by_key(|a| a.to_lowercase());
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        assert!(vault.resolve("../secret.md").is_err());
        assert!(vault.resolve("/etc/passwd").is_err());
        assert!(vault.resolve("notes/ok.md").is_ok());
    }

    #[test]
    fn config_files_live_in_app_dir_and_stay_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        assert_eq!(vault.read_config("app.json").unwrap(), None);
        vault.write_config("plugins/tasks/data.json", "{}").unwrap();
        assert_eq!(
            vault
                .read_config("plugins/tasks/data.json")
                .unwrap()
                .as_deref(),
            Some("{}")
        );
        assert!(
            dir.path()
                .join(APP_DIR)
                .join("plugins/tasks/data.json")
                .exists()
        );
        assert!(vault.list().unwrap().is_empty());

        assert!(vault.write_config("../escape.json", "x").is_err());
        assert!(vault.write_config("/etc/x.json", "x").is_err());
        assert!(vault.write_config("plugins/.hidden", "x").is_err());
        assert!(vault.write_config("", "x").is_err());
    }

    #[test]
    fn write_list_rename_trash() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("projects/alpha.md", "# Alpha").unwrap();
        let entry = vault.write("./inbox.md", "hi").unwrap();
        assert_eq!(entry.path, "inbox.md");

        let paths: Vec<_> = vault.list().unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec!["inbox.md", "projects", "projects/alpha.md"]);
        assert!(!paths.iter().any(|p| p.starts_with(APP_DIR)));

        vault.rename("inbox.md", "projects/inbox.md").unwrap();
        assert_eq!(vault.read("projects/inbox.md").unwrap(), "hi");
        assert!(vault.create("projects/inbox.md", "x").is_err());

        vault.trash("projects/inbox.md").unwrap();
        assert!(vault.read("projects/inbox.md").is_err());
        assert!(dir.path().join(TRASH_DIR).join("inbox.md").exists());
    }

    #[test]
    fn read_with_meta_returns_text_and_disk_state() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let written = vault.write("note.md", "hello").unwrap();
        let read = vault.read_with_meta("note.md").unwrap();
        assert_eq!(read.content, "hello");
        assert_eq!(read.entry, written);
    }

    #[test]
    fn write_checked_accepts_a_matching_base() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let base = vault.write("note.md", "one").unwrap();
        let next = vault
            .write_checked("note.md", "two", Some(base.modified), Some(base.size))
            .unwrap();
        assert_eq!(vault.read("note.md").unwrap(), "two");
        // Chained writes work: the entry of a write is the base of the next.
        vault
            .write_checked("note.md", "three", Some(next.modified), Some(next.size))
            .unwrap();
        assert_eq!(vault.read("note.md").unwrap(), "three");
    }

    #[test]
    fn write_checked_refuses_an_external_edit() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let base = vault.write("note.md", "mine").unwrap();
        // Somebody else writes the file (another editor, git, a sync tool).
        fs::write(dir.path().join("note.md"), "theirs, longer").unwrap();
        let result = vault.write_checked(
            "note.md",
            "mine again",
            Some(base.modified),
            Some(base.size),
        );
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert_eq!(vault.read("note.md").unwrap(), "theirs, longer");
    }

    #[test]
    fn write_checked_compares_size_even_when_mtime_is_coarse() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let base = vault.write("note.md", "mine").unwrap();
        // Same length and a whole-second file system could hide the mtime
        // change; a different size must still be caught.
        let mut entry = base.clone();
        entry.size += 1;
        let result = vault.write_checked("note.md", "x", Some(base.modified), Some(entry.size));
        assert!(matches!(result, Err(Error::Conflict(_))));
        // And the other way around: right size, wrong time.
        let result = vault.write_checked("note.md", "x", Some(base.modified + 1), Some(base.size));
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert_eq!(vault.read("note.md").unwrap(), "mine");
    }

    #[test]
    fn write_checked_refuses_a_deleted_file_but_plain_write_recreates_it() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let base = vault.write("note.md", "mine").unwrap();
        fs::remove_file(dir.path().join("note.md")).unwrap();
        let result = vault.write_checked(
            "note.md",
            "mine again",
            Some(base.modified),
            Some(base.size),
        );
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert!(!dir.path().join("note.md").exists());
        // Without expectations the old behavior stays: the file is created.
        vault.write_checked("note.md", "back", None, None).unwrap();
        assert_eq!(vault.read("note.md").unwrap(), "back");
    }

    #[test]
    fn binary_files_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let png = [0x89, b'P', b'N', b'G', 0, 0xff, 0x10];
        vault.create_bytes("assets/image.png", &png).unwrap();
        assert_eq!(vault.read_bytes("assets/image.png").unwrap(), png);
        assert!(vault.create_bytes("assets/image.png", &png).is_err());
        assert!(vault.create_bytes("../escape.png", &png).is_err());
    }

    #[test]
    fn lists_the_files_below_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("work/one.md", "1").unwrap();
        vault.write("work/deep/two.md", "2").unwrap();
        vault.write("other/three.md", "3").unwrap();
        vault.write("top.md", "4").unwrap();

        let paths: Vec<_> = vault
            .files_below("work")
            .unwrap()
            .iter()
            .map(|e| e.path.clone())
            .collect();
        assert_eq!(paths, vec!["work/deep/two.md", "work/one.md"]);

        // A folder that does not exist gives nothing, not an error.
        assert!(vault.files_below("nothing").unwrap().is_empty());
        // A file is not a folder.
        assert!(vault.files_below("top.md").unwrap().is_empty());
    }

    /// The listing stays in lower-cased path order, whatever case the names
    /// were written in, and the extension is always lower-case.
    #[test]
    fn lists_in_lowercase_path_order_with_lowercase_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("Zebra.MD", "z").unwrap();
        vault.write("apple.md", "a").unwrap();
        vault.write("Mango.Txt", "m").unwrap();

        let entries = vault.list().unwrap();
        let paths: Vec<_> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["apple.md", "Mango.Txt", "Zebra.MD"]);
        let extensions: Vec<_> = entries.iter().map(|e| e.extension.as_str()).collect();
        assert_eq!(extensions, vec!["md", "txt", "md"]);

        // `files` keeps the same order, without the folders.
        let files: Vec<_> = vault.files().unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(files, vec!["apple.md", "Mango.Txt", "Zebra.MD"]);
    }

    #[test]
    fn lists_hidden_entries_by_filter() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("note.md", "x").unwrap();
        vault.write(".obsidian/app.json", "{}").unwrap();
        vault.write(".git/HEAD", "ref").unwrap();
        vault.write("sub/.gitignore", "*.tmp").unwrap();
        vault.write_config("app.json", "{}").unwrap();
        fs::write(dir.path().join(".obsidian/.app.json.dvoix-tmp"), "x").unwrap();

        let paths = |f: &HiddenFilter| -> Vec<String> {
            vault
                .list_hidden(f)
                .unwrap()
                .into_iter()
                .map(|e| e.path)
                .collect()
        };
        let mut filter = HiddenFilter {
            exclude: vec![".git".into()],
            ..Default::default()
        };
        assert_eq!(paths(&filter), vec![".obsidian", ".obsidian/app.json"]);

        filter.include_files = true;
        filter.include_app_dir = true;
        filter.exclude.clear();
        assert_eq!(
            paths(&filter),
            vec![
                ".dvoix",
                ".dvoix/app.json",
                ".git",
                ".git/HEAD",
                ".obsidian",
                ".obsidian/app.json",
                "sub/.gitignore",
            ]
        );
        // The normal listing is unchanged.
        let visible: Vec<_> = vault.list().unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(visible, vec!["note.md", "sub"]);
    }

    #[test]
    fn trash_list_restore_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("projects/inbox.md", "first").unwrap();
        vault.write("archive/note.md", "nested").unwrap();

        let trashed = vault.trash("projects/inbox.md").unwrap();
        assert_eq!(trashed.name, "inbox.md");
        assert_eq!(trashed.original_path.as_deref(), Some("projects/inbox.md"));
        assert!(!trashed.is_dir);

        // Trashing a second file with the same name gets a numbered trash name
        // while still remembering its own original path.
        vault.write("other/inbox.md", "second").unwrap();
        let trashed2 = vault.trash("other/inbox.md").unwrap();
        assert_eq!(trashed2.name, "1 inbox.md");
        assert_eq!(trashed2.original_path.as_deref(), Some("other/inbox.md"));

        // Trashing a folder keeps it as one top-level item.
        let folder_trashed = vault.trash("archive").unwrap();
        assert!(folder_trashed.is_dir);
        assert_eq!(folder_trashed.original_path.as_deref(), Some("archive"));

        let list = vault.list_trash().unwrap();
        assert_eq!(list.len(), 3);

        // Restoring `1 inbox.md` brings it back to `other/inbox.md`.
        let restored = vault.restore_from_trash("1 inbox.md", None, false).unwrap();
        assert_eq!(restored.path, "other/inbox.md");
        assert_eq!(vault.read("other/inbox.md").unwrap(), "second");

        // Conflict handling: create a new file at `projects/inbox.md`.
        vault.write("projects/inbox.md", "new").unwrap();
        assert!(vault.restore_from_trash("inbox.md", None, false).is_err());
        let restored_copy = vault.restore_from_trash("inbox.md", None, true).unwrap();
        assert_eq!(restored_copy.path, "projects/inbox 2.md");
        assert_eq!(vault.read("projects/inbox 2.md").unwrap(), "first");

        // Permanent delete of folder and empty_trash.
        vault.delete_trashed("archive").unwrap();
        assert!(vault.list_trash().unwrap().is_empty());

        vault.write("temp.md", "bye").unwrap();
        vault.trash("temp.md").unwrap();
        assert_eq!(vault.list_trash().unwrap().len(), 1);
        vault.empty_trash().unwrap();
        assert!(vault.list_trash().unwrap().is_empty());

        // Security checks: cannot escape `.trash/`.
        assert!(vault.delete_trashed("../note.md").is_err());
        assert!(vault.restore_from_trash("../note.md", None, false).is_err());
        assert!(vault.trash(".trash").is_err());
        assert!(vault.trash(".dvoix").is_err());
    }

    #[test]
    fn lists_css_snippets_sorted_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        assert!(vault.list_snippets().unwrap().is_empty());

        vault.write_config("snippets/Zebra.css", "body {}").unwrap();
        vault.write_config("snippets/alpha.CSS", "body {}").unwrap();
        vault
            .write_config("snippets/readme.txt", "ignored")
            .unwrap();
        vault
            .write_config("snippets/sub/nested.css", "ignored")
            .unwrap();

        assert_eq!(
            vault.list_snippets().unwrap(),
            vec!["alpha.CSS", "Zebra.css"]
        );
    }
}
