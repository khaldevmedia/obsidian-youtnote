import { describe, expect, it } from 'vitest';
import {
    parseYoutnoteUriParams,
    validateYoutnoteUriParams,
    hasLeadingFrontmatter,
    getUnsupportedParams,
    isDebounced,
    MAX_URL_LENGTH,
    MAX_URL_PARAM_LENGTH,
    MAX_TEXT_LENGTH,
    DEBOUNCE_MS,
} from './uri-scheme';

const VALID_YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// ─── parseYoutnoteUriParams ─────────────────────────────────────────────────

describe('parseYoutnoteUriParams', () => {
    it('parses all four params correctly from a full URL', () => {
        const url = `obsidian://youtnote?url=${encodeURIComponent(VALID_YT_URL)}&mode=note&timestamp=90&text=${encodeURIComponent('My note')}`;
        const params = parseYoutnoteUriParams(url);

        expect(params.url).toBe(VALID_YT_URL);
        expect(params.mode).toBe('note');
        expect(params.timestamp).toBe('90');
        expect(params.text).toBe('My note');
    });

    it('handles missing optional params (mode, timestamp, text absent)', () => {
        const url = `obsidian://youtnote?url=${encodeURIComponent(VALID_YT_URL)}`;
        const params = parseYoutnoteUriParams(url);

        expect(params.url).toBe(VALID_YT_URL);
        expect(params.mode).toBeUndefined();
        expect(params.timestamp).toBeUndefined();
        expect(params.text).toBeUndefined();
    });

    it('handles empty url param', () => {
        const url = 'obsidian://youtnote?url=&mode=new';
        const params = parseYoutnoteUriParams(url);

        expect(params.url).toBe('');
        expect(params.mode).toBe('new');
    });

    it('ignores unknown params (path, file, command, etc.)', () => {
        const url = `obsidian://youtnote?url=${encodeURIComponent(VALID_YT_URL)}&mode=new&path=/etc/passwd&file=secret.md&command=rm -rf`;
        const params = parseYoutnoteUriParams(url);

        expect(params.url).toBe(VALID_YT_URL);
        expect(params.mode).toBe('new');
        expect(params.timestamp).toBeUndefined();
        expect(params.text).toBeUndefined();
        // Unknown params are simply not in the result
        expect(Object.keys(params)).toEqual(['url', 'mode']);
    });

    it('URL-decodes the text param', () => {
        const rawText = 'Hello%20world%20with%20newlines%0Aand%20special%20chars%3A%20%2B%26%23';
        const url = `obsidian://youtnote?url=${encodeURIComponent(VALID_YT_URL)}&mode=note&timestamp=10&text=${rawText}`;
        const params = parseYoutnoteUriParams(url);

        expect(params.text).toBe('Hello world with newlines\nand special chars: +&#');
    });
});

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
        expect(result.mode).toBe('new');
        expect(result.normalizedUrl).toBe(VALID_YT_URL);
    });

    it('rejects invalid mode with an error', () => {
        const params = { url: VALID_YT_URL, mode: 'invalid-mode' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid mode');
        expect(result.error).toContain('invalid-mode');
    });

    it('rejects missing mode with an error', () => {
        const params = { url: VALID_YT_URL };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Missing required "mode"');
    });

    it('rejects url that does not resolve to a YouTube ID', () => {
        const params = { url: 'https://example.com/watch?v=bad', mode: 'new' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('not a valid YouTube URL');
    });

    it('rejects URL > 2000 chars total', () => {
        const params = { url: VALID_YT_URL, mode: 'new' };
        const result = validateYoutnoteUriParams(params, MAX_URL_LENGTH + 1);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('too long');
    });

    it('rejects url param > 500 chars', () => {
        const longUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' + '&x=' + 'a'.repeat(500);
        const params = { url: longUrl, mode: 'new' };
        const result = validateYoutnoteUriParams(params, longUrl.length + 50);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('"url" parameter is too long');
    });

    it('rejects text param > 1000 chars (decoded)', () => {
        const longText = 'a'.repeat(MAX_TEXT_LENGTH + 1);
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10', text: longText };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('"text" parameter is too long');
    });

    it('accepts valid timestamp for mode=note and returns timestampSec', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '1:23', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(true);
        expect(result.mode).toBe('note');
        expect(result.timestampSec).toBe(83);
        expect(result.text).toBe('Note text');
    });

    it('rejects invalid timestamp for mode=note (non-numeric)', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: 'abc', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid timestamp');
    });

    it('rejects invalid timestamp for mode=note (negative)', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '-5', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid timestamp');
    });

    it('accepts timestamp > 86400 seconds (no duration cap at validation time)', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '90000', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(true);
        expect(result.timestampSec).toBe(90000);
    });

    it('rejects missing timestamp for mode=note', () => {
        const params = { url: VALID_YT_URL, mode: 'note', text: 'Note text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Missing required "timestamp"');
    });

    it('rejects missing text for mode=note', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Missing required "text"');
    });

    it('rejects missing text for mode=general-note', () => {
        const params = { url: VALID_YT_URL, mode: 'general-note' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Missing required "text"');
    });

    it('accepts missing timestamp/text for mode=new', () => {
        const params = { url: VALID_YT_URL, mode: 'new' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(true);
        expect(result.timestampSec).toBeUndefined();
        expect(result.text).toBeUndefined();
    });

    it('accepts missing timestamp/text for mode=append', () => {
        const params = { url: VALID_YT_URL, mode: 'append' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(true);
        expect(result.timestampSec).toBeUndefined();
        expect(result.text).toBeUndefined();
    });

    it('accepts mode=general-note with text', () => {
        const params = { url: VALID_YT_URL, mode: 'general-note', text: 'General note content' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(true);
        expect(result.mode).toBe('general-note');
        expect(result.text).toBe('General note content');
    });

    it('rejects missing url param', () => {
        const params = { mode: 'new' };
        const result = validateYoutnoteUriParams(params, 100);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Missing required "url"');
    });

    it('rejects text with leading frontmatter marker', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10', text: '---\nyoutnote: false\n---\nReal note' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('frontmatter marker');
    });

    it('accepts text with --- that appears later (not at the start)', () => {
        const params = { url: VALID_YT_URL, mode: 'note', timestamp: '10', text: 'Some text\n---\nMore text' };
        const result = validateYoutnoteUriParams(params, 200);

        expect(result.valid).toBe(true);
        expect(result.text).toBe('Some text\n---\nMore text');
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
