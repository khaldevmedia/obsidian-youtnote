import { describe, expect, it } from 'vitest';
import {
    createEmptyYoutnoteMarkdown,
    migrateLegacyYoutnote,
    parseYoutnoteDocument,
    serializeYoutnoteDocument,
    youtnoteDocumentsEquivalent,
} from './index';

const LEGACY = `---
youtnote: true
---

[How Transformers Work](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[general-note](general-note)
Overview of the video.

[01:23](timestamp)
First timestamped note.

[0:00.320](caption?durationMs=14260) [Music]
[5](caption) hello

[Second](https://www.youtube.com/watch?v=abcdefghijk)

[0:10](timestamp)
Another note.
`;

describe('migrateLegacyYoutnote', () => {
    it('produces v2 markdown that reparses to an equivalent document', () => {
        const result = migrateLegacyYoutnote(LEGACY);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.markdown).toContain('youtnote-format-version: 2');
        expect(result.markdown).toContain('<!-- youtnote:video:start -->');
        expect(result.markdown).toContain('<!-- youtnote:section:source:start -->');
        expect(result.markdown).toContain('<!-- youtnote:section:notes:start -->');
        expect(result.markdown).toContain('<!-- youtnote:section:transcript:start -->');
        expect(result.markdown).toContain('[0:00.320](caption?durationMs=14260) [Music]');

        const reparsed = parseYoutnoteDocument(result.markdown);
        expect(reparsed.ok).toBe(true);
        if (reparsed.ok) {
            expect(reparsed.document.sourceFormatVersion).toBe(2);
            expect(reparsed.document.videos).toHaveLength(2);
            expect(reparsed.document.notes).toHaveLength(3);
        }
    });

    it('retains unrelated frontmatter verbatim', () => {
        const source = `---
title: My custom title # keep this comment
youtnote: true
tags: [a, b]
---

[Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[0:05](timestamp)
Note.
`;
        const result = migrateLegacyYoutnote(source);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.markdown).toContain('title: My custom title # keep this comment');
        expect(result.markdown).toContain('tags: [a, b]');
        expect(result.markdown).toContain('youtnote-format-version: 2');
        expect(result.markdown).toContain('youtnote: true');
    });

    it('rejects migration when nonblank content would be lost', () => {
        const source = `---
youtnote: true
---

Stray paragraph before the first video.

[Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
`;
        const result = migrateLegacyYoutnote(source);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('invalid-document');
        }
    });

    it('is idempotent on already-migrated output', () => {
        const first = migrateLegacyYoutnote(LEGACY);
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const second = migrateLegacyYoutnote(first.markdown);
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.markdown).toBe(first.markdown);
    });

    it('reports migration kinds: legacy-to-current and none', () => {
        const legacy = migrateLegacyYoutnote(LEGACY);
        expect(legacy.ok).toBe(true);
        if (legacy.ok) expect(legacy.migration).toBe('legacy-to-current');
        if (legacy.ok) {
            const again = migrateLegacyYoutnote(legacy.markdown);
            expect(again.ok).toBe(true);
            if (again.ok) expect(again.migration).toBe('none');
        }
    });

    it('passes through unsupported and malformed detections', () => {
        const unsupported = migrateLegacyYoutnote('---\nyoutnote: true\nyoutnote-format-version: 3\n---\n');
        expect(unsupported.ok).toBe(false);
        if (!unsupported.ok) expect(unsupported.reason).toBe('unsupported-version');

        const malformed = migrateLegacyYoutnote('---\nyoutnote: true\nyoutnote-format-version: two\n---\n');
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.reason).toBe('malformed-version');
    });

    it('validates semantic equivalence helper on the migrated document', () => {
        const legacy = parseYoutnoteDocument(LEGACY);
        const migrated = migrateLegacyYoutnote(LEGACY);
        expect(legacy.ok && migrated.ok).toBe(true);
        if (legacy.ok && migrated.ok) {
            expect(youtnoteDocumentsEquivalent(legacy.document, migrated.document)).toBe(true);
        }
    });

    it('serializes an empty document created from scratch', () => {
        const parsed = parseYoutnoteDocument(createEmptyYoutnoteMarkdown());
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(serializeYoutnoteDocument(parsed.document)).toBe(createEmptyYoutnoteMarkdown());
    });
});

const V2_BODY = `
<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
<!-- youtnote:section:source:end -->

<!-- youtnote:section:notes:start -->

[0:05](timestamp)
Note.

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;

describe('corrected-declaration recovery', () => {
    it('corrects a declared version 1 over a valid v2 body, preserving the body exactly', () => {
        const source = `---\nyoutnote: true\nyoutnote-format-version: 1\n---\n${V2_BODY}`;
        const result = migrateLegacyYoutnote(source);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.migration).toBe('corrected-declaration');
        expect(result.markdown).toBe(`---\nyoutnote: true\nyoutnote-format-version: 2\n---\n${V2_BODY}`);
        const reparsed = parseYoutnoteDocument(result.markdown);
        expect(reparsed.ok).toBe(true);
        if (reparsed.ok) {
            expect(reparsed.document.videos).toHaveLength(1);
            expect(reparsed.document.notes).toHaveLength(1);
        }
    });

    it('refuses a declared future version even when the body is valid v2', () => {
        const source = `---\nyoutnote: true\nyoutnote-format-version: 3\n---\n${V2_BODY}`;
        const result = migrateLegacyYoutnote(source);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('unsupported-version');
    });

    it('refuses a malformed declaration even when the body is valid v2', () => {
        const source = `---\nyoutnote: true\nyoutnote-format-version: two\n---\n${V2_BODY}`;
        const result = migrateLegacyYoutnote(source);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('malformed-version');
    });

    it('still refuses an invalid body under a declared version 1', () => {
        const source = `---\nyoutnote: true\nyoutnote-format-version: 1\n---\n\nstray unaccounted content\n`;
        const result = migrateLegacyYoutnote(source);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('invalid-document');
    });
});
