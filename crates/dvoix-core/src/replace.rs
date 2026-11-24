//! Search and replace across the notes of a vault.
//!
//! A replacement is text work on the whole note, so every match can be found
//! no matter where it sits: middle of a word, frontmatter, code block. Only
//! the bytes of the matches change; the rest of the file stays exactly as it
//! was, including line endings, comments and table padding (rule 4). Writes go
//! through [`Vault::write`], which replaces the file atomically.
//!
//! The in-note replace in the editor and this module share their options:
//! match case, whole word and regular expressions.

use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::vault::{Vault, VaultEntry};
use crate::{Error, Result};

/// How a search pattern is matched. The defaults match the in-note replace:
/// case-insensitive literal text.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReplaceOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

/// One note the replacement changed, with the text from before for an undo.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFile {
    pub path: String,
    pub previous_content: String,
    /// The disk state after the write; an undo can use it as the expected base.
    pub entry: VaultEntry,
}

/// What a preview or a replacement found.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    /// The notes with at least one match, in the order they were scanned.
    pub paths: Vec<String>,
    /// How many occurrences were (or would be) replaced.
    pub replacements: usize,
    /// The rewritten notes. Empty for a preview.
    pub files: Vec<ReplacedFile>,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Builds the matcher for a query. A literal query is escaped, so `$` and `.`
/// keep their meaning as text; a regular expression is used as written.
fn build(query: &str, options: ReplaceOptions) -> Result<Regex> {
    let mut pattern = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if options.whole_word {
        if options.regex {
            pattern = format!(r"\b(?:{pattern})\b");
        } else {
            // Only add a boundary where the query itself starts or ends with a
            // word character. `\b` around `#tag` or `...` would never match.
            let start = query.chars().next().is_some_and(is_word_char);
            let end = query.chars().next_back().is_some_and(is_word_char);
            if start {
                pattern = format!(r"\b{pattern}");
            }
            if end {
                pattern = format!(r"{pattern}\b");
            }
        }
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| Error::InvalidRegex(e.to_string()))
}

/// Replaces every match in one text. Returns the new text and how many matches
/// there were; a preview and a real replacement count the same way.
pub fn replace_text(
    text: &str,
    query: &str,
    replacement: &str,
    options: ReplaceOptions,
) -> Result<(String, usize)> {
    if query.is_empty() {
        return Ok((text.to_string(), 0));
    }
    let matcher = build(query, options)?;
    let count = matcher.find_iter(text).count();
    if count == 0 {
        return Ok((text.to_string(), 0));
    }
    // In a plain replacement `$1` is literal text, like in the in-note replace;
    // only a regular expression expands capture groups.
    let next = if options.regex {
        matcher.replace_all(text, replacement).into_owned()
    } else {
        matcher
            .replace_all(text, NoExpand(replacement))
            .into_owned()
    };
    Ok((next, count))
}

/// Replaces in every given note and writes the changed ones.
///
/// With `dry_run` nothing is written: the result names the notes and counts
/// the matches, so the UI can ask before changing anything.
pub fn replace_in_vault(
    vault: &Vault,
    paths: &[String],
    query: &str,
    replacement: &str,
    options: ReplaceOptions,
    dry_run: bool,
) -> Result<ReplaceOutcome> {
    let mut outcome = ReplaceOutcome::default();
    if query.is_empty() {
        return Ok(outcome);
    }
    // Fail on a broken pattern even when there is nothing to scan.
    let matcher = build(query, options)?;
    for path in paths {
        let text = match vault.read(path) {
            Ok(text) => text,
            // Vanished between listing and now: nothing to replace there.
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let count = matcher.find_iter(&text).count();
        if count == 0 {
            continue;
        }
        let next = if options.regex {
            matcher.replace_all(&text, replacement).into_owned()
        } else {
            matcher
                .replace_all(&text, NoExpand(replacement))
                .into_owned()
        };
        if next == text {
            continue;
        }
        outcome.paths.push(path.clone());
        outcome.replacements += count;
        if dry_run {
            continue;
        }
        let entry = vault.write(path, &next)?;
        outcome.files.push(ReplacedFile {
            path: path.clone(),
            previous_content: text,
            entry,
        });
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Index;

    fn literal() -> ReplaceOptions {
        ReplaceOptions::default()
    }

    fn whole_word() -> ReplaceOptions {
        ReplaceOptions {
            whole_word: true,
            ..ReplaceOptions::default()
        }
    }

    #[test]
    fn replaces_case_insensitively_by_default() {
        let (text, count) = replace_text("Foo foo FOO", "foo", "bar", literal()).unwrap();
        assert_eq!(text, "bar bar bar");
        assert_eq!(count, 3);
    }

    #[test]
    fn match_case_can_be_required() {
        let options = ReplaceOptions {
            case_sensitive: true,
            ..ReplaceOptions::default()
        };
        let (text, count) = replace_text("Foo foo", "foo", "bar", options).unwrap();
        assert_eq!(text, "Foo bar");
        assert_eq!(count, 1);
    }

    #[test]
    fn whole_word_keeps_substrings() {
        let (text, count) =
            replace_text("cat concatenate cat.", "cat", "dog", whole_word()).unwrap();
        assert_eq!(text, "dog concatenate dog.");
        assert_eq!(count, 2);
    }

    #[test]
    fn whole_word_handles_punctuation_edges() {
        let (text, count) =
            replace_text("#tag and #tagged", "#tag", "#done", whole_word()).unwrap();
        assert_eq!(text, "#done and #tagged");
        assert_eq!(count, 1);
    }

    #[test]
    fn literal_replacement_does_not_expand_groups() {
        let (text, _) = replace_text("price", "price", "$1", literal()).unwrap();
        assert_eq!(text, "$1");
    }

    #[test]
    fn regex_replaces_and_expands_groups() {
        let options = ReplaceOptions {
            regex: true,
            ..ReplaceOptions::default()
        };
        let (text, count) = replace_text("a@b and c@d", r"(\w+)@(\w+)", "$2@$1", options).unwrap();
        assert_eq!(text, "b@a and d@c");
        assert_eq!(count, 2);
    }

    #[test]
    fn regex_is_case_insensitive_unless_asked_otherwise() {
        let options = ReplaceOptions {
            regex: true,
            ..ReplaceOptions::default()
        };
        let (text, _) = replace_text("ABC abc", "[a-c]+", "x", options).unwrap();
        assert_eq!(text, "x x");
    }

    #[test]
    fn invalid_regex_is_an_error() {
        let options = ReplaceOptions {
            regex: true,
            ..ReplaceOptions::default()
        };
        assert!(matches!(
            replace_text("text", "(", "x", options),
            Err(Error::InvalidRegex(_))
        ));
    }

    #[test]
    fn empty_query_changes_nothing() {
        assert_eq!(
            replace_text("abc", "", "x", literal()).unwrap(),
            ("abc".to_string(), 0)
        );
    }

    #[test]
    fn only_the_matches_change_byte_for_byte() {
        let text = "---\r\ntitle: Foo # keep\r\n---\r\n\r\nA Foo and a foo.\r\n";
        let (next, count) = replace_text(text, "foo", "Bar", literal()).unwrap();
        assert_eq!(count, 3);
        assert_eq!(
            next,
            "---\r\ntitle: Bar # keep\r\n---\r\n\r\nA Bar and a Bar.\r\n"
        );
        // Everything outside the matches, including CRLF and the comment, stays.
        assert_eq!(next.len(), text.len());
    }

    #[test]
    fn a_replacement_with_the_same_text_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("note.md", "same").unwrap();
        let outcome = replace_in_vault(
            &vault,
            &["note.md".to_string()],
            "same",
            "same",
            literal(),
            false,
        )
        .unwrap();
        assert!(outcome.paths.is_empty());
        assert!(outcome.files.is_empty());
        assert_eq!(outcome.replacements, 0);
    }

    #[test]
    fn replaces_only_the_matching_notes_and_can_be_undone() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("a.md", "one foo two\n").unwrap();
        vault.write("b.md", "nothing here\n").unwrap();
        vault.write("nested/c.md", "foo\r\nbar foo\r\n").unwrap();

        let outcome = replace_in_vault(
            &vault,
            &["a.md".into(), "b.md".into(), "nested/c.md".into()],
            "foo",
            "baz",
            literal(),
            false,
        )
        .unwrap();

        assert_eq!(outcome.paths, vec!["a.md", "nested/c.md"]);
        assert_eq!(outcome.replacements, 3);
        assert_eq!(vault.read("a.md").unwrap(), "one baz two\n");
        assert_eq!(vault.read("b.md").unwrap(), "nothing here\n");
        assert_eq!(vault.read("nested/c.md").unwrap(), "baz\r\nbar baz\r\n");
        assert_eq!(outcome.files.len(), 2);
        assert_eq!(outcome.files[0].previous_content, "one foo two\n");

        // The previous text and the new disk state bring the file back.
        for file in &outcome.files {
            vault
                .write_checked(
                    &file.path,
                    &file.previous_content,
                    Some(file.entry.modified),
                    Some(file.entry.size),
                )
                .unwrap();
        }
        assert_eq!(vault.read("a.md").unwrap(), "one foo two\n");
        assert_eq!(vault.read("nested/c.md").unwrap(), "foo\r\nbar foo\r\n");
    }

    #[test]
    fn a_preview_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("a.md", "foo foo").unwrap();
        let outcome =
            replace_in_vault(&vault, &["a.md".into()], "foo", "bar", literal(), true).unwrap();
        assert_eq!(outcome.paths, vec!["a.md"]);
        assert_eq!(outcome.replacements, 2);
        assert!(outcome.files.is_empty());
        assert_eq!(vault.read("a.md").unwrap(), "foo foo");
    }

    #[test]
    fn index_lists_every_note_for_the_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.write("a.md", "one").unwrap();
        vault.write("b.md", "two").unwrap();
        vault.write("board.canvas", "{}").unwrap();
        let mut index = Index::open_in_memory().unwrap();
        for path in ["b.md", "a.md", "board.canvas"] {
            index.update(&vault, path).unwrap();
        }
        assert_eq!(index.note_paths().unwrap(), vec!["a.md", "b.md"]);
    }
}
