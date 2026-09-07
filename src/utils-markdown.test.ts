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
