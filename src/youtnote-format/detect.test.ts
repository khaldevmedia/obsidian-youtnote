import { describe, expect, it } from 'vitest';
import { detectYoutnoteFormat } from './detect';
import { extractFrontmatter, withFormatVersion } from './frontmatter';
import { CURRENT_FORMAT_VERSION } from './types';

const fm = (inner: string) => `---\n${inner}\n---\n\nbody\n`;

describe('detectYoutnoteFormat', () => {
    it('detects missing youtnote-format-version as legacy', () => {
        expect(detectYoutnoteFormat(fm('youtnote: true'))).toEqual({ kind: 'legacy', version: 1 });
    });

    it('detects missing frontmatter entirely as legacy', () => {
        expect(detectYoutnoteFormat('# just markdown\n')).toEqual({ kind: 'legacy', version: 1 });
    });

    it('detects explicit format 1 as legacy', () => {
        expect(detectYoutnoteFormat(fm('youtnote: true\nyoutnote-format-version: 1'))).toEqual({ kind: 'legacy', version: 1 });
    });

    it('detects format 2 as supported', () => {
        expect(detectYoutnoteFormat(fm('youtnote: true\nyoutnote-format-version: 2'))).toEqual({ kind: 'supported', version: 2 });
    });

    it('detects newer formats as unsupported', () => {
        expect(detectYoutnoteFormat(fm('youtnote: true\nyoutnote-format-version: 3'))).toEqual({
            kind: 'unsupported-version',
            version: 3,
            maxSupported: CURRENT_FORMAT_VERSION,
        });
    });

    it.each(['0', '-1', '2.5', '1.4.0', 'two', '"2"', "'2'", '2 3', 'v2'])(
        'detects %s as malformed',
        (value) => {
            const result = detectYoutnoteFormat(fm(`youtnote: true\nyoutnote-format-version: ${value}`));
            expect(result.kind).toBe('malformed-version');
        },
    );

    it('detects duplicate youtnote-format-version declarations as malformed', () => {
        const result = detectYoutnoteFormat(fm('youtnote: true\nyoutnote-format-version: 2\nyoutnote-format-version: 2'));
        expect(result.kind).toBe('malformed-version');
    });

    it('ignores nested/indented youtnote-format-version keys', () => {
        const result = detectYoutnoteFormat(fm('youtnote: true\nother:\n  youtnote-format-version: 99'));
        expect(result).toEqual({ kind: 'legacy', version: 1 });
    });

    it('tolerates an inline comment after the value', () => {
        expect(detectYoutnoteFormat(fm('youtnote: true\nyoutnote-format-version: 2 # keep'))).toEqual({ kind: 'supported', version: 2 });
    });
});

describe('withFormatVersion', () => {
    it('creates a canonical frontmatter block when none exists', () => {
        expect(withFormatVersion({ raw: '' })).toBe('---\nyoutnote: true\nyoutnote-format-version: 2\n---');
    });

    it('inserts youtnote-format-version after the youtnote key and preserves other lines', () => {
        const raw = '---\ntitle: My note # comment\nyoutnote: true\ntags:\n  - a\n  - b\ncustom: [1, 2]\n---';
        const result = withFormatVersion({ raw });
        expect(result).toBe(
            '---\ntitle: My note # comment\nyoutnote: true\nyoutnote-format-version: 2\ntags:\n  - a\n  - b\ncustom: [1, 2]\n---',
        );
    });

    it('replaces an existing youtnote-format-version line in place', () => {
        const raw = '---\nyoutnote-format-version: 1\nyoutnote: true\n---';
        expect(withFormatVersion({ raw })).toBe('---\nyoutnote-format-version: 2\nyoutnote: true\n---');
    });

    it('inserts at the top when no youtnote key exists', () => {
        const raw = '---\ntitle: x\n---';
        expect(withFormatVersion({ raw })).toBe('---\nyoutnote-format-version: 2\ntitle: x\n---');
    });
});

describe('extractFrontmatter', () => {
    it('returns the raw block including delimiters', () => {
        const source = fm('youtnote: true');
        const { raw, body } = extractFrontmatter(source);
        expect(raw).toBe('---\nyoutnote: true\n---');
        expect(body).toBe('\n\nbody\n');
    });

    it('returns empty raw when absent', () => {
        const { raw, body } = extractFrontmatter('no frontmatter\n');
        expect(raw).toBe('');
        expect(body).toBe('no frontmatter\n');
    });
});
