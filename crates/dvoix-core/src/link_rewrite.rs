//! Rewriting of link targets when files are moved or renamed.
//!
//! A rename takes a note from one vault path to another, so every link that
//! addressed the old path has to name the new one. This module computes those
//! changes from the file list of the vault: pure text work, no disk access and
//! no dependency on the index. It only ever replaces the byte span of a link
//! target, so everything else in a note (its formatting, its code, its line
//! endings) stays byte-identical.

use std::collections::{HashMap, HashSet};

use crate::index::stem;
use crate::markdown::split_frontmatter;

/// One moved file: vault-relative paths with '/' separators, before -> after.
#[derive(Debug, Clone, PartialEq)]
pub struct Move {
    pub from: String,
    pub to: String,
}

/// How a file can be matched by a link target, most specific first. Obsidian
/// resolves by full path, then path without extension, then name, then stem.
const R_PATH: u8 = 0;
const R_NOEXT: u8 = 1;
const R_BASE: u8 = 2;
const R_STEM: u8 = 3;

/// The names a link can use for one file, lower-cased with the rank of their
/// specificity, so a target is matched the same way the app resolves it.
fn keys_of(path_lower: &str) -> Vec<(u8, &str)> {
    let mut keys = vec![(R_PATH, path_lower)];
    if let Some(no_ext) = path_lower.strip_suffix(".md") {
        keys.push((R_NOEXT, no_ext));
    }
    let base = path_lower.rsplit('/').next().unwrap_or(path_lower);
    keys.push((R_BASE, base));
    // `stem` splits at the last dot, which is right for normal names; a
    // dotted name like `v1.2.md` gets the stem `v1.2` either way.
    keys.push((R_STEM, stem(path_lower)));
    keys
}

/// The folder part of a vault path ('' for the root), with trailing '/'.
fn parent_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i + 1],
        None => "",
    }
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// File name without extension, treating a name that starts with '.' as one
/// whole (so `.gitignore` keeps its name).
fn stem_of(path: &str) -> &str {
    let base = base_name(path);
    match base.rsplit_once('.') {
        Some((s, _)) if !s.is_empty() => s,
        _ => base,
    }
}

/// Normalizes `rel` against the folder `from_dir` ('' is the vault root),
/// resolving '.' and '..'. `None` when the result would leave the vault.
fn resolve_rel(from_dir: &str, rel: &str) -> Option<String> {
    let mut stack: Vec<&str> = from_dir
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if stack.pop().is_none() {
                    return None;
                }
            }
            p => stack.push(p),
        }
    }
    Some(stack.join("/"))
}

/// The relative path from the folder `from_dir` to the vault path `to_path`,
/// with one '..' per folder to leave; never empty and never absolute.
fn rel_path(from_dir: &str, to_path: &str) -> String {
    let from_parts: Vec<&str> = from_dir.split('/').filter(|p| !p.is_empty()).collect();
    let to_parts: Vec<&str> = to_path.split('/').filter(|p| !p.is_empty()).collect();
    let mut common = 0;
    while common < from_parts.len() && common < to_parts.len() && from_parts[common] == to_parts[common]
    {
        common += 1;
    }
    let mut out = String::new();
    for _ in common..from_parts.len() {
        out.push_str("../");
    }
    out.push_str(&to_parts[common..].join("/"));
    out
}

/// Keeps the path part of a link destination apart from its '#fragment' (and
/// everything after it), so only the path is replaced.
fn split_fragment(dest: &str) -> (&str, &str) {
    match dest.find('#') {
        Some(i) => (&dest[..i], &dest[i..]),
        None => (dest, ""),
    }
}

/// Decodes '%20' back to spaces for matching (mirrors `local_link`).
fn decode_spaces(text: &str) -> String {
    if text.contains("%20") {
        text.replace("%20", " ")
    } else {
        text.to_string()
    }
}

/// Whether a byte range overlaps one of the skipped regions.
fn overlaps(regions: &[(usize, usize)], start: usize, end: usize) -> bool {
    regions.iter().any(|&(s, e)| start < e && end > s)
}

/// Byte ranges of the lines from `base` on, each without its line endings.
fn line_ranges(content: &str, base: usize) -> Vec<(usize, usize)> {
    let b = content.as_bytes();
    let mut out = Vec::new();
    let mut start = base;
    let mut i = base;
    while i < b.len() {
        if b[i] == b'\n' {
            let mut end = i;
            if end > start && b[end - 1] == b'\r' {
                end -= 1;
            }
            out.push((start, end));
            start = i + 1;
        }
        i += 1;
    }
    if start < b.len() {
        out.push((start, b.len()));
    }
    out
}

/// Opening line of a code fence: three or more backticks or tildes at the
/// start of the line (after up to three spaces); returns the run char and
/// length.
fn fence_open(line: &str) -> Option<(u8, usize)> {
    let mut rest = line;
    let mut spaces = 0;
    while spaces < 3 && rest.starts_with(' ') {
        rest = &rest[1..];
        spaces += 1;
    }
    let first = *rest.as_bytes().first()?;
    if first != b'`' && first != b'~' {
        return None;
    }
    let len = rest.bytes().take_while(|&b| b == first).count();
    (len >= 3).then_some((first, len))
}

/// Closing fence: a line of the same char, at least as long as the opening
/// run, with nothing else on it.
fn fence_close(line: &str, ch: u8, len: usize) -> bool {
    let mut rest = line;
    let mut spaces = 0;
    while spaces < 3 && rest.starts_with(' ') {
        rest = &rest[1..];
        spaces += 1;
    }
    let n = rest.bytes().take_while(|&b| b == ch).count();
    n >= len && rest[n..].trim().is_empty()
}

/// Everything the rewriting must not look at: fenced blocks (opening line,
/// body, closing line), HTML comments (may span lines) and inline code spans
/// (a run of N backticks closed by exactly the same run).
fn collect_skips(content: &str, base: usize) -> Vec<(usize, usize)> {
    let b = content.as_bytes();
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut comment: Option<usize> = None;
    for (ls, le) in line_ranges(content, base) {
        let mut pos = ls;
        // A line that continues an HTML comment from earlier.
        if let Some(cs) = comment {
            match content[cs..le].find("-->") {
                Some(f) => {
                    let end = cs + f + 3;
                    out.push((cs, end));
                    comment = None;
                    pos = end;
                }
                None => {
                    out.push((cs, le));
                    continue;
                }
            }
        }
        if let Some((ch, len)) = fence {
            out.push((ls, le));
            if fence_close(&content[ls..le], ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some((ch, len)) = fence_open(&content[ls..le]) {
            fence = Some((ch, len));
            out.push((ls, le));
            continue;
        }
        while pos < le {
            if b[pos] == b'<' && content[pos..].starts_with("<!--") {
                match content[pos + 4..].find("-->") {
                    Some(f) => {
                        let end = (pos + 4 + f + 3).min(le);
                        out.push((pos, end));
                        pos = end;
                    }
                    // The comment runs past the end of the line.
                    None => {
                        comment = Some(pos);
                        break;
                    }
                }
                continue;
            }
            if b[pos] == b'`' {
                let mut j = pos;
                while j < le && b[j] == b'`' {
                    j += 1;
                }
                let n = j - pos;
                let mut k = j;
                let mut closed = None;
                while k < le {
                    if b[k] == b'`' {
                        let mut m = k;
                        while m < le && b[m] == b'`' {
                            m += 1;
                        }
                        if m - k == n {
                            closed = Some(m);
                            break;
                        }
                        k = m;
                    } else {
                        k += 1;
                    }
                }
                match closed {
                    Some(c) => {
                        out.push((pos, c));
                        pos = c;
                    }
                    // An unclosed run is ordinary text.
                    None => pos = j,
                }
                continue;
            }
            pos += 1;
        }
    }
    if let Some(cs) = comment {
        out.push((cs, content.len()));
    }
    out
}

/// Computes the new link texts for one move plan. It needs the file list
/// after the move, the alias map of the index and the moves themselves, and
/// answers per note what its links have to say afterwards.
pub struct LinkRewriter {
    /// Every file path after the move, as written.
    files: Vec<String>,
    /// Old path -> new path, lower-cased keys.
    moved: HashMap<String, String>,
    /// New path -> old path, lower-cased keys.
    rev: HashMap<String, String>,
    /// Lower-cased link key -> (specificity rank, old path) of every file a
    /// bare or path-like target could name, before the move.
    old_by_key: HashMap<String, Vec<(u8, String)>>,
    /// Lower-cased basename -> number of files with it, after the move.
    base_count: HashMap<String, usize>,
    /// Lower-cased stem -> number of Markdown notes with it, after the move.
    md_stem_count: HashMap<String, usize>,
    /// Lower-cased alias -> owning note paths, after the move.
    aliases: HashMap<String, Vec<String>>,
}

impl LinkRewriter {
    /// files: ALL vault-relative file paths AFTER the move (notes and
    /// attachments, any extension).
    /// aliases: lower-cased alias -> owning note paths AFTER the move (from
    /// `Index::aliases_by_lower()`).
    /// moves: every moved file; a single rename is one entry, a folder move
    /// is all files in the subtree.
    pub fn new(files: &[String], aliases: &HashMap<String, Vec<String>>, moves: &[Move]) -> Self {
        let mut moved: HashMap<String, String> = HashMap::new();
        let mut rev: HashMap<String, String> = HashMap::new();
        for m in moves {
            moved.insert(m.from.to_lowercase(), m.to.clone());
            rev.insert(m.to.to_lowercase(), m.from.clone());
        }
        // The files as they were before the move: every current path with
        // each move turned back into its source, de-duplicated the way the
        // vault was (a case-only rename is the same file twice).
        let mut old_paths: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for f in files {
            let old = rev.get(&f.to_lowercase()).cloned().unwrap_or_else(|| f.clone());
            if seen.insert(old.to_lowercase()) {
                old_paths.push(old);
            }
        }
        for m in moves {
            if seen.insert(m.from.to_lowercase()) {
                old_paths.push(m.from.clone());
            }
        }
        let mut old_by_key: HashMap<String, Vec<(u8, String)>> = HashMap::new();
        for path in &old_paths {
            let lower = path.to_lowercase();
            for (rank, key) in keys_of(&lower) {
                old_by_key
                    .entry(key.to_string())
                    .or_default()
                    .push((rank, path.clone()));
            }
        }
        let mut base_count: HashMap<String, usize> = HashMap::new();
        let mut md_stem_count: HashMap<String, usize> = HashMap::new();
        for f in files {
            *base_count
                .entry(base_name(f).to_lowercase())
                .or_insert(0) += 1;
            if f.to_lowercase().ends_with(".md") {
                *md_stem_count
                    .entry(stem_of(f).to_lowercase())
                    .or_insert(0) += 1;
            }
        }
        Self {
            files: files.to_vec(),
            moved,
            rev,
            old_by_key,
            base_count,
            md_stem_count,
            aliases: aliases.clone(),
        }
    }

    /// The file a wikilink target named before the move: the match of best
    /// specificity, `None` when nothing or several distinct files match. A
    /// target that only matches an alias finds nothing here, so an alias
    /// link is always left alone.
    fn resolve_old(&self, target_lower: &str) -> Option<String> {
        let candidates = self.old_by_key.get(target_lower)?;
        let best = candidates.iter().map(|(rank, _)| *rank).min()?;
        let mut found: Option<String> = None;
        for (rank, path) in candidates {
            if *rank != best {
                continue;
            }
            match &found {
                Some(prev) if prev != path => return None,
                Some(_) => {}
                None => found = Some(path.clone()),
            }
        }
        found
    }

    /// Whether a name still identifies exactly one file on its own after the
    /// move: unique among the file names, and not used as an alias of any
    /// other note.
    fn name_free(&self, name_lower: &str, base_style: bool, owner: &str) -> bool {
        let count = if base_style {
            self.base_count.get(name_lower).copied()
        } else {
            self.md_stem_count.get(name_lower).copied()
        };
        count == Some(1)
            && self.aliases.get(name_lower).is_none_or(|owners| {
                owners
                    .iter()
                    .all(|p| p.to_lowercase() == owner.to_lowercase())
            })
    }

    /// The new wikilink text for the old target `t` of the file now at
    /// `new_path`, as short as it can stay (minimal diff).
    fn new_wiki_text(&self, t: &str, new_path: &str) -> String {
        let tl = t.to_lowercase();
        if t.contains('/') {
            // A path-like target keeps its form: the full new path, '.md'
            // only when the old text had it.
            if !tl.ends_with(".md") {
                if let Some(no_ext) = new_path.strip_suffix(".md") {
                    return no_ext.to_string();
                }
            }
            return new_path.to_string();
        }
        // A bare target: keep it bare while the name stays unambiguous.
        let base = base_name(new_path);
        let stem = stem_of(new_path);
        let base_style = tl == base.to_lowercase()
            || (tl != stem.to_lowercase() && tl.contains('.'));
        let cand = if base_style { base } else { stem };
        let cl = cand.to_lowercase();
        if cl == tl && self.name_free(&cl, base_style, new_path) {
            // A pure folder move: the link can stay exactly as written.
            return t.to_string();
        }
        if self.name_free(&cl, base_style, new_path) {
            return cand.to_string();
        }
        // The name collides: only the full new path is unambiguous.
        if !tl.ends_with(".md") && new_path.to_lowercase().ends_with(".md") {
            new_path.strip_suffix(".md").unwrap_or(new_path).to_string()
        } else {
            new_path.to_string()
        }
    }

    /// The replacement for one wikilink target (embeds included); `None`
    /// when the link stays as it is.
    fn wiki_replace(&self, trimmed: &str) -> Option<String> {
        let tl = trimmed.to_lowercase();
        let old = self.resolve_old(&tl)?;
        // Only a file that itself moved gets a new link text.
        let new_path = self.moved.get(&old.to_lowercase())?.clone();
        let new_text = self.new_wiki_text(trimmed, &new_path);
        (new_text != trimmed).then_some(new_text)
    }

    /// The replacement for one markdown link destination; `None` when it
    /// stays. Destinations are relative to the folder the note had before
    /// the move; for a moved note every relative destination is recomputed
    /// against its new folder, even when its target did not move.
    fn md_replace(&self, source: &str, dest: &str) -> Option<String> {
        if dest.is_empty()
            || dest.contains("://")
            || dest.starts_with("mailto:")
            || dest.starts_with('/')
        {
            return None;
        }
        let (path_part, fragment) = split_fragment(dest);
        if path_part.is_empty() || path_part.starts_with('#') {
            return None;
        }
        let had_dot = path_part.starts_with("./");
        let decoded = decode_spaces(path_part);
        let old_source = self.rev.get(&source.to_lowercase()).cloned();
        let old_parent = parent_dir(old_source.as_deref().unwrap_or(source)).to_string();
        let t_old = resolve_rel(&old_parent, &decoded)?;
        let new_target = self
            .moved
            .get(&t_old.to_lowercase())
            .cloned()
            .unwrap_or_else(|| t_old.clone());
        if new_target == t_old && old_source.is_none() {
            // Neither the note nor its target moved.
            return None;
        }
        // `source` is the path after the move, so its folder is the new one.
        let rel = rel_path(parent_dir(source), &new_target);
        let mut path_new = encode(&rel);
        // The './' form is kept only while the link stays in its folder.
        if had_dot && !path_new.contains('/') {
            path_new = format!("./{path_new}");
        }
        let new_dest = format!("{path_new}{fragment}");
        (new_dest != dest).then_some(new_dest)
    }

    /// Rewrites link targets in `content` of the note `source` (its path
    /// AFTER the move). Returns `Some(new_content)` only when at least one
    /// target span changed; every other byte stays as it is.
    pub fn rewrite(&self, source: &str, content: &str) -> Option<String> {
        let (_yaml, body) = split_frontmatter(content);
        // The frontmatter is never rewritten; the body starts here.
        let base = content.len() - body.len();
        let spans = self.scan(source, content, base);
        if spans.is_empty() {
            return None;
        }
        let mut out = String::with_capacity(content.len());
        let mut last = 0;
        for (start, end, text) in spans {
            out.push_str(&content[last..start]);
            out.push_str(&text);
            last = end;
        }
        out.push_str(&content[last..]);
        Some(out)
    }

    /// The replacement byte spans of one note, from `base` on.
    fn scan(&self, source: &str, content: &str, base: usize) -> Vec<(usize, usize, String)> {
        let b = content.as_bytes();
        let skips = collect_skips(content, base);
        let mut spans: Vec<(usize, usize, String)> = Vec::new();

        // Wikilinks first; their whole `[[ ... ]]` region is remembered so a
        // `]](x)` inside a wikilink is not mistaken for a markdown link.
        let mut wiki_regions: Vec<(usize, usize)> = Vec::new();
        let mut p = base;
        while let Some(r) = content[p..].find("[[") {
            let open = p + r;
            let inner_s = open + 2;
            let Some(rc) = content[inner_s..].find("]]") else {
                break;
            };
            let close = inner_s + rc;
            let inner = &content[inner_s..close];
            if inner.contains('\n') {
                // Not a link after all; keep looking behind it.
                p = inner_s;
                continue;
            }
            wiki_regions.push((open, close + 2));
            // The target part ends at the first '|' (alias) or '#' (heading
            // or block ref); only it can be replaced.
            let t_end = inner
                .find(['|', '#'])
                .map(|k| inner_s + k)
                .unwrap_or(close);
            let raw = &content[inner_s..t_end];
            let trimmed = raw.trim();
            let ts = inner_s + (raw.len() - raw.trim_start().len());
            let te = ts + trimmed.len();
            if !trimmed.is_empty() && !overlaps(&skips, ts, te) {
                if let Some(nt) = self.wiki_replace(trimmed) {
                    spans.push((ts, te, nt));
                }
            }
            p = close + 2;
        }

        // Markdown links and images: the destination behind ']('.
        let mut i = base;
        while i + 1 < b.len() {
            if b[i] != b']' || b[i + 1] != b'(' {
                i += 1;
                continue;
            }
            if overlaps(&wiki_regions, i, i + 2) {
                i += 2;
                continue;
            }
            // A label must open with '[' on the same line; the second '['
            // of a wikilink does not count.
            let line_start = content[..i].rfind('\n').map(|n| n + 1).unwrap_or(0);
            let label_ok = match content[line_start..i].rfind('[') {
                Some(l) => {
                    let lp = line_start + l;
                    !(lp > line_start && b[lp - 1] == b'[')
                }
                None => false,
            };
            if !label_ok {
                i += 2;
                continue;
            }
            let ds = i + 2;
            if ds >= b.len() {
                break;
            }
            if b[ds] == b'<' {
                // The '<...>' form may hold spaces; its inside is the
                // destination.
                match content[ds + 1..].find('>') {
                    Some(g) if !content[ds + 1..ds + 1 + g].contains('\n') => {
                        let gt = ds + 1 + g;
                        if !overlaps(&skips, ds, gt + 1) {
                            if let Some(nd) = self.md_replace(source, &content[ds + 1..gt]) {
                                spans.push((ds + 1, gt, nd));
                            }
                        }
                        i = gt + 1;
                        continue;
                    }
                    _ => {
                        i += 2;
                        continue;
                    }
                }
            }
            // Plain form: up to the ')' that closes it, nested parens and
            // backslash escapes counted; a newline ends the link.
            let mut depth = 1usize;
            let mut k = ds;
            while k < b.len() && b[k] != b'\n' {
                if b[k] == b'\\' && k + 1 < b.len() {
                    k += 2;
                    continue;
                }
                match b[k] {
                    b'(' => depth += 1,
                    b')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                k += 1;
            }
            if depth != 0 || k >= b.len() {
                i += 2;
                continue;
            }
            // The destination ends at the first whitespace; a title after
            // it stays byte-identical.
            let dest = content[ds..k]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
            let de = ds + dest.len();
            if !dest.is_empty() && !overlaps(&skips, ds, de) {
                if let Some(nd) = self.md_replace(source, &dest) {
                    spans.push((ds, de, nd));
                }
            }
            i = k + 1;
        }

        spans.sort_by_key(|&(start, _, _)| start);
        // Overlapping candidates can never both apply; the earlier span wins
        // (a markdown link inside a wikilink's target, for instance).
        let mut kept: Vec<(usize, usize, String)> = Vec::with_capacity(spans.len());
        let mut last_end = 0usize;
        for span in spans {
            if span.0 >= last_end && span.0 < span.1 {
                last_end = span.1;
                kept.push(span);
            }
        }
        kept
    }
}

/// Encodes spaces the way markdown link destinations need it.
fn encode(text: &str) -> String {
    if text.contains(' ') {
        text.replace(' ', "%20")
    } else {
        text.to_string()
    }
}
