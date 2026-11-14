//! Plugins from the plugin store: the format of the plugin list (the registry),
//! the `manifest.json` of a plugin and its files in `.dvoix/plugins/<id>/`.
//!
//! Downloading is done by the app shell; this module only checks what came in
//! and writes it, so all of it can be tested without network.
//!
//! The registry pins every plugin to one release and lists the SHA-256 of
//! each of its files. A download that does not match is refused, so a
//! release that was swapped or changed after it went into the list never
//! reaches a vault. New releases reach users when the list is updated.
//!
//! An installed plugin is a folder `.dvoix/plugins/<id>/` with
//! `manifest.json`, `main.js` and optionally `styles.css`. The folder may also
//! hold `data.json` (the plugin's settings), which uninstalling keeps, so a
//! reinstalled plugin finds its settings again. Core plugins only ever have
//! `data.json` there, so a folder without `manifest.json` is not a store plugin.

use std::collections::BTreeMap;
use std::fs;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Error, Result, Vault};

/// Where the app reads the plugin list from.
pub const REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/dvoi-dev/dvoix-plugins/main/registry.json";

/// Only plugins in repositories of this GitHub organization can be official. A
/// registry entry that says `official` for any other repository is shown as
/// community plugin, so a mistake in the list can't hand out the label.
pub const OFFICIAL_OWNER: &str = "dvoi-dev";

pub const MANIFEST_FILE: &str = "manifest.json";
pub const MAIN_FILE: &str = "main.js";
pub const STYLES_FILE: &str = "styles.css";

/// Upper limit for a downloaded file, so a broken release can't fill the disk.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// The files a release may have. The first two are required.
pub const RELEASE_FILES: &[&str] = &[MANIFEST_FILE, MAIN_FILE, STYLES_FILE];

/// What a plugin may use of the API (see `src/lib/plugins/store/api.ts`).
pub const PERMISSIONS: &[&str] = &["vault:read", "vault:write", "editor", "process"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Official,
    Community,
}

/// One plugin in the registry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub author: String,
    pub description: String,
    /// GitHub repository `owner/name`; the plugin's files come from its releases.
    pub repo: String,
    pub channel: Channel,
    /// The release the store installs: its tag and the `version` in its manifest.
    pub version: String,
    /// SHA-256 (hex) of every file of that release, by file name:
    /// `manifest.json` and `main.js` always, `styles.css` if the release has
    /// one. Files that are not listed are not downloaded.
    pub sha256: BTreeMap<String, String>,
}

/// One release of a plugin with its notes, for the changelog in the store.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    /// Title of the release, if it has one besides the tag.
    pub name: Option<String>,
    /// The release notes as the author wrote them (Markdown, shown as text).
    pub notes: String,
    /// When it was published (RFC 3339), if GitHub says so.
    pub published: Option<String>,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

#[derive(Deserialize)]
struct RegistryFile {
    plugins: Vec<serde_json::Value>,
}

/// The `manifest.json` of a store plugin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    /// `major.minor.patch`; also the tag of the GitHub release with the files.
    pub version: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Oldest dvoix version the plugin runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// A plugin found in `.dvoix/plugins/<id>/`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub has_styles: bool,
}

/// The files of one plugin release.
pub struct PluginFiles {
    pub manifest: String,
    pub main: String,
    pub styles: Option<String>,
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::Plugin(msg.into())
}

/// Plugin ids are folder names and settings keys: `a-z0-9-`, not empty.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `owner/name` with the characters GitHub allows. Keeps anything else out of
/// the download URLs.
pub fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |s: Option<&str>| {
        s.is_some_and(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// `1.2.3`, numbers only.
pub fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.chars().all(|c| c.is_ascii_digit()))
}

/// 64 hex digits.
fn valid_sha256(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

/// Checks a registry entry: id, repository, pinned version and a checksum
/// for `manifest.json` and `main.js`, and for no file a release can't have.
pub fn check_entry(entry: &RegistryEntry) -> Result<()> {
    if !valid_id(&entry.id) {
        return Err(invalid(format!("Invalid plugin ID: {}", entry.id)));
    }
    if !valid_repo(&entry.repo) {
        return Err(invalid(format!("Invalid repository: {}", entry.repo)));
    }
    if !valid_version(&entry.version) {
        return Err(invalid(format!("Invalid version: {}", entry.version)));
    }
    for required in [MANIFEST_FILE, MAIN_FILE] {
        if !entry.sha256.contains_key(required) {
            return Err(invalid(format!(
                "The plugin list has no checksum for {required} of {}",
                entry.id
            )));
        }
    }
    for (name, hash) in &entry.sha256 {
        if !RELEASE_FILES.contains(&name.as_str()) {
            return Err(invalid(format!("Unknown file in the checksums: {name}")));
        }
        if !valid_sha256(hash) {
            return Err(invalid(format!("Invalid SHA-256 for {name}: {hash}")));
        }
    }
    Ok(())
}

/// Lower-case hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Refuses a downloaded file whose SHA-256 is not the one in the registry.
pub fn verify(entry: &RegistryEntry, name: &str, content: &[u8]) -> Result<()> {
    let expected = entry
        .sha256
        .get(name)
        .ok_or_else(|| invalid(format!("The plugin list has no checksum for {name}")))?;
    if !sha256_hex(content).eq_ignore_ascii_case(expected) {
        return Err(invalid(format!(
            "{name} of {} {} does not match the checksum in the plugin list. \
             The release was changed after it was added to the list; it was not installed.",
            entry.id, entry.version
        )));
    }
    Ok(())
}

/// Checks a downloaded `manifest.json` against the registry entry: checksum,
/// format, and that it is the plugin and the version the list pins.
pub fn verified_manifest(entry: &RegistryEntry, text: &str) -> Result<PluginManifest> {
    verify(entry, MANIFEST_FILE, text.as_bytes())?;
    let manifest = parse_manifest(text)?;
    if manifest.id != entry.id {
        return Err(invalid(format!(
            "The plugin is called \"{}\", but \"{}\" was expected",
            manifest.id, entry.id
        )));
    }
    if manifest.version != entry.version {
        return Err(invalid(format!(
            "The release has version {}, but the plugin list pins {}",
            manifest.version, entry.version
        )));
    }
    Ok(manifest)
}

/// Checks all files of a downloaded release against the registry entry.
/// `styles.css` must be there exactly when the list has a checksum for it.
pub fn verify_release(entry: &RegistryEntry, files: &PluginFiles) -> Result<PluginManifest> {
    check_entry(entry)?;
    let manifest = verified_manifest(entry, &files.manifest)?;
    verify(entry, MAIN_FILE, files.main.as_bytes())?;
    match (&files.styles, entry.sha256.contains_key(STYLES_FILE)) {
        (Some(css), true) => verify(entry, STYLES_FILE, css.as_bytes())?,
        (None, false) => {}
        (Some(_), false) => {
            return Err(invalid(format!(
                "The plugin list has no checksum for {STYLES_FILE}"
            )));
        }
        (None, true) => {
            return Err(invalid(format!(
                "Release {} of {} is missing {STYLES_FILE}",
                entry.version, entry.repo
            )));
        }
    }
    Ok(manifest)
}

/// Reads the registry. Broken or duplicate entries are skipped instead of
/// failing the whole list (also entries without a pinned release and
/// checksums), and `official` only sticks for [`OFFICIAL_OWNER`].
pub fn parse_registry(text: &str) -> Result<Vec<RegistryEntry>> {
    let file: RegistryFile = serde_json::from_str(text)
        .map_err(|e| invalid(format!("Plugin list is not valid JSON: {e}")))?;
    let mut out: Vec<RegistryEntry> = Vec::new();
    for value in file.plugins {
        let Ok(mut entry) = serde_json::from_value::<RegistryEntry>(value) else {
            continue;
        };
        if check_entry(&entry).is_err() || out.iter().any(|e| e.id == entry.id) {
            continue;
        }
        let owner = entry.repo.split('/').next().unwrap_or_default();
        if !owner.eq_ignore_ascii_case(OFFICIAL_OWNER) {
            entry.channel = Channel::Community;
        }
        out.push(entry);
    }
    Ok(out)
}

/// Reads and checks a `manifest.json`.
pub fn parse_manifest(text: &str) -> Result<PluginManifest> {
    let m: PluginManifest = serde_json::from_str(text)
        .map_err(|e| invalid(format!("manifest.json is invalid: {e}")))?;
    if !valid_id(&m.id) {
        return Err(invalid(format!("Invalid plugin ID: {}", m.id)));
    }
    if !valid_version(&m.version) {
        return Err(invalid(format!("Invalid version: {}", m.version)));
    }
    if let Some(min) = &m.min_app_version
        && !valid_version(min)
    {
        return Err(invalid(format!("Invalid minAppVersion: {min}")));
    }
    if let Some(p) = m
        .permissions
        .iter()
        .find(|p| !PERMISSIONS.contains(&p.as_str()))
    {
        return Err(invalid(format!("Unknown permission: {p}")));
    }
    Ok(m)
}

/// Download URL of a file of a release (`tag` = the version).
pub fn release_url(repo: &str, tag: &str, file: &str) -> Result<String> {
    if !valid_repo(repo) {
        return Err(invalid(format!("Invalid repository: {repo}")));
    }
    if !valid_version(tag) {
        return Err(invalid(format!("Invalid version: {tag}")));
    }
    Ok(format!(
        "https://github.com/{repo}/releases/download/{tag}/{file}"
    ))
}

/// URL of the newest releases of a repository in the GitHub API, for the changelog.
pub fn releases_url(repo: &str) -> Result<String> {
    if !valid_repo(repo) {
        return Err(invalid(format!("Invalid repository: {repo}")));
    }
    Ok(format!(
        "https://api.github.com/repos/{repo}/releases?per_page=30"
    ))
}

/// Reads the answer of [`releases_url`]: published releases whose tag is a
/// version, newest first. Drafts, pre-releases and other tags are left out.
pub fn parse_releases(text: &str) -> Result<Vec<ReleaseNote>> {
    let list: Vec<GithubRelease> = serde_json::from_str(text)
        .map_err(|e| invalid(format!("The release list is invalid: {e}")))?;
    let mut out: Vec<ReleaseNote> = list
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease && valid_version(&r.tag_name))
        .map(|r| ReleaseNote {
            name: r
                .name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty() && *n != r.tag_name),
            notes: r
                .body
                .unwrap_or_default()
                .replace("\r\n", "\n")
                .trim()
                .to_string(),
            published: r.published_at,
            version: r.tag_name,
        })
        .collect();
    out.sort_by_key(|r| std::cmp::Reverse(version_key(&r.version)));
    Ok(out)
}

/// `1.10.0` as numbers, so it sorts after `1.9.0`.
fn version_key(v: &str) -> Vec<u64> {
    v.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

fn file(id: &str, name: &str) -> String {
    format!("plugins/{id}/{name}")
}

/// All store plugins in the vault, sorted by name. Folders with a broken
/// manifest are skipped (they can't be loaded anyway).
pub fn installed(vault: &Vault) -> Result<Vec<InstalledPlugin>> {
    let dir = vault.config_path("plugins")?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&id) || !entry.path().is_dir() {
            continue;
        }
        let Some(text) = vault.read_config(&file(&id, MANIFEST_FILE))? else {
            continue;
        };
        let Ok(manifest) = parse_manifest(&text) else {
            continue;
        };
        // The folder name is what settings and data refer to; a manifest
        // claiming another id would load under the wrong name.
        if manifest.id != id {
            continue;
        }
        let has_styles = vault.config_path(&file(&id, STYLES_FILE))?.is_file();
        out.push(InstalledPlugin {
            manifest,
            has_styles,
        });
    }
    out.sort_by(|a, b| {
        a.manifest
            .name
            .to_lowercase()
            .cmp(&b.manifest.name.to_lowercase())
    });
    Ok(out)
}

/// Writes a downloaded plugin into `.dvoix/plugins/<id>/`, after checking
/// every file against the checksums of its registry entry. `manifest.json`
/// comes last, so a plugin only counts as installed once all files are there.
/// An update replaces the files; `data.json` stays.
pub fn install(
    vault: &Vault,
    entry: &RegistryEntry,
    files: &PluginFiles,
) -> Result<PluginManifest> {
    let manifest = verify_release(entry, files)?;
    let id = &manifest.id;
    vault.write_config(&file(id, MAIN_FILE), &files.main)?;
    match &files.styles {
        Some(css) => vault.write_config(&file(id, STYLES_FILE), css)?,
        None => remove(vault, &file(id, STYLES_FILE))?,
    }
    vault.write_config(&file(id, MANIFEST_FILE), &files.manifest)?;
    Ok(manifest)
}

/// Removes the plugin's code. Its `data.json` stays, like a setting does.
pub fn uninstall(vault: &Vault, id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err(invalid(format!("Invalid plugin ID: {id}")));
    }
    // Manifest first: if something below fails, the rest is no plugin anymore.
    for name in [MANIFEST_FILE, MAIN_FILE, STYLES_FILE] {
        remove(vault, &file(id, name))?;
    }
    let dir = vault.config_path(&format!("plugins/{id}"))?;
    if fs::read_dir(&dir).is_ok_and(|mut d| d.next().is_none()) {
        fs::remove_dir(&dir)?;
    }
    Ok(())
}

fn remove(vault: &Vault, rel: &str) -> Result<()> {
    match fs::remove_file(vault.config_path(rel)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(id: &str, version: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"Kanban","version":"{version}","description":"Boards.","permissions":["vault:read"]}}"#
        )
    }

    fn files(id: &str, version: &str, styles: Option<&str>) -> PluginFiles {
        PluginFiles {
            manifest: manifest(id, version),
            main: "export default { onload() {} };".into(),
            styles: styles.map(String::from),
        }
    }

    /// A registry entry that pins exactly these files.
    fn entry_for(id: &str, files: &PluginFiles) -> RegistryEntry {
        let mut sha256 = BTreeMap::new();
        sha256.insert(MANIFEST_FILE.into(), sha256_hex(files.manifest.as_bytes()));
        sha256.insert(MAIN_FILE.into(), sha256_hex(files.main.as_bytes()));
        if let Some(css) = &files.styles {
            sha256.insert(STYLES_FILE.into(), sha256_hex(css.as_bytes()));
        }
        RegistryEntry {
            id: id.into(),
            name: "Kanban".into(),
            author: "damavoi".into(),
            description: "Boards.".into(),
            repo: "dvoi-dev/dvoix-kanban".into(),
            channel: Channel::Official,
            version: parse_manifest(&files.manifest).unwrap().version,
            sha256,
        }
    }

    fn install_files(vault: &Vault, id: &str, files: &PluginFiles) -> Result<PluginManifest> {
        install(vault, &entry_for(id, files), files)
    }

    const HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn checks_ids_repos_and_versions() {
        assert!(valid_id("kanban-board2"));
        assert!(!valid_id("Kanban"));
        assert!(!valid_id("../x"));
        assert!(!valid_id(""));
        assert!(!valid_id("-x"));
        assert!(valid_repo("dvoi-dev/dvoix-kanban"));
        assert!(!valid_repo("dvoi-dev"));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_repo("../b"));
        assert!(!valid_repo("a/b?x=1"));
        assert!(valid_version("1.10.0"));
        assert!(!valid_version("1.0"));
        assert!(!valid_version("v1.0.0"));
        assert!(!valid_version("1.0.0-beta"));
    }

    #[test]
    fn registry_skips_bad_entries_and_guards_the_official_label() {
        let pin = format!(
            r#""version":"1.0.0","sha256":{{"manifest.json":"{HASH}","main.js":"{HASH}"}}"#
        );
        let text = format!(
            r#"{{
          "version": 1,
          "plugins": [
            {{"id":"kanban","name":"Kanban","author":"damavoi","description":"Boards.","repo":"dvoi-dev/dvoix-kanban","channel":"official",{pin}}},
            {{"id":"fake","name":"Fake","author":"x","description":"x","repo":"someone/fake","channel":"official",{pin}}},
            {{"id":"kanban","name":"Twice","author":"x","description":"x","repo":"x/y","channel":"community",{pin}}},
            {{"id":"Bad Id","name":"x","author":"x","description":"x","repo":"x/y","channel":"community",{pin}}},
            {{"id":"nochannel","name":"x","author":"x","description":"x","repo":"x/y",{pin}}},
            {{"id":"unpinned","name":"x","author":"x","description":"x","repo":"x/y","channel":"community"}}
          ]
        }}"#
        );
        let list = parse_registry(&text).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "kanban");
        assert_eq!(list[0].channel, Channel::Official);
        assert_eq!(list[0].version, "1.0.0");
        assert_eq!(list[1].id, "fake");
        assert_eq!(list[1].channel, Channel::Community);
        assert!(parse_registry("nope").is_err());
    }

    #[test]
    fn entries_need_a_pinned_version_and_checksums() {
        let files = files("kanban", "1.0.0", None);
        let good = entry_for("kanban", &files);
        assert!(check_entry(&good).is_ok());

        let mut e = good.clone();
        e.version = "latest".into();
        assert!(check_entry(&e).is_err());

        let mut e = good.clone();
        e.sha256.remove(MAIN_FILE);
        assert!(check_entry(&e).is_err());

        let mut e = good.clone();
        e.sha256.insert("evil.js".into(), HASH.into());
        assert!(check_entry(&e).is_err());

        let mut e = good;
        e.sha256.insert(MAIN_FILE.into(), "abc".into());
        assert!(check_entry(&e).is_err());
    }

    #[test]
    fn sha256_is_hex() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_changed_release_is_refused() {
        let good = files("kanban", "1.0.0", Some("a{}"));
        let entry = entry_for("kanban", &good);
        assert!(verify_release(&entry, &good).is_ok());

        let mut changed = files("kanban", "1.0.0", Some("a{}"));
        changed.main.push_str("fetch('https://evil.example');");
        assert!(verify_release(&entry, &changed).is_err());

        let mut changed = files("kanban", "1.0.0", Some("a{}"));
        changed.styles = Some("a{background:url(https://evil.example)}".into());
        assert!(verify_release(&entry, &changed).is_err());

        // The checksums say the release has styles, so they must be there.
        let missing = files("kanban", "1.0.0", None);
        let mut e = entry_for("kanban", &missing);
        e.sha256.insert(STYLES_FILE.into(), HASH.into());
        assert!(verify_release(&e, &missing).is_err());

        // Styles the list does not know are not taken either.
        let extra = files("kanban", "1.0.0", Some("a{}"));
        let mut e = entry_for("kanban", &extra);
        e.sha256.remove(STYLES_FILE);
        assert!(verify_release(&e, &extra).is_err());
    }

    #[test]
    fn the_manifest_must_be_the_pinned_one() {
        let other_version = files("kanban", "1.1.0", None);
        let mut e = entry_for("kanban", &other_version);
        e.version = "1.0.0".into();
        assert!(verified_manifest(&e, &other_version.manifest).is_err());

        let other_id = files("tasks", "1.0.0", None);
        let mut e = entry_for("tasks", &other_id);
        e.id = "kanban".into();
        assert!(verified_manifest(&e, &other_id.manifest).is_err());
    }

    #[test]
    fn releases_are_read_newest_first() {
        let text = r#"[
          {"tag_name":"1.9.0","name":"1.9.0","body":"Old\r\nfix","published_at":"2026-01-01T00:00:00Z"},
          {"tag_name":"1.10.0","name":"Big one","body":"New","published_at":"2026-02-01T00:00:00Z"},
          {"tag_name":"2.0.0","body":"Draft","draft":true},
          {"tag_name":"2.0.0-beta","body":"Beta"},
          {"tag_name":"1.11.0","body":"Pre","prerelease":true}
        ]"#;
        let list = parse_releases(text).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].version, "1.10.0");
        assert_eq!(list[0].name.as_deref(), Some("Big one"));
        assert_eq!(list[1].version, "1.9.0");
        assert_eq!(list[1].name, None);
        assert_eq!(list[1].notes, "Old\nfix");
        assert!(parse_releases("{}").is_err());
    }

    #[test]
    fn examples_in_the_repo_parse() {
        let text = include_str!("../../../docs/plugins/registry.example.json");
        let list = parse_registry(text).unwrap();
        assert_eq!(list.len(), 2);
        let example = include_str!("../../../docs/plugins/hello/manifest.json");
        assert_eq!(parse_manifest(example).unwrap().id, "hello");
        // The checksums of the example entry are those of the example plugin.
        let hello = PluginFiles {
            manifest: example.into(),
            main: include_str!("../../../docs/plugins/hello/main.js").into(),
            styles: Some(include_str!("../../../docs/plugins/hello/styles.css").into()),
        };
        assert!(verify_release(&list[0], &hello).is_ok());
    }

    #[test]
    fn manifest_is_checked() {
        assert!(parse_manifest(&manifest("kanban", "1.0.0")).is_ok());
        assert!(parse_manifest(&manifest("kanban", "1.0")).is_err());
        assert!(parse_manifest(&manifest("../x", "1.0.0")).is_err());
        let unknown =
            r#"{"id":"a","name":"A","version":"1.0.0","description":"x","permissions":["root"]}"#;
        assert!(parse_manifest(unknown).is_err());
    }

    #[test]
    fn urls_only_come_from_checked_parts() {
        assert_eq!(
            release_url("dvoi-dev/dvoix-kanban", "1.2.0", MAIN_FILE).unwrap(),
            "https://github.com/dvoi-dev/dvoix-kanban/releases/download/1.2.0/main.js"
        );
        assert!(release_url("a/b/../c", "1.0.0", MAIN_FILE).is_err());
        assert!(release_url("a/b", "../1", MAIN_FILE).is_err());
        assert_eq!(
            releases_url("dvoi-dev/dvoix-kanban").unwrap(),
            "https://api.github.com/repos/dvoi-dev/dvoix-kanban/releases?per_page=30"
        );
        assert!(releases_url("a b/c").is_err());
    }

    #[test]
    fn install_update_and_uninstall_keep_settings() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        // A core plugin's settings folder is not a store plugin.
        vault.write_config("plugins/tasks/data.json", "{}").unwrap();
        assert!(installed(&vault).unwrap().is_empty());

        install_files(&vault, "kanban", &files("kanban", "1.0.0", Some("a{}"))).unwrap();
        vault
            .write_config("plugins/kanban/data.json", r#"{"x":1}"#)
            .unwrap();
        let list = installed(&vault).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].manifest.version, "1.0.0");
        assert!(list[0].has_styles);

        // Update without styles removes the old stylesheet.
        install_files(&vault, "kanban", &files("kanban", "1.1.0", None)).unwrap();
        let list = installed(&vault).unwrap();
        assert_eq!(list[0].manifest.version, "1.1.0");
        assert!(!list[0].has_styles);

        uninstall(&vault, "kanban").unwrap();
        assert!(installed(&vault).unwrap().is_empty());
        assert_eq!(
            vault
                .read_config("plugins/kanban/data.json")
                .unwrap()
                .as_deref(),
            Some(r#"{"x":1}"#)
        );
        assert!(
            vault
                .read_config("plugins/kanban/main.js")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn install_refuses_a_different_id() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let tasks = files("tasks", "1.0.0", None);
        let mut entry = entry_for("tasks", &tasks);
        entry.id = "kanban".into();
        assert!(install(&vault, &entry, &tasks).is_err());
        assert!(
            vault
                .read_config("plugins/tasks/main.js")
                .unwrap()
                .is_none()
        );
        assert!(
            vault
                .read_config("plugins/kanban/main.js")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn uninstall_removes_an_empty_folder() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        install_files(&vault, "kanban", &files("kanban", "1.0.0", None)).unwrap();
        uninstall(&vault, "kanban").unwrap();
        assert!(!vault.config_path("plugins/kanban").unwrap().exists());
        assert!(uninstall(&vault, "../x").is_err());
    }

    #[test]
    fn manifest_with_wrong_folder_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault
            .write_config("plugins/other/manifest.json", &manifest("kanban", "1.0.0"))
            .unwrap();
        assert!(installed(&vault).unwrap().is_empty());
    }
}
