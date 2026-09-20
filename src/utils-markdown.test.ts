import { describe, expect, it } from 'vitest';
import {
    extractYouTubeId,
    normalizeYouTubeUrl,
    hasYoutnoteFrontmatter,
    isSafeExternalUrl,
} from './utils';
import {
    parseMarkdownToData,
    serializeDataToMarkdown,
    exportSingleVideoToMarkdown,
    exportToMarkdown,
} from './markdown';

describe('YouTube URL utilities', () => {
    it('extracts ids only from valid YouTube hosts or direct ids', () => {
        expect(extractYouTubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
        expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
        expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
        expect(extractYouTubeId('https://evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
        expect(extractYouTubeId('https://www.youtube.com/watch?v=bad')).toBeNull();
    });

    it('normalizes valid YouTube urls', () => {
        expect(normalizeYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
        );
    });
});

describe('Safety/frontmatter utilities', () => {
    it('matches youtnote frontmatter only in yaml header', () => {
        const valid = '---\nyoutnote: true\n---\n\n# Note';
        const invalid = '# Note\n\nyoutnote: true';

        expect(hasYoutnoteFrontmatter(valid)).toBe(true);
        expect(hasYoutnoteFrontmatter(invalid)).toBe(false);
    });

    it('accepts only http(s) as safe external urls', () => {
        expect(isSafeExternalUrl('https://example.com')).toBe(true);
        expect(isSafeExternalUrl('http://example.com')).toBe(true);
        expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeExternalUrl('data:text/html,hello')).toBe(false);
    });
});

describe('Markdown parser', () => {
    it('keeps regular markdown links in note body and does not treat them as videos', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[00:05](timestamp)
Line 1
[Google](https://google.com)
Line 2
`;

        const parsed = parseMarkdownToData(markdown);

        expect(parsed.videos).toHaveLength(1);
        expect(parsed.notes).toHaveLength(1);
        expect(parsed.notes[0].bodyMarkdown).toContain('[Google](https://google.com)');
        expect(parsed.notes[0].bodyMarkdown).toContain('Line 2');
    });

    it('parses [general-note](general-note) as a timestamp-less general note', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[general-note](general-note)
This is a general note about the whole video.

[00:05](timestamp)
First timestamped note.
`;

        const parsed = parseMarkdownToData(markdown);

        expect(parsed.videos).toHaveLength(1);
        expect(parsed.notes).toHaveLength(2);

        const general = parsed.notes.find(n => n.isGeneral);
        expect(general).toBeDefined();
        expect(general?.timestampSec).toBe(-1);
        expect(general?.bodyMarkdown).toBe('This is a general note about the whole video.');

        const timestamped = parsed.notes.find(n => !n.isGeneral);
        expect(timestamped).toBeDefined();
        expect(timestamped?.timestampSec).toBe(5);
    });

    it('serializes general notes before timestamped notes using the general-note syntax', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[general-note](general-note)
This is a general note about the whole video.

[01:23](timestamp)
First timestamped note.
`;

        const parsed = parseMarkdownToData(markdown);
        const serialized = serializeDataToMarkdown(parsed.videos, parsed.notes);

        // General note delimiter must appear before the first timestamp delimiter
        const generalIdx = serialized.indexOf('[general-note](general-note)');
        const tsIdx = serialized.indexOf('[1:23](timestamp)');
        expect(generalIdx).toBeGreaterThan(-1);
        expect(tsIdx).toBeGreaterThan(-1);
        expect(generalIdx).toBeLessThan(tsIdx);
    });

    it('parses transcript caption lines into the video transcript', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[0:05](timestamp)
A note.

[0](transcript) Hello everyone, in this video
[5](transcript) I will show you how to design
[1:55](transcript) That's it for now guys
`;

        const parsed = parseMarkdownToData(markdown);

        expect(parsed.videos).toHaveLength(1);
        expect(parsed.notes).toHaveLength(1);
        // Transcript lines must not leak into the preceding note's body
        expect(parsed.notes[0].bodyMarkdown).toBe('A note.');
        expect(parsed.videos[0].transcript).toEqual([
            { timestampSec: 0, text: 'Hello everyone, in this video' },
            { timestampSec: 5, text: 'I will show you how to design' },
            { timestampSec: 115, text: "That's it for now guys" },
        ]);
    });

    it('treats caption text ending with ) as a transcript entry, not a link', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[5](transcript) Watch this (really)
`;

        const parsed = parseMarkdownToData(markdown);

        expect(parsed.videos).toHaveLength(1);
        expect(parsed.notes).toHaveLength(0);
        expect(parsed.videos[0].transcript).toEqual([
            { timestampSec: 5, text: 'Watch this (really)' },
        ]);
    });

    it('serializes the transcript block after the video notes and before the next video', () => {
        const markdown = `---
youtnote: true
---

[First Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[0:05](timestamp)
A note.

[5](transcript) first caption
[1:55](transcript) second caption

[Second Video](https://www.youtube.com/watch?v=abcdefghijk)

[0:10](timestamp)
Another note.
`;

        const parsed = parseMarkdownToData(markdown);
        const serialized = serializeDataToMarkdown(parsed.videos, parsed.notes);

        const noteIdx = serialized.indexOf('[5](timestamp)');
        const transcriptIdx = serialized.indexOf('[5](transcript) first caption');
        const nextVideoIdx = serialized.indexOf('[Second Video]');
        expect(noteIdx).toBeGreaterThan(-1);
        expect(transcriptIdx).toBeGreaterThan(noteIdx);
        expect(transcriptIdx).toBeGreaterThan(-1);
        expect(nextVideoIdx).toBeGreaterThan(transcriptIdx);
        expect(serialized).toContain('[1:55](transcript) second caption');
    });

    it('round-trips transcript entries through parse and serialize', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[0:05](timestamp)
A note.

[0](transcript) Hello everyone, in this video
[5](transcript) I will show you how to design
[1:55](transcript) That's it for now guys
`;

        const parsed = parseMarkdownToData(markdown);
        const serialized = serializeDataToMarkdown(parsed.videos, parsed.notes);
        const reparsed = parseMarkdownToData(serialized);

        expect(reparsed.videos[0].transcript).toEqual(parsed.videos[0].transcript);
        expect(reparsed.notes).toHaveLength(parsed.notes.length);
    });

    it('leaves transcript undefined for files without transcript lines', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[0:05](timestamp)
A note.
`;

        const parsed = parseMarkdownToData(markdown);
        expect(parsed.videos[0].transcript).toBeUndefined();

        const serialized = serializeDataToMarkdown(parsed.videos, parsed.notes);
        expect(serialized).not.toContain('(transcript)');
        expect(serialized).toContain('[5](timestamp)');
    });

    it('parses and serializes a video that has a transcript and zero notes', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[5](transcript) only captions here
`;

        const parsed = parseMarkdownToData(markdown);
        expect(parsed.notes).toHaveLength(0);
        expect(parsed.videos[0].transcript).toEqual([
            { timestampSec: 5, text: 'only captions here' },
        ]);

        const serialized = serializeDataToMarkdown(parsed.videos, parsed.notes);
        expect(serialized).toContain('[5](transcript) only captions here');
    });

    it('exports general notes with a "General note:" heading before timestamped notes', () => {
        const markdown = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[general-note](general-note)
This is a general note about the whole video.

[01:23](timestamp)
First timestamped note.
`;

        const parsed = parseMarkdownToData(markdown);
        const exported = exportSingleVideoToMarkdown(parsed.videos[0], parsed.notes);

        const generalIdx = exported.indexOf('**General note:**');
        const tsIdx = exported.indexOf('[1:23]');
        expect(generalIdx).toBeGreaterThan(-1);
        expect(tsIdx).toBeGreaterThan(-1);
        expect(generalIdx).toBeLessThan(tsIdx);
    });
});

describe('Markdown export options', () => {
    const EXPORT_MD = `---
youtnote: true
---

[First Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[general-note](general-note)
Summary note.

[1:23](timestamp)
Timestamped note.

[5](transcript) first caption
[1:55](transcript) second caption

[Second Video](https://www.youtube.com/watch?v=abcdefghijk)

[0:10](timestamp)
Another note.

[7](transcript) other caption
`;

    it('includes notes and transcript sections by default', () => {
        const parsed = parseMarkdownToData(EXPORT_MD);
        const exported = exportToMarkdown(parsed.videos, parsed.notes);

        expect(exported).toContain('**General note:**');
        expect(exported).toContain('Summary note.');
        expect(exported).toContain('[1:23](https://youtu.be/dQw4w9WgXcQ?t=83)');
        expect(exported).toContain('Timestamped note.');
        expect(exported).toContain('**Transcript:**');
        expect(exported).toContain('[5](https://youtu.be/dQw4w9WgXcQ?t=5) first caption');
        expect(exported).toContain('[1:55](https://youtu.be/dQw4w9WgXcQ?t=115) second caption');
    });

    it('excludes the transcript when only notes are requested', () => {
        const parsed = parseMarkdownToData(EXPORT_MD);
        const exported = exportSingleVideoToMarkdown(parsed.videos[0], parsed.notes, {
            includeNotes: true,
            includeTranscripts: false,
        });

        expect(exported).toContain('**General note:**');
        expect(exported).toContain('Timestamped note.');
        expect(exported).not.toContain('**Transcript:**');
        expect(exported).not.toContain('first caption');
    });

    it('excludes notes when only the transcript is requested', () => {
        const parsed = parseMarkdownToData(EXPORT_MD);
        const exported = exportSingleVideoToMarkdown(parsed.videos[0], parsed.notes, {
            includeNotes: false,
            includeTranscripts: true,
        });

        expect(exported).toContain('[First Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
        expect(exported).toContain('**Transcript:**');
        expect(exported).toContain('[5](https://youtu.be/dQw4w9WgXcQ?t=5) first caption');
        expect(exported).not.toContain('**General note:**');
        expect(exported).not.toContain('Summary note.');
        expect(exported).not.toContain('Timestamped note.');
        expect(exported).not.toContain('https://youtu.be/dQw4w9WgXcQ?t=83');
    });

    it('applies the options across all videos', () => {
        const parsed = parseMarkdownToData(EXPORT_MD);
        const exported = exportToMarkdown(parsed.videos, parsed.notes, {
            includeNotes: false,
            includeTranscripts: true,
        });

        expect(exported.match(/\*\*Transcript:\*\*/g)).toHaveLength(2);
        expect(exported).toContain('[5](https://youtu.be/dQw4w9WgXcQ?t=5) first caption');
        expect(exported).toContain('[7](https://youtu.be/abcdefghijk?t=7) other caption');
        expect(exported).not.toContain('Another note.');
        expect(exported).not.toContain('**General note:**');
    });
});
