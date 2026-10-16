# URI Scheme Guide

The Youtnote plugin supports an `obsidian://youtnote` URI scheme that lets external tools (DataviewJS scripts, other plugins, browser bookmarks, shell scripts, automation workflows) programmatically add videos and notes to your vault.

## Enabling the feature

The URI scheme is **disabled by default** for security. To enable it:

1. Open `Settings → Youtnote`.
2. Scroll to the **Advanced** section.
3. Toggle **Enable uri scheme** on.

When disabled, any `obsidian://youtnote` URI will show a notice and do nothing: no parameters are parsed or processed.

## Security considerations

The URI scheme is a write channel into your vault. Keep the following in mind:

- **Any external source can trigger it while enabled.** Once the toggle is on, any webpage, document, bookmark, or script that opens an `obsidian://youtnote` URI will invoke the handler. A click is not always required (for example, a page can embed the URI in an image source).
- **`mode=append`, `mode=note`, and `mode=general-note` write to the first open Youtnote view** (or create a new one if none is open) without asking for confirmation. See [Choosing the target Youtnote](#choosing-the-target-youtnote) for exactly which view receives the mutation.
- **Leave it disabled when you are not using it.** Turn the toggle on only while your automation actually needs it.
- **Do not click `obsidian://youtnote` links from sources you do not trust.**

What the handler will never do: accept file paths, write outside the youtnote it targets, run commands, or accept parameters other than `url`, `mode`, `timestamp`, and `text`. See [Safeguards](#safeguards) below.

## URI format

```
obsidian://youtnote?url=<YouTube_URL>&mode=<MODE>&timestamp=<TIMESTAMP>&text=<NOTE_TEXT>
```

### Parameters

| Parameter | Required | Description |
|---|---|---|
| `url` | Yes | A valid YouTube URL. Accepts standard watch URLs, `youtu.be`, Shorts, Live, and embed URLs. On Obsidian older than `1.13.4` the value must be URL-encoded (see below). |
| `mode` | Yes | One of: `new`, `append`, `note`, `general-note`. |
| `timestamp` | Only for `mode=note` | A timestamp string (e.g. `90`, `1:23`, `12:50`). Validated against the video's actual duration before the note is added. |
| `text` | Only for `mode=note` and `mode=general-note` | The note content, URL-encoded. Stored as-is in the note body. Max 1000 characters. Must not start with `---` (frontmatter marker) and must not contain a line that would parse as a youtnote structural marker: a `[title](YouTube URL)` link, or any `<!-- youtnote:... -->` boundary line (with or without attributes), which covers the file, video, source, title, url, notes, transcript, general-note, timestamped-note, and unknown extension containers (the legacy link-style `[mm:ss](timestamp)` and `[general-note](general-note)` forms and the earlier development markers are rejected too). |

All other parameters are rejected with an error notice.

### Encoding the `url` parameter on Obsidian older than 1.13.4

Obsidian versions before `1.13.4` cut a parameter value off at its second `=`. A raw `watch?v=` URL therefore arrives as `https://www.youtube.com/watch?v` and is rejected with `The "url" parameter is not a valid YouTube URL.` To support these versions, URL-encode the `url` value (e.g. `encodeURIComponent()` in JavaScript):

#### Raw: works on Obsidian 1.13.4 and later only
```
obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=new
```
#### Encoded: works on every supported Obsidian version
```
obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=new
```
> [!IMPORTANT]
> **On every version of Obsidian**
>
> Encoding is required on **every version** when the YouTube URL itself contains `&` (for example a `&list=` playlist parameter); otherwise the part after `&` is treated as a separate, unsupported parameter.
>
> It is recommended to always use encoding to avoid issues. The executable examples in the rest of this guide encode the `url` parameter by default; the `text` parameter is still a separately encoded parameter.

## Choosing the target Youtnote

For `mode=append`, `mode=note`, and `mode=general-note`, the handler writes to the **first open Youtnote view** found by Obsidian. This is important to get right:

- **First open view, not the active view.** The handler picks the first leaf whose view is a Youtnote view, regardless of which tab is focused or visible.
- **No video search.** The handler does not look for a Youtnote that already contains the video. If the selected file does not contain it, the video may be added to that file instead of finding a file that does.
- **Ordinary Markdown views do not count.** Only a leaf showing the Youtnote view qualifies. An unrelated Markdown note can stay open, but a Youtnote file open in plain Markdown mode is ignored.
- **No file or path parameter exists.** There is no way to name a target file in the URI, so the open view is the only selector.

This means two risk scenarios:

- `mode=append` can add a video to the wrong file if a different Youtnote view happens to be the first open one.
- `mode=note` and `mode=general-note` can attach the note to the wrong copy of the video when the same video exists in multiple Youtnote files.

Before invoking a mutating URI, close all other Youtnote views (including tabs and split windows) and leave only the intended file open in its Youtnote view. If no Youtnote view is open at all, these modes fall back to creating a new file, while `mode=new` always creates a new file regardless of what is open.

Read-only files are never written: a legacy file that has not been converted blocks mutations with an error, and no automatic conversion happens. See [Safeguards](#safeguards).

## Modes

### `mode=new`: Create a new Youtnote with a video

Creates a new Youtnote file, adds the video, and opens it. This mode ignores any open views and always creates a new file.

```
obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=new
```

### `mode=append`: Add a video to the open Youtnote

Adds the video to the first open Youtnote view (see [Choosing the target Youtnote](#choosing-the-target-youtnote)). If no Youtnote view is open, falls back to creating a new file. If the video already exists in that file, it is selected and a warning notice is shown without writing.

```
obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=append
```

### `mode=note`: Add a timestamped note to a video

Adds a timestamped note to the specified video in the first open Youtnote view (see [Choosing the target Youtnote](#choosing-the-target-youtnote)). If the video doesn't exist in that file, it's added first. If no Youtnote view is open, a new file is created. The timestamp is validated against the video's actual duration (obtained from the YouTube player); if it exceeds the duration, the note is rejected.

```
obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=note&timestamp=1:23&text=This%20moment%20is%20great
```

### `mode=general-note`: Add a general note to a video

Adds a timestamp-less general note to the specified video in the first open Youtnote view (see [Choosing the target Youtnote](#choosing-the-target-youtnote)). If the video doesn't exist in that file, it's added first; if no Youtnote view is open, a new file is created and the video and general note are added there. Only one general note is allowed per video; if one already exists, a warning notice is shown and nothing is written.

```
obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=general-note&text=Summary%3A%20This%20video%20covers%20...
```

## Examples

### Shell (Linux)

```bash
xdg-open "obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=new"
```

### Shell (macOS)

```bash
open "obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=new"
```

### Python

```python
import webbrowser
webbrowser.open("obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=note&timestamp=90&text=Interesting%20point")
```

### DataviewJS (inside Obsidian)

```js
const url = "obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=append";
window.open(url);
```

### Markdown link

```markdown
[Add video to Youtnote](obsidian://youtnote?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&mode=append)
```

## How timestamps are validated

When using `mode=note`, the timestamp goes through two validation stages:

1. **Syntax validation** (at the URI layer): Accepts seconds, `minutes:seconds`, and `hours:minutes:seconds` forms; decimal inputs are accepted and the total is floored to whole seconds. There is no fixed cap and no `00`–`59` range check on subordinate components at this stage, so values like `1:99` are accepted syntactically.
2. **Duration validation** (after the player loads): The video is selected as active, which triggers the YouTube player to load it. Once the player reports the video's duration, the timestamp is checked against it. If the timestamp exceeds the duration, the note is rejected.

If the video was previously played in a Youtnote, its duration is already known and validation is instant. If the video can't be loaded (private, embedding-blocked, or player timeout), the note is rejected rather than accepted with an unvalidated timestamp. Be aware that duration validation happens late in the flow: if the video had to be auto-added to the open file, or a new file had to be created first, that video or file remains even though the note was rejected.

## Notices

All handled URI scheme outcomes (success, warning, and error) display a **persistent notice** that stays visible until you dismiss it, including the disabled-scheme notice. This ensures you see the result even if you weren't looking at Obsidian when the URI was invoked.

- **Successes** use a normal notice (for example `Youtnote created with video.` or `Note added to video.`).
- **Duplicate cases** use a warning notice styled with the theme's warning foreground (`var(--text-warning)`, typically orange): `Video already exists in this youtnote.` and `A general note already exists for this video.` Nothing is written in these cases.
- **Errors** use an error notice styled with the theme's error foreground (`var(--text-error)`, typically red) and prefixed with `Youtnote uri scheme error:`.

One outcome has no notice at all: a second invocation arriving within 500 ms of the previous one is silently ignored (see debounce under [Safeguards](#safeguards)).

## Safeguards

- **Max URL length**: The handler rebuilds the `obsidian://youtnote?` URI from the decoded values of the allowed parameters using `URLSearchParams`, and the 2000 character limit applies to that re-encoded result, not to the raw incoming string or the decoded length.
- **Max `url` parameter**: 500 characters (decoded).
- **Max `text` parameter**: 1000 characters (decoded, measured as JavaScript string length).
- **Debounce**: Rapid invocations within 500ms are silently ignored with no notice.
- **No file paths**: The handler never accepts `path`, `file`, or `filename` parameters. Filenames are always generated internally.
- **No unsupported parameters**: Any parameter other than `url`, `mode`, `timestamp`, and `text` is rejected.
- **No frontmatter injection**: Note text that begins with `---` after optional leading whitespace is rejected.
- **No structural-marker injection**: Note text containing a line that would be parsed as a video link or as a format-2 boundary marker is rejected. That covers every `<!-- youtnote:<type>:start -->` / `<!-- youtnote:<type>:end -->` line, including attributes and leading whitespace, no or extra whitespace after `<!--`, and unknown or malformed `youtnote:` marker types: `file`, `video`, `source`, `title`, `url`, `notes`, `transcript`, `general-note`, `timestamped-note`, and any unknown extension type. The check is line-based, so it applies even inside fenced code blocks. Legacy link-style markers (`[mm:ss](timestamp)`, `[general-note](general-note)`) and earlier development markers (such as `` `mm:ss` <!-- youtnote:timestamp --> ``) are rejected as well.
- **Safe lookalikes stay accepted**: A caption-metadata line like `<!-- t=0:05 d=1200 -->` is stored as ordinary note text, never as a transcript entry. Marker text that does not start a line, lines beginning with a backslash (stored escaped on save), and unrelated HTML comments are all accepted.
- **Read-only and legacy files**: A Youtnote file open read-only (including the legacy v1 read-only preview) rejects mutations with an error notice. Nothing is written or rewritten and no automatic conversion happens. One exception: appending a video that is already present only selects it and shows a warning, even on a read-only file, since no write is needed. To mutate a legacy file via URI, first convert it per file through the view banner (see the [migration guide](v2-file-format-migration.md)).
- **v2 storage integrity**: Mutations go through the same serializer as the editor, so custom frontmatter is preserved verbatim and only the plugin-managed body between `<!-- youtnote:file:start -->` and `<!-- youtnote:file:end -->` changes. Unsupported or malformed files fail closed instead of being partially rewritten.
- **One note per call**: No bulk operations.
