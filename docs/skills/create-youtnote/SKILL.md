---
name: create-youtnote
description: "Youtnote is an Obsidian plugin that lets you take timestamped Markdown notes across multiple embedded YouTube videos inside a single note. This skill converts an already-fetched, timestamped YouTube transcript into a valid Youtnote markdown file (with `youtnote: true` frontmatter) that the plugin renders correctly. Use this skill whenever the user has a transcript (or transcript segments) in hand and asks to create a Youtnote, build a `.youtnote.md` file, turn a transcript into timestamped Obsidian notes, or format transcript segments into the Youtnote syntax. This skill does NOT fetch transcripts; assume the transcript already exists (fetched by the user or another skill)."
---

# Create Youtnote

Take an already-fetched, timestamped YouTube transcript and write it as a Youtnote markdown file that the Obsidian Youtnote plugin can open and render. This skill does not fetch transcripts. It consumes one that already exists.

## What a Youtnote file is

A plain Markdown file with `youtnote: true` frontmatter and a `youtnote-format-version: 2` version declaration. The Youtnote plugin parses it into an interactive video + notes view. The body is plugin-managed storage, not an ordinary editable Markdown document. The two Youtnote frontmatter properties belong to the plugin. Preserve any user-defined frontmatter when updating a file. The file format is strict. Follow the syntax below exactly.

## File format (must match exactly)

```markdown
---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:file:start -->

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->

<!-- youtnote:title:start -->
Video Title
<!-- youtnote:title:end -->

<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=VIDEO_ID
<!-- youtnote:url:end -->

<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
Optional general note body. One per video at most. Sits at the top of the video's notes.
<!-- youtnote:general-note:end -->

<!-- youtnote:timestamped-note:start t=1:23 -->
First timestamped note body.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:timestamped-note:start t=2:45 -->
Second timestamped note body.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->

<!-- youtnote:title:start -->
Next Video Title
<!-- youtnote:title:end -->

<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=NEXT_VIDEO_ID
<!-- youtnote:url:end -->

<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=10 -->
Note body for the next video.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

<!-- youtnote:file:end -->
```

### Structural rules

1. **Frontmatter:** for a new file, use canonical YAML boolean `true`:
   ```
   ---
   youtnote: true
   youtnote-format-version: 2
   ---
   ```
   Follow with one blank line. The plugin also accepts `youtnote: yes`. When updating an existing file, retain its unrelated properties and comments instead of replacing its YAML.
2. **File wrapper:** exactly one `<!-- youtnote:file:start -->` / `<!-- youtnote:file:end -->` pair encloses the entire body. Frontmatter remains outside. An empty document still has this pair.
3. **Video block:** every video is wrapped in `<!-- youtnote:video:start -->` and `<!-- youtnote:video:end -->`. Only child containers and blank lines are allowed directly inside it.
4. **Source:** exactly one `source` container is first in each video. It contains exactly one `title` container and one `url` container. Write title first, then URL. These are plain-text fields, not a Markdown link. The URL is one nonempty line containing a supported YouTube URL or an 11-character video ID. Prefer `https://www.youtube.com/watch?v=ID`. Titles may be empty or multiline, and their whitespace is meaningful.
5. **Notes:** exactly one `<!-- youtnote:notes:start -->` / `<!-- youtnote:notes:end -->` container follows the source. Emit it even when empty.
6. **General note:** optionally emit one `general-note` container when requested, before the timestamped notes.
7. **Timestamped note:** wrap each note separately in `<!-- youtnote:timestamped-note:start t=TIMESTAMP -->` and `<!-- youtnote:timestamped-note:end -->`. The unquoted `t` attribute is mandatory. There is no collection wrapper and no backtick timestamp header.
8. **Content boundaries:** note bodies and titles start immediately on the line after their opening marker and end immediately before their closing marker. Blank lines inside these boundaries are content. Put decorative spacing outside them.
9. **Ordering:** preserve video order. Place the general note first, then timestamped notes in ascending timestamp order.
10. **Transcript:** when creating a file, this skill writes notes, not stored captions. Do not generate a transcript container. When updating an existing file, preserve any transcript. Its records use `<!-- t=0:11.720 d=6040 --> Caption text.` inside a `transcript` container. Both unquoted attributes are mandatory. Duration is integer milliseconds, with `d=0` meaning unavailable. Exactly one separator space follows `-->`. Caption payload escapes are `\\` for a backslash, `\n` for LF, and `\r` for CR.
11. **Markers:** use `youtnote:<name>:start` and matching `end` markers. Do not use a `section` prefix, old link-style delimiters, IDs, or generated block anchors. Known wrappers accept no attributes except `t` on `timestamped-note:start`.
12. **Extensions:** preserve unknown file-level and video-level containers, including their attributes and opaque content. Do not invent extension containers when creating a file. Do not put unknown fields inside source or notes.
13. **No stray content:** outside payloads and preserved extension containers, only the permitted container markers and blank lines are allowed. Only whitespace may appear outside the file wrapper after frontmatter. Finish with a trailing newline.

### Timestamp format

Use whole-second timestamps. Convert transcript start times to seconds, rounding down fractional seconds for notes. Canonical output depends on the timestamp value, not the total video duration:

- Below one minute: `SS`, such as `45`.
- Below one hour: `M:SS`, such as `1:23`.
- One hour or more: `H:MM:SS`, such as `1:23:45`.

Seconds after a colon and minutes in the hour form must be two digits in the range `00` to `59`. The first component may have more digits. Do not use negative, fractional, or non-finite note timestamps. Caption timestamps, unlike note timestamps, support up to three decimal places for milliseconds.

### Note body

- Plain Markdown. The plugin renders headings, lists, links, bold/italic, and code blocks.
- Markdown links inside note bodies, including YouTube links, are content, not video delimiters.
- Raw balanced fenced code blocks may contain literal Youtnote markers. A closing fence must match the opening backtick or tilde character, be at least as long, and have no trailing text.
- For canonical storage of note bodies and titles, prefix one backslash at the very start of every payload line beginning with a backslash, every fence-delimiter-looking line, and every line whose trimmed form starts with `<!--` followed by optional whitespace and `youtnote:`. This reserves noncanonical comment spacing too. This makes even unfinished code fences safe. Decode the prefix as literal payload without activating structural fence handling. These rules apply only to payload, never to actual container markers. They are reversible storage escaping, not changes to the note's decoded text.
- Example: a literal `<!-- youtnote:video:end -->` line outside fenced code is stored as `\<!-- youtnote:video:end -->`. A payload line beginning with one literal backslash is stored with two.
- Preserve meaningful whitespace. Do not add blank lines inside a note merely to separate it from its wrapper.
- Keep bodies concise. One logical thought per note.

## How to build the file

### 1. Locate the transcript and the video URL(s)

The transcript already exists. It was fetched by the user or by another skill. Find it before doing anything else:

- Check the user's message for pasted transcript text, attached file contents, or a path to a transcript file.
- If the user references a file, read it.
- If no transcript is present, stop and ask the user to provide one (or to run the transcript-fetching skill first). Do NOT attempt to fetch a transcript yourself.

Each video needs a YouTube URL. Get it from the user, from the transcript file's name/metadata, or by asking. Normalize each URL to `https://www.youtube.com/watch?v=ID`. Reject non-YouTube URLs and tell the user.

### 2. Parse the transcript into timestamped segments

Transcripts come in many shapes. Identify the format and extract a list of `(start_seconds, text)` segments per video:

- **VTT / SRT subtitle files:** parse the cue blocks. Each cue has a start timestamp (`HH:MM:SS.mmm` or `MM:SS.mmm`) and one or more text lines. Convert the start time to total seconds and use the cue text as the segment text.
- **JSON from `youtube-transcript-api`:** a list of `{"text": "...", "start": 12.34, "duration": 3.5}` objects. `start` is already in seconds.
- **Plain text with inline timestamps:** lines like `[01:23] some text` or `01:23 some text`. Parse the leading timestamp and treat the rest of the line as the segment text.
- **Other structured formats:** extract `(timestamp, text)` pairs by whatever pattern the format uses.

If a transcript has no timestamps at all, it cannot be turned into timestamped notes. Stop and tell the user that this skill requires a timestamped transcript.

### 3. Decide note granularity

Default: **consolidate** consecutive transcript segments into coherent, paragraph-style notes at meaningful timestamps. Aim for one note per topic or roughly every 30 to 60 seconds, whichever produces a more readable result. Use the start time of the first segment in each consolidated group as the note's timestamp. Rewrite the segment text into clear prose rather than concatenating raw captions.

If the user explicitly asks for a **verbatim** or **raw** transcript, switch to **one note per transcript segment**. Each segment becomes its own timestamped-note container with the segment's text, lightly cleaned of caption artifacts such as `[Music]`, `>>`, and repeated words.

### 4. General note (only on explicit request)

Include a general-note block for a video only when the user asks for a summary, overview, or "general note". Write a concise summary derived from the transcript content, wrapped in `<!-- youtnote:general-note:start -->` and `<!-- youtnote:general-note:end -->` marker lines. Place it before the timestamped notes for that video. Omit it entirely otherwise.

### 5. Assemble the file

- Start with the frontmatter (`youtnote: true` and `youtnote-format-version: 2`), then a blank line and `<!-- youtnote:file:start -->`.
- For each video, in the order the user provided the URLs:
  1. `<!-- youtnote:video:start -->`, then a blank line.
  2. A `source` container containing a `title` container and a `url` container. Use the video's real title if available from transcript metadata or the user. Fall back to the video ID if unknown. Store the canonical URL as plain text in `url`.
  3. Blank line, then `<!-- youtnote:notes:start -->`, then a blank line.
  4. General note (if requested): `<!-- youtnote:general-note:start -->`, the body, `<!-- youtnote:general-note:end -->`, then a blank line.
  5. Each timestamped note in ascending order: `<!-- youtnote:timestamped-note:start t=TIMESTAMP -->`, the escaped body, then `<!-- youtnote:timestamped-note:end -->`. Separate records with a blank line outside their boundaries.
  6. `<!-- youtnote:notes:end -->`, blank line, `<!-- youtnote:video:end -->`.
- Separate consecutive video blocks with one blank line. All videos go into a single file. Close with `<!-- youtnote:file:end -->` and a trailing newline.

### 6. Confirm the path with the user before writing

Before creating the file:

1. Derive a filename from the first video's title: sanitize it for the filesystem (strip characters not allowed in filenames on the target OS, trim whitespace, collapse spaces). Append `.youtnote.md`.
2. Propose the full path (directory + filename) to the user and ask for confirmation or a correction. If the user gives multiple videos and the first title is not representative, suggest a descriptive name covering the set instead.
3. Write the file only after the user confirms the path.

## Verification before finishing

After writing the file, re-read it and check:

- Frontmatter declares `youtnote: true` and `youtnote-format-version: 2`, and unrelated existing properties have been preserved.
- Exactly one file wrapper encloses the body after frontmatter.
- Every video, source, title, URL, notes, general-note, and timestamped-note opening marker has its matching closing marker under the correct parent. Equal counts alone are not sufficient. Check actual nesting.
- Each video has source first, containing title then a single-line canonical YouTube URL, followed by exactly one notes container.
- No transcript container is generated for a new file. Existing transcripts are preserved when updating a file.
- Each timestamped note has its own wrapper with exactly one valid, unquoted `t` attribute.
- No `section` prefixes, timestamped-notes collection wrappers, backtick timestamp headers, Markdown-link source records, or link-style structural markers.
- General notes precede timestamped notes.
- Timestamped notes are sorted ascending.
- Timestamps follow the whole-second grammar above.
- Every generated note has meaningful content. Empty records are valid storage but should not be generated as placeholders.
- Payload marker lines and leading backslashes use the reversible escaping rules above.
- No stray non-blank content outside permitted payloads and containers.
- The file ends with a trailing newline.

If the repository is available, also validate the file using its current `parseYoutnoteDocument` implementation. Do not rely on an older installed plugin to validate unreleased format revisions. If any check fails, fix the file before reporting success.

## Example output

A two-video example showing Markdown formatting in general and timestamped notes:

```markdown
---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:file:start -->

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->

<!-- youtnote:title:start -->
How Transformers Work
<!-- youtnote:title:end -->

<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=SZorAJ4I7xg
<!-- youtnote:url:end -->

<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
## Overview

A 20-minute walkthrough of the **Transformer architecture**.

- **Core mechanisms:** self-attention, positional encoding, and multi-head attention.
- **Structure:** encoder and decoder stacks.
- **Follow-up reading:** [Attention Is All You Need](https://arxiv.org/abs/1706.03762).
<!-- youtnote:general-note:end -->

<!-- youtnote:timestamped-note:start t=15 -->
**Key shift:** Transformers replaced RNNs by processing all tokens *in parallel* instead of sequentially.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:timestamped-note:start t=1:42 -->
### Self-attention

- Each token weighs every other token.
- The result is a **context-aware representation** of that token.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:timestamped-note:start t=3:05 -->
**Positional encodings** inject order information since attention itself is *permutation-invariant*.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:timestamped-note:start t=10:20 -->
**Multi-head attention** runs several attention layers in parallel, each learning different relations.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->

<!-- youtnote:title:start -->
Attention Is All You Need - Paper Walkthrough
<!-- youtnote:title:end -->

<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=rBC6OTgDd2k
<!-- youtnote:url:end -->

<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=30 -->
### Scaled dot-product attention

1. Compute dot products between **queries** and **keys**.
2. Scale by `sqrt(d_k)`.
3. Apply **softmax** to obtain attention weights.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:timestamped-note:start t=2:10 -->
The **encoder** is a stack of identical layers, each containing:

- A self-attention sub-layer.
- A feed-forward sub-layer.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

<!-- youtnote:file:end -->
```
