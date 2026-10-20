# Storage format

Youtnote files are plain Markdown identified by a top-level `youtnote: true` frontmatter property (`youtnote: yes` is also recognized) plus a versioned storage format declared by the `youtnote-format-version` frontmatter property (the Youtnote file-format version). The current version is **2**, which wraps the entire plugin-managed body in `<!-- youtnote:file:start -->` / `<!-- youtnote:file:end -->` markers. Inside the file wrapper, each video lives in a `<!-- youtnote:video:start -->` / `<!-- youtnote:video:end -->` block containing a `<!-- youtnote:source:... -->` section (title and raw YouTube URL in their own `<!-- youtnote:title:... -->` and `<!-- youtnote:url:... -->` fields), exactly one `<!-- youtnote:notes:... -->` section, and at most one `<!-- youtnote:transcript:... -->` section. Unrelated frontmatter and unknown sections are preserved untouched.

A complete file looks like this:

```markdown
---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:file:start -->

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
Test Video
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=aircAruvnKk
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
Overview of the video.
<!-- youtnote:general-note:end -->

<!-- youtnote:timestamped-note:start t=1:23 -->
First timestamped note.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:transcript:start -->
<!-- t=0:00.320 d=14260 --> [Music]
<!-- t=5 d=0 --> hello
<!-- youtnote:transcript:end -->

<!-- youtnote:video:end -->

<!-- youtnote:file:end -->
```

Inside a notes section, each record uses an HTML-comment structural marker rather than a Markdown link, so these generated markers do not create synthetic entries in Obsidian's link graph:

- **Timestamped notes**: each note is individually wrapped in `<!-- youtnote:timestamped-note:start t=M:SS -->` and `<!-- youtnote:timestamped-note:end -->`, where `t` is a whole-second timestamp in `S`, `M:SS`, or `H:MM:SS` form, with seconds after a colon and minutes in the hour form in `00` to `59`. The note body is arbitrary Markdown between the markers, with leading and trailing whitespace preserved.
- **General note**: a body wrapped in `<!-- youtnote:general-note:start -->` and `<!-- youtnote:general-note:end -->`.
- **Title**: the exact fetched or authored title text between the title markers, which may be empty or span multiple lines.
- **Caption** (transcript section): one line per caption, `<!-- t=M:SS.mmm d=N --> caption text`, with exactly one space between the closing comment and the caption text. `d` is a mandatory nonnegative duration in milliseconds, and `d=0` means YouTube did not provide a usable positive duration. Caption text is a single physical line, so `\`, carriage return, and line feed are stored as the escape sequences `\\`, `\r`, and `\n`.
- **Literal content codec**: inside note bodies and titles, a line that would collide with the format is stored with one leading backslash. This covers lines starting with a backslash, lines whose trimmed form starts with `<!--` followed by optional whitespace and `youtnote:`, and Markdown fence delimiter lines (backtick or tilde runs of three or more, with Markdown indentation allowed). Escaped lines are decoded back to their exact text, so the stored file never changes what a note contains: an unfinished code fence cannot swallow the surrounding markers, and marker-looking text stays literal.
- **Unmanaged sections**: `<!-- youtnote:<type>:start -->` … `<!-- youtnote:<type>:end -->` blocks with types Youtnote does not manage are preserved verbatim, marker attributes and body content included, and marker-looking text inside fenced code blocks stays opaque content. The reserved names `file`, `video`, `source`, `title`, `url`, `notes`, `general-note`, `timestamped-note`, and `transcript` are managed by Youtnote and cannot appear as unmanaged containers. Unknown sections inside a video block stay attached to that video's layout. Unknown sections at file level are preserved (including in files with no videos) and are canonically written inside the file wrapper before all videos. This release preserves file-level sections but provides no editing UI for them.
- **Per-file conversion**: older files (unversioned or `youtnote-format-version: 1`) are never rewritten automatically. Opening one in the Youtnote view shows a per-file dialog — **Open read-only** or **Convert to v2** — and dismissing it keeps the file read-only. A read-only file cannot be modified from inside Youtnote and is never written back until you choose to convert it; other plugins, the Markdown editor, or other devices can still change the file — read-only is a Youtnote-side protection, not a file lock. There is no automatic-conversion preference and no bulk conversion; every file asks individually. Conversion rewrites the original file in place under its existing name into version-2 markers that older plugin versions cannot read, so update Youtnote on every device that syncs the vault before converting. If the file was already converted to version 2 elsewhere, it simply opens without rewriting its data.
- **Pre-conversion backup**: the conversion dialog's **Create a backup before converting** option is checked by default. Before rewriting, Youtnote saves the exact source snapshot used for conversion — read after you confirm — in the same folder, named `name - legacy backup.md` (or `name - legacy backup 2.md`, `name - legacy backup 3.md`, and so on if that name is already taken — existing files are never overwritten). Uncheck the option to convert without a backup; choosing **Open read-only** or closing the dialog never creates one. If the backup cannot be created, or the file changes while the conversion is being prepared, the conversion stops and the original is left untouched — you can try again. If conversion itself fails after a backup was written, the backup is kept. The backup copy remains in the legacy format, incoming links still point at the original file, and a copy inside the synced vault is not an independent disaster-recovery backup — keep your own vault backups as well.
- **Newer formats**: a file declaring a higher `youtnote-format-version` (e.g. written by a newer plugin version) is never parsed or rewritten — it fails closed and opens in the regular Markdown view with an explanatory message.
- **Downgrading**: an older plugin version does not understand version-2 markers. If you convert a file and then downgrade the plugin, the old plugin will not be able to read the file correctly.

## Format evolution

New, independent data that older readers can safely ignore may be added inside new opaque `youtnote:<type>` containers or frontmatter without bumping the file-format version. Changes to existing syntax or semantics that older readers cannot preserve or ignore require bumping `youtnote-format-version`; files declaring a version above the supported one are always rejected rather than partially read.
