---
name: create-youtnote
description: "Youtnote is an Obsidian plugin that lets you take timestamped Markdown notes across multiple embedded YouTube videos inside a single note. This skill converts an already-fetched, timestamped YouTube transcript into a valid Youtnote markdown file (with `youtnote: true` frontmatter) that the plugin renders correctly. Use this skill whenever the user has a transcript (or transcript segments) in hand and asks to create a Youtnote, build a `.youtnote.md` file, turn a transcript into timestamped Obsidian notes, or format transcript segments into the Youtnote syntax. This skill does NOT fetch transcripts; assume the transcript already exists (fetched by the user or another skill)."
---

# Create Youtnote

Take an already-fetched, timestamped YouTube transcript and write it as a Youtnote markdown file that the Obsidian Youtnote plugin can open and render. This skill does not fetch transcripts — it consumes one that already exists.

## What a Youtnote file is

A plain Markdown file with `youtnote: true` frontmatter. The Youtnote plugin parses it into an interactive video + notes view. The file format is strict — deviating from it breaks parsing. Follow the syntax below exactly.

## File format (must match exactly)

```markdown
---
youtnote: true
---

[Video Title](https://www.youtube.com/watch?v=VIDEO_ID)

[general-note](general-note)
Optional general note body. One per video at most. Sits at the top of the video's notes.

[01:23](timestamp)
First timestamped note body.

[02:45](timestamp)
Second timestamped note body.

[Next Video Title](https://www.youtube.com/watch?v=NEXT_VIDEO_ID)

[00:10](timestamp)
Note body for the next video.
```

### Structural rules

1. **Frontmatter** — first three lines, exactly:
   ```
   ---
   youtnote: true
   ---
   ```
   Followed by one blank line.
2. **Video section** — a Markdown link on its own line: `[Title](URL)`. The URL MUST be a valid YouTube URL (`https://www.youtube.com/watch?v=ID`, `https://youtu.be/ID`, or a bare 11-character video ID). Non-YouTube URLs are treated as note body text, not video delimiters. Prefer the canonical form `https://www.youtube.com/watch?v=ID`.
3. **One blank line** after the video link, before its notes.
4. **General note** (optional, max one per video) — the literal line `[general-note](general-note)`, followed by the note body. Always placed before any timestamped notes for that video.
5. **Timestamped note** — `[TIMESTAMP](timestamp)` on its own line. The link target MUST be the literal string `timestamp` (not a URL). Followed by the note body.
6. **Blank line** after every note body.
7. **Ordering** — within each video section: general note first (if any), then timestamped notes sorted ascending by timestamp.
8. **Multiple videos** — each video section follows the previous one, separated by a blank line.

### Timestamp format

Format each timestamp based on the video's total duration so the plugin displays it correctly:

- Video under 1 minute → `SS` (e.g. `45`)
- Video 1 minute to under 1 hour → `M:SS` (e.g. `1:23`, `12:05`)
- Video 1 hour or longer → `H:MM:SS` (e.g. `1:23:45`, `2:05:09`)

Use the video's real duration to pick the format. If the duration is not provided alongside the transcript, ask the user for it (or the video URL, from which the duration can be derived). Zero-pad minutes and seconds to two digits only in the `H:MM:SS` and `M:SS`/`MM:SS` forms as shown above.

### Note body

- Plain Markdown. Obsidian Live Preview renders it, so headings, lists, links, bold/italic, and code blocks all work.
- Regular Markdown links inside a note body (e.g. `[Google](https://google.com)`) are preserved as body text — they are NOT treated as video delimiters because their URL is not a YouTube URL.
- Keep bodies concise. One logical thought per note.

## How to build the file

### 1. Locate the transcript and the video URL(s)

The transcript already exists — it was fetched by the user or by another skill. Find it before doing anything else:

- Check the user's message for pasted transcript text, attached file contents, or a path to a transcript file.
- If the user references a file, read it.
- If no transcript is present, stop and ask the user to provide one (or to run the transcript-fetching skill first). Do NOT attempt to fetch a transcript yourself — that is out of scope for this skill.

Each video needs a YouTube URL. Get it from the user, from the transcript file's name/metadata, or by asking. Normalize each URL to `https://www.youtube.com/watch?v=ID`. Reject non-YouTube URLs and tell the user.

### 2. Parse the transcript into timestamped segments

Transcripts come in many shapes. Identify the format and extract a list of `(start_seconds, text)` segments per video:

- **VTT / SRT subtitle files** — parse the cue blocks. Each cue has a start timestamp (`HH:MM:SS.mmm` or `MM:SS.mmm`) and one or more text lines. Convert the start time to total seconds; use the cue text as the segment text.
- **JSON from `youtube-transcript-api`** — a list of `{"text": "...", "start": 12.34, "duration": 3.5}` objects. `start` is already in seconds.
- **Plain text with inline timestamps** — lines like `[01:23] some text` or `01:23 some text`. Parse the leading timestamp and treat the rest of the line as the segment text.
- **Other structured formats** — extract `(timestamp, text)` pairs by whatever pattern the format uses.

If a transcript has no timestamps at all, it cannot be turned into timestamped notes. Stop and tell the user — this skill requires a timestamped transcript.

### 3. Decide note granularity

Default: **consolidate** consecutive transcript segments into coherent, paragraph-style notes at meaningful timestamps. Aim for one note per topic or roughly every 30–60 seconds, whichever produces a more readable result. Use the start time of the first segment in each consolidated group as the note's timestamp. Rewrite the segment text into clear prose; do not just concatenate raw captions.

If the user explicitly asks for a **verbatim** or **raw** transcript, switch to **one note per transcript segment**: each segment becomes its own `[TIMESTAMP](timestamp)` note with the segment's text as-is (lightly cleaned of caption artifacts like `[Music]`, `>>`, repeated words).

### 4. General note (only on explicit request)

Include a `[general-note](general-note)` section for a video only when the user asks for a summary, overview, or "general note". Write a concise summary derived from the transcript content. Place it before the timestamped notes for that video. Omit it entirely otherwise — do not emit an empty general note.

### 5. Assemble the file

- Start with the frontmatter.
- For each video, in the order the user provided the URLs:
  1. Video link line: `[Title](https://www.youtube.com/watch?v=ID)`. Use the video's real title if available (from the transcript metadata or the user); fall back to the video ID if the title is unknown.
  2. Blank line.
  3. General note (if requested) + blank line.
  4. Timestamped notes in ascending order, each followed by a blank line.
- All videos go into a single file.

### 6. Confirm the path with the user before writing

Before creating the file:

1. Derive a filename from the first video's title: sanitize it for the filesystem (strip characters not allowed in filenames on the target OS, trim whitespace, collapse spaces). Append `.youtnote.md`.
2. Propose the full path (directory + filename) to the user and ask for confirmation or a correction. If the user gives multiple videos and the first title is not representative, suggest a descriptive name covering the set instead.
3. Write the file only after the user confirms the path.

## Verification before finishing

After writing the file, re-read it and check:

- First three lines are `---`, `youtnote: true`, `---`.
- Every video link uses a canonical `https://www.youtube.com/watch?v=ID` URL.
- Every timestamp line uses `[TIMESTAMP](timestamp)` with the literal target `timestamp`.
- General note lines (if any) are the exact literal `[general-note](general-note)`.
- Within each video, the general note (if present) comes before all timestamped notes.
- Timestamped notes are sorted ascending.
- Timestamp formats match each video's duration per the rules above.
- No empty note bodies — every delimiter is followed by non-empty body text.
- The file ends with a trailing newline.

If any check fails, fix the file before reporting success.

## Example output

A two-video file with a requested summary on the first video only:

```markdown
---
youtnote: true
---

[How Transformers Work](https://www.youtube.com/watch?v=SZorAJ4I7xg)

[general-note](general-note)
A 20-minute walkthrough of the Transformer architecture: self-attention, positional encoding, multi-head attention, and the encoder-decoder structure. Useful as a primer before reading "Attention Is All You Need".

[00:15](timestamp)
Transformers replaced RNNs by processing all tokens in parallel instead of sequentially.

[01:42](timestamp)
Self-attention lets each token weigh every other token, producing context-aware representations.

[03:05](timestamp)
Positional encodings inject order information since attention itself is permutation-invariant.

[10:20](timestamp)
Multi-head attention runs several attention layers in parallel, each learning different relations.

[Attention Is All You Need - Paper Walkthrough](https://www.youtube.com/watch?v=rBC6OTgDd2k)

[00:30](timestamp)
The paper introduces scaled dot-product attention: Query and Key dot products, scaled by sqrt(d_k), then softmax.

[02:10](timestamp)
The encoder is a stack of identical layers, each with self-attention and a feed-forward sub-layer.
```
