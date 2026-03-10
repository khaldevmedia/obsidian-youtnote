import { describe, expect, it } from 'vitest';
import {
    extractYouTubeId,
    normalizeYouTubeUrl,
    hasYoutnoteFrontmatter,
    isSafeExternalUrl,
} from './utils';
import { parseMarkdownToData } from './markdown';

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
});
