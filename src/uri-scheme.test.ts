import { describe, expect, it } from 'vitest';
import {
    validateYoutnoteUriParams,
    hasLeadingFrontmatter,
    hasStructuralDelimiter,
    getUnsupportedParams,
    isDebounced,
    MAX_URL_LENGTH,
    MAX_TEXT_LENGTH,
    DEBOUNCE_MS,
} from './uri-scheme';

const VALID_YT_URL = 'https://www.youtube.com/watch?v=aircAruvnKk';

const V2_BOUNDARY_MARKERS = [
    '<!-- youtnote:file:start -->',
    '<!-- youtnote:file:end -->',
    '<!-- youtnote:video:start -->',
    '<!-- youtnote:video:end -->',
    '<!-- youtnote:source:start -->',
    '<!-- youtnote:source:end -->',
    '<!-- youtnote:title:start -->',
    '<!-- youtnote:title:end -->',
    '<!-- youtnote:url:start -->',
    '<!-- youtnote:url:end -->',
    '<!-- youtnote:notes:start -->',
    '<!-- youtnote:notes:end -->',
    '<!-- youtnote:transcript:start -->',
    '<!-- youtnote:transcript:end -->',
    '<!-- youtnote:general-note:start -->',
    '<!-- youtnote:general-note:end -->',
    '<!-- youtnote:timestamped-note:start -->',
    '<!-- youtnote:timestamped-note:start t=4:30 -->',
    '<!-- youtnote:timestamped-note:end -->',
    '<!-- youtnote:future-thing:start version=9 -->',
    '<!-- youtnote:future-thing:end -->',
];

// ─── getUnsupportedParams ───────────────────────────────────────────────────

describe('getUnsupportedParams', () => {
    it('returns empty array when only allowed params are present', () => {
        const raw = { action: 'youtnote', url: VALID_YT_URL, mode: 'new' };
        expect(getUnsupportedParams(raw)).toEqual([]);
    });

    it('returns unsupported param names', () => {
        const raw = { action: 'youtnote', url: VALID_YT_URL, mode: 'new', path: '/etc/passwd', file: 'secret.md' };
        expect(getUnsupportedParams(raw)).toEqual(['path', 'file']);
    });

    it('ignores action key (added by Obsidian)', () => {
        const raw = { action: 'youtnote', url: VALID_YT_URL };
        expect(getUnsupportedParams(raw)).toEqual([]);
    });

    it('returns all unsupported params when no allowed params present', () => {
        const raw = { action: 'youtnote', command: 'rm -rf', overwrite: 'true' };
        expect(getUnsupportedParams(raw)).toEqual(['command', 'overwrite']);
    });
});

// ─── validateYoutnoteUriParams ──────────────────────────────────────────────

describe('validateYoutnoteUriParams', () => {
    it('accepts valid url + mode=new and returns normalized URL', () => {
        const params = { url: VALID_YT_URL, mode: 'new' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(result.mode).toBe('new');
        expect(result.normalizedUrl).toBe(VALID_YT_URL);
    });

    it('rejects invalid mode with an error', () => {
        const params = { url: VALID_YT_URL, mode: 'invalid-mode' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('invalid-mode');
        expect(result.error).toContain('invalid-mode');
    });

    it('rejects missing mode with an error', () => {
        const params = { url: VALID_YT_URL };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('missing-mode');
    });

    it('rejects url that does not resolve to a YouTube ID', () => {
        const params = { url: 'https://example.com/watch?v=bad', mode: 'new' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('invalid-url');
    });

    it('rejects URL > 2000 chars total', () => {
        const params = { url: VALID_YT_URL, mode: 'new' };
        const result = validateYoutnoteUriParams(params, MAX_URL_LENGTH + 1);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('url-too-long');
    });

    it('rejects url param > 500 chars', () => {
        const longUrl = 'https://www.youtube.com/watch?v=aircAruvnKk' + '&x=' + 'a'.repeat(500);
        const params = { url: longUrl, mode: 'new' };
        const result = validateYoutnoteUriParams(params, longUrl.length + 50);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('url-param-too-long');
    });

    it('rejects text param > 1000 chars (decoded)', () => {
        const longText = 'a'.repeat(MAX_TEXT_LENGTH + 1);
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10', text: longText };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('text-too-long');
    });

    it('accepts valid timestamp for mode=note and returns timestampSec', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '1:23', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(result.mode).toBe('note');
        expect(result.timestampSec).toBe(83);
        expect(result.text).toBe('Note text');
    });

    it('rejects invalid timestamp for mode=note (non-numeric)', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: 'abc', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('invalid-timestamp');
    });

    it('rejects invalid timestamp for mode=note (negative)', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '-5', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('invalid-timestamp');
    });

    it('accepts timestamp > 86400 seconds (no duration cap at validation time)', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '90000', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(result.timestampSec).toBe(90000);
    });

    it('rejects missing timestamp for mode=note', () => {
        const params = { url: VALID_YT_URL, mode: 'note', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('missing-timestamp');
    });

    it('rejects missing text for mode=note', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('missing-text');
    });

    it('rejects missing text for mode=general-note', () => {
        const params = { url: VALID_YT_URL, mode: 'general-note' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('missing-text');
    });

    it('accepts missing timestamp/text for mode=new', () => {
        const params = { url: VALID_YT_URL, mode: 'new' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(result.timestampSec).toBeUndefined();
        expect(result.text).toBeUndefined();
    });

    it('accepts missing timestamp/text for mode=append', () => {
        const params = { url: VALID_YT_URL, mode: 'append' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(result.timestampSec).toBeUndefined();
        expect(result.text).toBeUndefined();
    });

    it('accepts mode=general-note with text', () => {
        const params = { url: VALID_YT_URL, mode: 'general-note', text: 'General note content' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(result.mode).toBe('general-note');
        expect(result.text).toBe('General note content');
    });

    it('rejects missing url param', () => {
        const params = { mode: 'new' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('missing-url');
    });

    it('rejects text with leading frontmatter marker', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10', text: '---\nyoutnote: false\n---\nReal note' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('frontmatter-not-allowed');
    });

    it('accepts text with --- that appears later (not at the start)', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10', text: 'Some text\n---\nMore text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(true);
        expect(result.errorCode).toBeUndefined();
        expect(result.text).toBe('Some text\n---\nMore text');
    });

    it('rejects mode=note text containing a section marker', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10', text: '[general-note](general-note)' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('structural-delimiter-not-allowed');
    });

    it('rejects mode=general-note text containing a YouTube link line', () => {
        const params = { url: VALID_YT_URL, mode: 'general-note', text: 'Summary\n[Other](https://www.youtube.com/watch?v=aircAruvnKk)' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('structural-delimiter-not-allowed');
    });

    it('throws on non-string url param (guarded by try/catch in main.ts)', () => {
        const params = { url: ['a', 'b'] as unknown as string, mode: 'new' };

        expect(() => validateYoutnoteUriParams(params, 100)).toThrow();
    });
});

// ─── hasLeadingFrontmatter ──────────────────────────────────────────────────

describe('hasLeadingFrontmatter', () => {
    it('returns true for text starting with ---', () => {
        expect(hasLeadingFrontmatter('---\nyoutnote: true\n---\nContent')).toBe(true);
    });

    it('returns true for text starting with --- and surrounding whitespace', () => {
        expect(hasLeadingFrontmatter('  ---\nContent')).toBe(true);
    });

    it('returns false for text without frontmatter markers', () => {
        expect(hasLeadingFrontmatter('This is a regular note.')).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(hasLeadingFrontmatter('')).toBe(false);
    });

    it('returns false for --- that appears later in the text', () => {
        expect(hasLeadingFrontmatter('Some text\n---\nMore text')).toBe(false);
    });
});

// ─── hasStructuralDelimiter ─────────────────────────────────────────────────

describe('hasStructuralDelimiter', () => {
    it('returns true for a general-note marker', () => {
        expect(hasStructuralDelimiter('[general-note](general-note)')).toBe(true);
    });

    it('returns true for a timestamp marker', () => {
        expect(hasStructuralDelimiter('[01:23](timestamp)')).toBe(true);
    });

    it('returns true for a YouTube video link', () => {
        expect(hasStructuralDelimiter('[Title](https://youtu.be/aircAruvnKk)')).toBe(true);
    });

    it('returns true when the marker is on a later line', () => {
        expect(hasStructuralDelimiter('Normal text\n[general-note](general-note)')).toBe(true);
    });

    it('returns true with leading whitespace', () => {
        expect(hasStructuralDelimiter('   [01:23](timestamp)')).toBe(true);
    });

    it('returns false for plain text', () => {
        expect(hasStructuralDelimiter('This is a regular note.')).toBe(false);
    });

    it('returns false for a non-YouTube markdown link', () => {
        expect(hasStructuralDelimiter('[docs](https://example.com)')).toBe(false);
    });

    it('returns false when the marker is not at line start', () => {
        expect(hasStructuralDelimiter('see [01:23](timestamp) here')).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(hasStructuralDelimiter('')).toBe(false);
    });

    it.each(V2_BOUNDARY_MARKERS)('returns true for v2 boundary marker %s', (line) => {
        expect(hasStructuralDelimiter(line)).toBe(true);
        expect(hasStructuralDelimiter(`Some text\n${line}`)).toBe(true);
    });

    it('returns true for an earlier-development timestamp note marker', () => {
        expect(hasStructuralDelimiter('`01:23` <!-- youtnote:timestamp -->')).toBe(true);
        expect(hasStructuralDelimiter('Some text\n`5` <!-- youtnote:timestamp -->')).toBe(true);
    });

    it('returns false when an earlier-development timestamp marker has trailing text', () => {
        expect(hasStructuralDelimiter('`01:23` <!-- youtnote:timestamp --> trailing')).toBe(false);
    });

    it('returns true for a reserved marker line with extra spacing', () => {
        expect(hasStructuralDelimiter('<!--  youtnote:file:end -->')).toBe(true);
        expect(hasStructuralDelimiter('<!--\tyoutnote:video:start -->')).toBe(true);
    });

    it('returns true for a reserved marker with no whitespace after the comment opener', () => {
        expect(hasStructuralDelimiter('<!--youtnote:file:end -->')).toBe(true);
    });

    it('returns true for a marker on a later CRLF line with indentation', () => {
        expect(hasStructuralDelimiter('line one\r\n   <!-- youtnote:video:end -->')).toBe(true);
    });

    it('returns true for a marker inside a fenced code block', () => {
        expect(hasStructuralDelimiter('```\n<!-- youtnote:video:end -->\n```')).toBe(true);
    });

    it('returns false for a caption metadata comment, which is literal text inside notes', () => {
        expect(hasStructuralDelimiter('<!-- t=0:11.720 d=6040 --> caption')).toBe(false);
        expect(hasStructuralDelimiter('Some text\n<!-- t=5 d=0 -->')).toBe(false);
    });

    it('returns true for a v2 marker line with leading whitespace', () => {
        expect(hasStructuralDelimiter('   <!-- youtnote:video:end -->')).toBe(true);
        expect(hasStructuralDelimiter('\t<!-- youtnote:file:start -->')).toBe(true);
    });

    it('returns false for an unrelated HTML comment', () => {
        expect(hasStructuralDelimiter('<!-- a normal comment -->')).toBe(false);
    });

    it('rejects mode=note text containing a v2 boundary marker', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10', text: 'body\n<!-- youtnote:video:end -->' };
        const result = validateYoutnoteUriParams(params, 200);
        expect(result.valid).toBe(false);
        expect(result.errorCode).toBe('structural-delimiter-not-allowed');
    });
});

// ─── URI-level structural text checks ───────────────────────────────────────

describe.each(['note', 'general-note'] as const)(
    'validateYoutnoteUriParams structural text checks (mode=%s)',
    (mode) => {
        const buildParams = (text: string) =>
            mode === 'note'
                ? { url: VALID_YT_URL, mode, timestamp: '10', text }
                : { url: VALID_YT_URL, mode, text };

        it.each(V2_BOUNDARY_MARKERS)('rejects text containing %s', (line) => {
            const result = validateYoutnoteUriParams(buildParams(`body\n${line}`), 400);
            expect(result.valid).toBe(false);
        });

        it.each([
            '<!-- t=0:11.720 d=6040 --> caption-like note text',
            '<!-- an ordinary comment -->\nnote body',
            'see <!-- youtnote:video:end --> inline',
            '```ts\nconst x = 1;\nunfinished note',
            '\\<!-- youtnote:video:start -->',
        ])('accepts text %j', (text) => {
            const result = validateYoutnoteUriParams(buildParams(text), 400);
            expect(result.valid).toBe(true);
            expect(result.errorCode).toBeUndefined();
            expect(result.valid && result.text).toBe(text);
        });
    }
);

// ─── isDebounced ────────────────────────────────────────────────────────────

describe('isDebounced', () => {
    it('returns true when calls are < 500ms apart', () => {
        expect(isDebounced(1000, 1400)).toBe(true);
    });

    it('returns false when calls are >= 500ms apart', () => {
        expect(isDebounced(1000, 1500)).toBe(false);
    });

    it('handles lastInvocation of 0 (first call)', () => {
        expect(isDebounced(0, 1000)).toBe(false);
    });

    it('returns true for exactly DEBOUNCE_MS - 1 apart', () => {
        expect(isDebounced(1000, 1000 + DEBOUNCE_MS - 1)).toBe(true);
    });

    it('returns false for exactly DEBOUNCE_MS apart', () => {
        expect(isDebounced(1000, 1000 + DEBOUNCE_MS)).toBe(false);
    });
});
