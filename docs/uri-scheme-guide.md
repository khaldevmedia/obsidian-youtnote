# URI Scheme Guide

The Youtnote plugin supports an `obsidian://youtnote` URI scheme that lets external tools (DataviewJS scripts, other plugins, browser bookmarks, shell scripts, automation workflows) programmatically add videos and notes to your vault.

## Enabling the feature

The URI scheme is **disabled by default** for security. To enable it:

1. Open `Settings → Plugin Options → Youtnote`.
2. Scroll to the **Other options** section.
3. Toggle **Enable uri scheme** on.

When disabled, any `obsidian://youtnote` URI will show a notice and do nothing: no parameters are parsed or processed.

## URI format

```
obsidian://youtnote?url=<YouTube_URL>&mode=<MODE>&timestamp=<TIMESTAMP>&text=<NOTE_TEXT>
```

### Parameters

| Parameter | Required | Description |
|---|---|---|
| `url` | Yes | A valid YouTube URL. Accepts standard watch URLs, `youtu.be`, Shorts, Live, and embed URLs. |
| `mode` | Yes | One of: `new`, `append`, `note`, `general-note`. |
| `timestamp` | Only for `mode=note` | A timestamp string (e.g. `90`, `1:23`, `12:50`). Validated against the video's actual duration before the note is added. |
| `text` | Only for `mode=note` and `mode=general-note` | The note content, URL-encoded. Stored as-is in the note body. Max 1000 characters. Must not start with `---` (frontmatter marker). |

All other parameters are rejected with an error notice.

## Modes

### `mode=new`: Create a new Youtnote with a video

Creates a new Youtnote file, adds the video, and opens it.

```
obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=new
```

### `mode=append`: Add a video to the open Youtnote

Adds the video to the currently open Youtnote. If no Youtnote is open, falls back to creating a new one. If the video already exists, selects it and shows a notice.

```
obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=append
```

### `mode=note`: Add a timestamped note to a video

Adds a timestamped note to the specified video. If the video doesn't exist in the open Youtnote, it's added first. If no Youtnote is open, a new one is created. The timestamp is validated against the video's actual duration (obtained from the YouTube player); if it exceeds the duration, the note is rejected.

```
obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=note&timestamp=1:23&text=This%20moment%20is%20great
```

### `mode=general-note`: Add a general note to a video

Adds a timestamp-less general note to the specified video. Only one general note is allowed per video; if one already exists, the request is rejected with a notice.

```
obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=general-note&text=Summary%3A%20This%20video%20covers%20...
```

## Examples

### Shell (Linux)

```bash
xdg-open "obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=new"
```

### Shell (macOS)

```bash
open "obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=new"
```

### Python

```python
import webbrowser
webbrowser.open("obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=note&timestamp=90&text=Interesting%20point")
```

### DataviewJS (inside Obsidian)

```js
const url = "obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=append";
window.open(url);
```

### Markdown link

```markdown
[Add video to Youtnote](obsidian://youtnote?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=append)
```

## How timestamps are validated

When using `mode=note`, the timestamp goes through two validation stages:

1. **Syntax validation** (at the URI layer): Checks the format is valid (digits and colons only, no negative values, no empty segments).
2. **Duration validation** (after the player loads): The video is selected as active, which triggers the YouTube player to load it. Once the player reports the video's duration, the timestamp is checked against it. If the timestamp exceeds the duration, the note is rejected.

If the video was previously played in a Youtnote, its duration is already known and validation is instant. If the video can't be loaded (private, embedding-blocked, or player timeout), the note is rejected rather than accepted with an unvalidated timestamp.

## Notices

All URI scheme outcomes (both successes and errors) display a **persistent notice** (stays visible until you dismiss it). This ensures you see the result even if you weren't looking at Obsidian when the URI was invoked.

## Safeguards

- **Max URL length**: 2000 characters total.
- **Max `url` parameter**: 500 characters.
- **Max `text` parameter**: 1000 characters (decoded).
- **Debounce**: Rapid invocations within 500ms are ignored.
- **No file paths**: The handler never accepts `path`, `file`, or `filename` parameters. Filenames are always generated internally.
- **No unsupported parameters**: Any parameter other than `url`, `mode`, `timestamp`, and `text` is rejected.
- **No frontmatter injection**: Note text starting with `---` is rejected.
- **One note per call**: No bulk operations.
