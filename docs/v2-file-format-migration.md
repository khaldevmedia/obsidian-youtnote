# Migrating Youtnote files to format v2

Youtnote now uses a versioned Markdown storage format called **format v2**. This guide explains why the format changed, how to convert existing files, and how to avoid losing notes when your vault is synced across devices.

> [!WARNING]
> **Youtnote plugin 1.3.0 and older do not support format v2.** If an older plugin opens and saves a converted file, it can erase the entire plugin-managed body, including videos, notes, and transcripts. In a synced vault, that data loss can spread to your other devices. **Update Youtnote on every synced device before converting.**

The versions above refer to the **Youtnote plugin**, not the Obsidian application. Updating Obsidian alone does not make an older Youtnote plugin understand the new format.

## Why a new format was needed

The legacy format used Markdown links as internal markers for videos and timestamped notes. Youtnote `1.3.0`, the last release to use that format, does not support transcripts or AI-generated notes. The `1.4.0` release introduces those features and format v2, with clearer rules for separating and preserving the new content.

Format v2 improves storage in four ways:

- **Clear boundaries:** the whole plugin-managed body sits inside a `youtnote:file` root wrapper. Each video has its own block, with a `youtnote:source` section holding the title and raw YouTube URL in separate fields, a `youtnote:notes` section with each note in its own marker pair, and an optional `youtnote:transcript` section. The plugin does not have to infer all of that structure from ordinary Markdown links.
- **A cleaner link graph:** format v2 replaces the legacy timestamp and general-note Markdown-link markers with HTML comments, removing the synthetic links those markers created in Obsidian's Graph view. Transcript captions, introduced in Youtnote `1.4.0` alongside format v2, use HTML-comment markers from the start. Normal links you intentionally add to your notes still appear in Obsidian's Graph view.
- **Explicit versioning:** the `youtnote-format-version` property identifies the format. The updated plugin refuses unsupported newer versions rather than partially parsing and rewriting them.
- **Safer future additions:** unrelated frontmatter and unknown file-level or video-level sections are preserved. This allows compatible additions without throwing away content that an older v2 reader does not understand.

Files remain ordinary `.md` files in your vault. Format v2 does not require a new file extension or a separate database. Custom frontmatter stays byte-for-byte intact, and the plugin only rewrites the marker structure it owns inside the file wrapper. For a complete example of the canonical layout, see the [storage format section of the README](../README.md#storage-format).

## Before you convert

1. **Make a backup** of the files you plan to convert. The conversion dialog creates a same-folder copy by default (see below), but that copy lives inside the same synced vault and stays in the legacy format — it is not an independent disaster-recovery backup. Keep your own vault backups as well.
2. **Update Youtnote on every device that uses the synced vault**, including phones, tablets, and computers you use less often. Install a plugin version that supports format v2. Youtnote `1.3.0` and older are not compatible.
3. If any device still uses an older plugin, **postpone conversion and choose Open read-only** in the updated plugin. Your legacy files can remain in the old format until every device is ready.

## How to migrate

1. Open an existing legacy youtnote in the updated plugin. Unversioned files and files explicitly declaring format version 1 are treated as legacy files.
2. Read the conversion dialog, including the warning about older plugin versions and synced devices.
3. Review the **Create a backup before converting** option, which is checked by default. With it checked, Youtnote first saves the exact source snapshot used for conversion — read after you confirm, including frontmatter and whitespace — in the same folder. The copy is named `name - legacy backup.md` next to `name.md`; if that name is already taken, the next free numbered name is used (`name - legacy backup 2.md`, `name - legacy backup 3.md`, ...), and existing files are never overwritten. The backup copy stays in the legacy format, and links to the file still point at the original. Uncheck the option to convert without a backup.
4. Choose one of the following:
   - **Convert to v2:** converts this file in place under its existing name, checks the result, and enables editing. Videos, timestamped notes, and general notes are retained. If the backup cannot be created, or the file changes while the conversion is being prepared, the conversion stops and the original is left untouched — you can try again. If conversion itself fails after a backup was written, the backup is kept.
   - **Open read-only:** displays the existing content without converting or saving the source file. No backup is created. Playback, searching, copying, and export remain available, but editing is disabled.
5. After conversion, check the file's videos and notes, then make a small edit and reopen the file to confirm it persists. Keep your backups until you are satisfied with the result.

Closing the dialog also chooses read-only. You can convert later while the file is open as read-only by clicking the **See options** button in the read-only banner. It shows the convert popup again.

Conversion is **per file**. There is no automatic-conversion preference or bulk conversion. A file already using format v2 does not need conversion and does not show the legacy conversion dialog.

Read-only is a protection inside Youtnote, not a file lock: another plugin, the regular Markdown editor, or another device can still change the file.

## Why older plugin versions can lose your notes

An older Youtnote parser does not recognize v2's HTML-comment structure, including the wrapped video source sections. Videos, notes, and transcripts can all be missing from the old plugin's view. When that plugin saves its partially parsed data, the unrecognized content can be removed from the file.

Saving may happen automatically or while closing or switching files. **Do not assume a converted file is safe just because you did not intentionally edit it in the older plugin.**

Once a file is converted:

- Do not open it through Youtnote `1.3.0` or older, including on another synced device.
- Do not downgrade the plugin while continuing to use converted files.
- If a device cannot be updated, keep it from opening converted files through the older plugin. For ordinary Markdown viewing on that device, disable the incompatible plugin first.

## Identifying a v2 file and handling problems

A v2 file declares this property in its frontmatter:

```yaml
youtnote-format-version: 2
```

**Adding this property to a legacy file is not a migration.** Likewise, deleting it or changing it to `1` does not convert v2 content back to the old syntax. Use the conversion dialog. The plugin does not provide a built-in v2-to-v1 downgrade.

If conversion fails, reopen the file, check its contents, and compare it with your backup before retrying. Do not assume a failed operation left the file unchanged.

If an older plugin has already removed content, update or disable that plugin on all affected devices before restoring a good copy from your backup, sync version history, or Obsidian File recovery, if available. Changing the format version number cannot recover deleted notes.

## Reporting migration issues

If you encounter any problems related to migrating to format v2, please [open a GitHub issue](https://github.com/khaldevmedia/obsidian-youtnote/issues).

Include your Youtnote and Obsidian versions, your operating system, the steps that led to the problem, and any error messages. If possible, provide a minimal example file that reproduces the issue, with private or sensitive content removed.
