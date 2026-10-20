import { describe, expect, it } from 'vitest';
import {
    createEmptyYoutnoteMarkdown,
    parseYoutnoteDocument,
    serializeYoutnoteDocument,
} from './index';
import { extractFrontmatter } from './frontmatter';
import type { OpaqueYoutnoteSection } from './types';

const HEADER = '---\nyoutnote: true\nyoutnote-format-version: 2\n---\n';
const FILE_OPEN = '<!-- youtnote:file:start -->';
const FILE_CLOSE = '<!-- youtnote:file:end -->';

function sourceBlock(url: string, title: string): string {
    return '<!-- youtnote:source:start -->\n' +
        `<!-- youtnote:title:start -->\n${title}\n<!-- youtnote:title:end -->\n` +
        `<!-- youtnote:url:start -->\n${url}\n<!-- youtnote:url:end -->\n` +
        '<!-- youtnote:source:end -->';
}

function videoBlock(url: string, title: string, inner: string): string {
    return `<!-- youtnote:video:start -->\n\n${sourceBlock(url, title)}\n\n${inner}\n<!-- youtnote:video:end -->`;
}

const NOTES_EMPTY = '<!-- youtnote:notes:start -->\n\n<!-- youtnote:notes:end -->';
const YT = 'https://www.youtube.com/watch?v=aircAruvnKk';
const YT2 = 'https://www.youtube.com/watch?v=abcdefghijk';

function parseOk(source: string) {
    const result = parseYoutnoteDocument(source);
    if (!result.ok) {
        throw new Error(`expected ok parse, got ${JSON.stringify(result)}`);
    }
    return result.document;
}

function expectInvalid(source: string) {
    const result = parseYoutnoteDocument(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
        expect(result.reason).toBe('invalid-document');
    }
}

const BASIC = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'Test Video', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
General body.
<!-- youtnote:general-note:end -->

<!-- youtnote:timestamped-note:start t=1:23 -->
Note body.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:transcript:start -->
<!-- t=0:00.120 d=4320 --> first
<!-- t=5 d=0 --> second
<!-- youtnote:transcript:end -->
`)}

${FILE_CLOSE}
`;

describe('v2 parser', () => {
    it('parses the canonical document shape', () => {
        const doc = parseOk(BASIC);
        expect(doc.sourceFormatVersion).toBe(2);
        expect(doc.videos).toHaveLength(1);
        expect(doc.videos[0].url).toBe(YT);
        expect(doc.videos[0].title).toBe('Test Video');
        expect(doc.notes).toHaveLength(2);
        expect(doc.notes.find(n => n.isGeneral)?.bodyMarkdown).toBe('General body.');
        expect(doc.notes.find(n => !n.isGeneral)?.timestampSec).toBe(83);
        expect(doc.videos[0].transcript).toEqual([
            { startMs: 120, durationMs: 4320, text: 'first' },
            { startMs: 5000, text: 'second' },
        ]);
        expect(doc.frontmatter.raw).toContain('youtnote-format-version: 2');
        expect(doc.videoLayouts[0].sections.map(s => s.kind)).toEqual(['source', 'notes', 'transcript']);
    });

    it('parses multiple videos with their own sections', () => {
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'One', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=0:05 -->
note one
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${videoBlock(YT2, 'Two', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=0:10 -->
note two
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:transcript:start -->
<!-- t=7 d=0 --> cap
<!-- youtnote:transcript:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.videos).toHaveLength(2);
        expect(doc.notes).toHaveLength(2);
        expect(doc.notes[0].videoId).toBe(doc.videos[0].id);
        expect(doc.notes[1].videoId).toBe(doc.videos[1].id);
        expect(doc.videos[0].transcript).toBeUndefined();
        expect(doc.videos[1].transcript).toEqual([{ startMs: 7000, text: 'cap' }]);
    });

    it('parses title text verbatim including brackets, parentheses and comment-looking text', () => {
        const title = 'A [bracket] (paren) title <!-- not a marker';
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, title, NOTES_EMPTY)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.videos[0].title).toBe(title);
    });

    it('parses a multiline title verbatim', () => {
        const title = 'Line one\nLine two\n  indented';
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, title, NOTES_EMPTY)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.videos[0].title).toBe(title);
        const reparsed = parseOk(serializeYoutnoteDocument(doc));
        expect(reparsed.videos[0].title).toBe(title);
    });

    it('serializes a missing or empty title without a fake fallback', () => {
        const doc = parseOk(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'Some title', NOTES_EMPTY)}

${FILE_CLOSE}
`);
        doc.videos[0].title = '';
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('<!-- youtnote:title:start -->\n<!-- youtnote:title:end -->');
        expect(parseOk(serialized).videos[0].title).toBe('');
    });

    it('preserves note body whitespace including leading and trailing blank lines', () => {
        const body = '\n\n  indented first\nsecond\n\n';
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=5 -->
${body}<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.notes[0].bodyMarkdown).toBe(body.replace(/\n$/, ''));
        const reparsed = parseOk(serializeYoutnoteDocument(doc));
        expect(reparsed.notes[0].bodyMarkdown).toBe(doc.notes[0].bodyMarkdown);
    });

    it('keeps arbitrary markdown content (headings, lists, code blocks) in note bodies', () => {
        const body = '# Heading\n\n- a\n- b\n\n```ts\nconst x = 1;\n```';
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
${body}
<!-- youtnote:general-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.notes[0].bodyMarkdown).toBe(body);
        expect(parseOk(serializeYoutnoteDocument(doc)).notes[0].bodyMarkdown).toBe(body);
    });

    it('keeps literal youtnote marker text inside balanced fenced code blocks', () => {
        const body = '```\n<!-- youtnote:video:start -->\n<!-- youtnote:general-note:start -->\n<!-- youtnote:file:start -->\n```';
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=0:05 -->
${body}
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.videos).toHaveLength(1);
        expect(doc.notes[0].bodyMarkdown).toBe(body);
    });

    it('round-trips escaped marker-looking and backslash lines', () => {
        const body = '\\<!-- youtnote:video:start -->\nplain\n\\\\C:\\path\\to';
        const doc = parseOk(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
${body}
<!-- youtnote:general-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
        expect(doc.notes[0].bodyMarkdown).toBe('<!-- youtnote:video:start -->\nplain\n\\C:\\path\\to');
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('\\<!-- youtnote:video:start -->');
        expect(parseOk(serialized).notes[0].bodyMarkdown).toBe(doc.notes[0].bodyMarkdown);
    });

    it('escapes unclosed fence delimiters so the record closes correctly', () => {
        const doc = parseOk(BASIC);
        doc.notes[1].bodyMarkdown = 'intro\n```ts\nunclosed code';
        const serialized = serializeYoutnoteDocument(doc);
        const reparsed = parseOk(serialized);
        expect(reparsed.notes[1].bodyMarkdown).toBe('intro\n```ts\nunclosed code');
        expect(reparsed.videos).toHaveLength(1);
    });

    it('escapes fence-like lines and preserves backslash-prefixed fence text', () => {
        const body = '\\``` escaped-looking\n~~~\ninside tilde fence\n~~~';
        const doc = parseOk(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
${body}
<!-- youtnote:general-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
        expect(doc.notes[0].bodyMarkdown).toBe('``` escaped-looking\n~~~\ninside tilde fence\n~~~');
        const reparsed = parseOk(serializeYoutnoteDocument(doc));
        expect(reparsed.notes[0].bodyMarkdown).toBe(doc.notes[0].bodyMarkdown);
    });

    it('round-trips literal end-marker-looking lines in note bodies and titles', () => {
        const doc = parseOk(BASIC);
        doc.notes[1].bodyMarkdown = 'before\n<!-- youtnote:timestamped-note:end -->\nafter';
        doc.videos[0].title = 'Title\n<!-- youtnote:title:end -->\ndone';
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('\\<!-- youtnote:timestamped-note:end -->');
        expect(serialized).toContain('\\<!-- youtnote:title:end -->');
        const reparsed = parseOk(serialized);
        expect(reparsed.notes[1].bodyMarkdown).toBe(doc.notes[1].bodyMarkdown);
        expect(reparsed.videos[0].title).toBe(doc.videos[0].title);
    });

    it('round-trips reserved marker lines with noncanonical spacing', () => {
        const doc = parseOk(BASIC);
        doc.notes[0].bodyMarkdown = '<!--  youtnote:file:end -->\n<!--\tyoutnote:video:start -->';
        const serialized = serializeYoutnoteDocument(doc);
        const reparsed = parseOk(serialized);
        expect(reparsed.notes[0].bodyMarkdown).toBe(doc.notes[0].bodyMarkdown);
    });

    it('round-trips original backslash-prefixed marker and fence lines distinctly', () => {
        const doc = parseOk(BASIC);
        doc.notes[0].bodyMarkdown = '\\<!-- youtnote:video:start -->\n\\```\n```';
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('\\\\<!-- youtnote:video:start -->');
        expect(serialized).toContain('\\\\```');
        expect(serialized).toContain('\\```');
        const reparsed = parseOk(serialized);
        expect(reparsed.notes[0].bodyMarkdown).toBe(doc.notes[0].bodyMarkdown);
    });

    it('preserves carriage returns inside note bodies and titles', () => {
        const doc = parseOk(BASIC);
        doc.notes[0].bodyMarkdown = 'first\r\nsecond';
        doc.videos[0].title = 'One\rtwo';
        const reparsed = parseOk(serializeYoutnoteDocument(doc));
        expect(reparsed.notes[0].bodyMarkdown).toBe('first\r\nsecond');
        expect(reparsed.videos[0].title).toBe('One\rtwo');
    });

    it('keeps caption text starting with backticks from altering note parsing', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = [{ startMs: 5000, text: '```not a fence' }];
        doc.notes[0].bodyMarkdown = 'plain';
        const reparsed = parseOk(serializeYoutnoteDocument(doc));
        expect(reparsed.videos[0].transcript).toEqual([{ startMs: 5000, text: '```not a fence' }]);
        expect(reparsed.notes[0].bodyMarkdown).toBe('plain');
    });

    it('throws instead of serializing an unparseable model', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].url = 'https://example.com/not-youtube';
        expect(() => serializeYoutnoteDocument(doc)).toThrow();

        const multiline = parseOk(BASIC);
        multiline.videos[0].url = `${YT}\nsecond line`;
        expect(() => serializeYoutnoteDocument(multiline)).toThrow();

        const badNote = parseOk(BASIC);
        badNote.notes[1].timestampSec = 1.5;
        expect(() => serializeYoutnoteDocument(badNote)).toThrow();

        const negativeNote = parseOk(BASIC);
        negativeNote.notes[1].timestampSec = -3;
        expect(() => serializeYoutnoteDocument(negativeNote)).toThrow();

        const badCaption = parseOk(BASIC);
        badCaption.videos[0].transcript = [{ startMs: -1, text: 'x' }];
        expect(() => serializeYoutnoteDocument(badCaption)).toThrow();

        const unsafeCaption = parseOk(BASIC);
        unsafeCaption.videos[0].transcript = [{ startMs: 0.5, text: 'x' }];
        expect(() => serializeYoutnoteDocument(unsafeCaption)).toThrow();

        const hugeDuration = parseOk(BASIC);
        hugeDuration.videos[0].transcript = [{ startMs: 0, durationMs: Number.MAX_SAFE_INTEGER + 10, text: 'x' }];
        expect(() => serializeYoutnoteDocument(hugeDuration)).toThrow();
    });

    it('treats a fence-looking line with trailing info inside a fence as literal', () => {
        const body = '```\n<!-- youtnote:video:start -->\n```js not a close\n<!-- youtnote:notes:end -->\n```';
        const doc = parseOk(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
${body}
<!-- youtnote:general-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
        expect(doc.notes[0].bodyMarkdown).toBe(body);
    });

    it('keeps caption-looking lines in notes as body text', () => {
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=0:05 -->
<!-- t=5 d=0 --> this is note body, not a caption

<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.videos[0].transcript).toBeUndefined();
        expect(doc.notes[0].bodyMarkdown).toContain('<!-- t=5 d=0 --> this is note body, not a caption');
    });

    it('preserves unknown file containers inside the wrapper before videos', () => {
        const source = `${HEADER}
${FILE_OPEN}

<!-- youtnote:topic-description:start id=a -->
first payload
<!-- youtnote:topic-description:end -->

${videoBlock(YT, 'One', NOTES_EMPTY)}

<!-- youtnote:meta:start x="1" -->
between
<!-- youtnote:meta:end -->

${videoBlock(YT2, 'Two', NOTES_EMPTY)}

<!-- youtnote:meta:start -->
after
<!-- youtnote:meta:end -->

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.fileSections.map(s => s.type)).toEqual(['topic-description', 'meta', 'meta']);
        expect(doc.fileSections[0].openingMarker).toBe('<!-- youtnote:topic-description:start id=a -->');
        expect(doc.fileSections[0].body).toBe('first payload');
        expect(doc.videos).toHaveLength(2);

        const serialized = serializeYoutnoteDocument(doc);
        const firstVideo = serialized.indexOf('<!-- youtnote:video:start -->');
        expect(serialized.indexOf('first payload')).toBeLessThan(firstVideo);
        expect(serialized.indexOf('between')).toBeLessThan(firstVideo);
        expect(serialized.indexOf('after')).toBeLessThan(firstVideo);
        expect(serialized.indexOf('first payload')).toBeLessThan(serialized.indexOf('between'));
        expect(serialized.indexOf('between')).toBeLessThan(serialized.indexOf('after'));

        const reparsed = parseOk(serialized);
        expect(reparsed.fileSections).toEqual(doc.fileSections);
        expect(serializeYoutnoteDocument(reparsed)).toBe(serialized);
    });

    it('preserves unknown video containers verbatim and in order', () => {
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:notes:end -->

<!-- youtnote:bookmarks:start version=3 -->
raw *opaque* content
<!-- youtnote:video:start -->
<!-- youtnote:bookmarks:end -->

<!-- youtnote:transcript:start -->
<!-- t=1 d=0 --> cap
<!-- youtnote:transcript:end -->

<!-- youtnote:extra:start -->
second opaque
<!-- youtnote:extra:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        const layout = doc.videoLayouts[0];
        expect(layout.sections.map(s => s.kind === 'opaque' ? s.type : s.kind)).toEqual([
            'source', 'notes', 'bookmarks', 'transcript', 'extra',
        ]);
        const opaque = layout.sections[2] as OpaqueYoutnoteSection;
        expect(opaque.openingMarker).toBe('<!-- youtnote:bookmarks:start version=3 -->');
        expect(opaque.body).toContain('<!-- youtnote:video:start -->');
        expect(opaque.closingMarker).toBe('<!-- youtnote:bookmarks:end -->');

        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('<!-- youtnote:bookmarks:start version=3 -->');
        expect(serialized.indexOf('bookmarks:start')).toBeLessThan(serialized.indexOf('transcript:start'));
        const reparsed = parseOk(serialized);
        const reparsedOpaque = reparsed.videoLayouts[0].sections[2] as OpaqueYoutnoteSection;
        expect(reparsedOpaque.openingMarker).toBe(opaque.openingMarker);
        expect(reparsedOpaque.body).toBe(opaque.body);
        expect(reparsedOpaque.closingMarker).toBe(opaque.closingMarker);
        expect(reparsed.videoLayouts[0].sections[4]).toEqual(layout.sections[4]);
    });

    it('balances nested same-type opaque containers', () => {
        const source = `${HEADER}
${FILE_OPEN}

<!-- youtnote:outer:start -->
a
<!-- youtnote:outer:start k=v -->
nested body
<!-- youtnote:outer:end -->
still outer
<!-- youtnote:outer:end -->

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.fileSections).toHaveLength(1);
        expect(doc.fileSections[0].body).toContain('still outer');
        expect(doc.fileSections[0].body).toContain('<!-- youtnote:outer:start k=v -->');
        expect(parseOk(serializeYoutnoteDocument(doc)).fileSections).toEqual(doc.fileSections);
    });

    it('keeps marker-looking text inside opaque bodies opaque', () => {
        const source = `${HEADER}
${FILE_OPEN}

<!-- youtnote:data:start -->
\`\`\`
<!-- youtnote:video:start -->
<!-- youtnote:source:start -->
\`\`\`
<!-- youtnote:data:end -->

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.fileSections).toHaveLength(1);
        expect(doc.fileSections[0].body).toContain('<!-- youtnote:video:start -->');
        expect(serializeYoutnoteDocument(doc)).toContain('<!-- youtnote:data:start -->');
    });

    it('serializes transcript only when non-empty and always writes source and notes sections', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = [];
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('<!-- youtnote:source:start -->');
        expect(serialized).toContain('<!-- youtnote:notes:start -->');
        expect(serialized).not.toContain('<!-- youtnote:transcript:start -->');
    });

    it('round-trips deterministically including the source section', () => {
        const doc = parseOk(BASIC);
        const once = serializeYoutnoteDocument(doc);
        expect(once).toContain(`<!-- youtnote:url:start -->\n${YT}\n<!-- youtnote:url:end -->`);
        const twice = serializeYoutnoteDocument(parseOk(once));
        expect(once).toBe(twice);
        expect(once.endsWith('\n')).toBe(true);
    });

    it('keeps unrelated frontmatter lines through serialization', () => {
        const source = `---\ntitle: keep me\nyoutnote: true\nyoutnote-format-version: 2\ncustom: [a, b]\n---\n\n${BASIC.slice(HEADER.length)}`;
        const doc = parseOk(source);
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('title: keep me');
        expect(serialized).toContain('custom: [a, b]');
        expect(serialized.match(/^youtnote-format-version: 2$/gm)).toHaveLength(1);
    });

    it('repairs an internally missing source slot and emits exactly one', () => {
        const doc = parseOk(BASIC);
        doc.videoLayouts[0].sections = doc.videoLayouts[0].sections.filter(s => s.kind !== 'source');
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized.match(/<!-- youtnote:source:start -->/g)).toHaveLength(1);
        expect(serialized.match(/<!-- youtnote:source:end -->/g)).toHaveLength(1);
        expect(parseOk(serialized).videos).toHaveLength(1);
    });

    it('emits a notes section for a parsed video whose layout has none', () => {
        const doc = parseOk(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:notes:start -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
        doc.videoLayouts[0].sections = doc.videoLayouts[0].sections.filter(s => s.kind !== 'notes');
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized.match(/<!-- youtnote:notes:start -->/g)).toHaveLength(1);
        expect(serialized.match(/<!-- youtnote:notes:end -->/g)).toHaveLength(1);
        expect(parseOk(serialized).videos).toHaveLength(1);
    });

    it('keeps multiple general notes instead of silently discarding them', () => {
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
First general.
<!-- youtnote:general-note:end -->

<!-- youtnote:general-note:start -->
Second general.
<!-- youtnote:general-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(2);
        expect(doc.notes.every(n => n.isGeneral === true)).toBe(true);
        const reparsed = parseOk(serializeYoutnoteDocument(doc));
        expect(reparsed.notes.map(n => n.bodyMarkdown)).toEqual(['First general.', 'Second general.']);
    });

    it('round-trips caption escapes for backslashes, CR and LF', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = [
            { startMs: 0, durationMs: 1000, text: 'path C:\\data\\x' },
            { startMs: 1500, text: 'line one\nline two\rreturn' },
            { startMs: 2000, text: '   spaced   ' },
        ];
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('<!-- t=0 d=1000 --> path C:\\\\data\\\\x');
        expect(serialized).toContain('<!-- t=0:01.500 d=0 --> line one\\nline two\\rreturn');
        expect(serialized).toContain('<!-- t=2 d=0 -->    spaced   ');
        const reparsed = parseOk(serialized);
        expect(reparsed.videos[0].transcript).toEqual(doc.videos[0].transcript);
    });

    it('round-trips captions containing Unicode line and paragraph separators', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = [
            { startMs: 0, text: 'before middle after' },
        ];
        const reparsed = parseOk(serializeYoutnoteDocument(doc));
        expect(reparsed.videos[0].transcript).toEqual([{ startMs: 0, text: 'before middle after' }]);
    });

    it('round-trips an empty caption preserving the required separator space', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = [{ startMs: 3000, text: '' }];
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('<!-- t=3 d=0 --> ');
        expect(parseOk(serialized).videos[0].transcript).toEqual([{ startMs: 3000, text: '' }]);
    });

    it('round-trips captions containing quotes and marker-looking text', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = [
            { startMs: 0, text: 'say "hi" <!-- youtnote:video:start --> ok' },
        ];
        const serialized = serializeYoutnoteDocument(doc);
        const reparsed = parseOk(serialized);
        expect(reparsed.videos[0].transcript).toEqual([{ startMs: 0, text: 'say "hi" <!-- youtnote:video:start --> ok' }]);
    });

    it('round-trips a large transcript without data loss', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = Array.from({ length: 4000 }, (_, i) => ({
            startMs: i * 500,
            durationMs: 400,
            text: `caption ${i} \\ slash`,
        }));
        const serialized = serializeYoutnoteDocument(doc);
        const reparsed = parseOk(serialized);
        expect(reparsed.videos[0].transcript).toEqual(doc.videos[0].transcript);
    });

    it('parses positive d as durationMs and d=0 as no durationMs property', () => {
        const transcript = parseOk(BASIC).videos[0].transcript ?? [];
        expect(transcript).toHaveLength(2);
        expect(transcript[0].durationMs).toBe(4320);
        expect(transcript[1]).not.toHaveProperty('durationMs');
    });

    it('always serializes a d field, emitting d=0 when no usable duration exists', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = [
            { startMs: 100, durationMs: 2500.6, text: 'rounded' },
            { startMs: 200, text: 'absent' },
            { startMs: 300, durationMs: 0, text: 'zero' },
            { startMs: 400, durationMs: -7, text: 'negative' },
        ];
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('<!-- t=0:00.100 d=2501 --> rounded');
        expect(serialized).toContain('<!-- t=0:00.200 d=0 --> absent');
        expect(serialized).toContain('<!-- t=0:00.300 d=0 --> zero');
        expect(serialized).toContain('<!-- t=0:00.400 d=0 --> negative');
    });

    it('rejects a missing file wrapper', () => {
        expectInvalid(`${HEADER}
${videoBlock(YT, 'V', NOTES_EMPTY)}
`);
        expectInvalid(`${HEADER}\n`);
    });

    it('rejects content before the file wrapper and after its end', () => {
        expectInvalid(`${HEADER}\nstray\n\n${BASIC.slice(HEADER.length)}`);
        expectInvalid(`${BASIC}\ntrailing\n`);
    });

    it('rejects a duplicate or nested file wrapper', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

${FILE_OPEN}

${FILE_CLOSE}

${FILE_CLOSE}
`);
        expectInvalid(`${BASIC}
${BASIC.slice(HEADER.length)}`);
    });

    it('rejects a video block with no source section', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects a video block with no notes section', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects a source section that is not first', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${NOTES_EMPTY}

${sourceBlock(YT, 'V')}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects a duplicate source section', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

${sourceBlock(YT2, 'V2')}

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects a source section missing title or url fields', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:url:start -->
${YT}
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
V
<!-- youtnote:title:end -->
<!-- youtnote:source:end -->

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects a url field with no, empty, or multiple lines', () => {
        for (const urlBody of ['', '\n', `${YT}\n${YT2}`]) {
            expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
V
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->${urlBody === '' ? '\n' : `\n${urlBody}\n`}<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
        }
    });

    it('rejects a non-YouTube url', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock('https://example.com', 'Doc', NOTES_EMPTY)}

${FILE_CLOSE}
`);
    });

    it('rejects a url line containing a carriage return', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
V
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->
${YT}\r
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects known markers with unexpected attributes', () => {
        for (const badLine of [
            '<!-- youtnote:video:start x=1 -->',
            '<!-- youtnote:file:start a -->',
        ]) {
            expectInvalid(`${HEADER}
${badLine}

${FILE_CLOSE}
`);
        }
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

<!-- youtnote:source:start foo=1 -->
<!-- youtnote:title:start -->
V
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->
${YT}
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:notes:start foo=1 -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects known markers at the wrong scope', () => {
        for (const type of ['source', 'notes', 'transcript', 'title', 'url', 'general-note', 'timestamped-note']) {
            expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:${type}:start -->
x
<!-- youtnote:${type}:end -->

${FILE_CLOSE}
`);
        }
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:general-note:start -->
body
<!-- youtnote:general-note:end -->

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects nested video blocks', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:video:start -->

<!-- youtnote:video:end -->

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects duplicate managed sections', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

${NOTES_EMPTY}

${NOTES_EMPTY}

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

${NOTES_EMPTY}

<!-- youtnote:transcript:start -->
<!-- youtnote:transcript:end -->

<!-- youtnote:transcript:start -->
<!-- youtnote:transcript:end -->

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
    });

    it('rejects mismatched and unclosed containers', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:notes:start -->

<!-- youtnote:transcript:end -->

<!-- youtnote:video:end -->

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:notes:start -->
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}
`);
    });

    it('rejects timestamped-note records with malformed or missing timestamps', () => {
        for (const t of ['1::2', '1:99', '-5', '1.5', 'abc', `${Number.MAX_SAFE_INTEGER + 1}`]) {
            expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=${t} -->
body
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
        }
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start -->
body
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=5 extra=1 -->
body
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
    });

    it('accepts whole-second note timestamps in S, M:SS and H:MM:SS form', () => {
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=5 -->
a
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:timestamped-note:start t=1:30 -->
b
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:timestamped-note:start t=1:02:03 -->
c
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.notes.map(n => n.timestampSec)).toEqual([5, 90, 3723]);
    });

    it('rejects nested or mismatched note record markers', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
Body.
<!-- youtnote:general-note:start -->
Nested.
<!-- youtnote:general-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
Body.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
    });

    it('rejects unclosed note records', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
Body.

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
    });

    it('rejects non-caption content inside transcript sections', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `${NOTES_EMPTY}

<!-- youtnote:transcript:start -->

not a caption

<!-- youtnote:transcript:end -->
`)}

${FILE_CLOSE}
`);
    });

    it('rejects caption lines without the t/d metadata form', () => {
        for (const captionLine of [
            '<!-- t=5 --> missing d',
            '<!-- d=0 t=5 --> wrong order',
            '<!-- t=5 d=-1 --> negative duration',
            '<!-- t=5 d=abc --> non-numeric duration',
            '<!-- t=5 d= --> empty duration',
            '<!-- t=abc d=0 --> bad time',
            '<!-- t=5 d=0 -->',
            '`5` <!-- d=0 --> old backtick form',
            '[5](caption) legacy link',
        ]) {
            expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `${NOTES_EMPTY}

<!-- youtnote:transcript:start -->

${captionLine}

<!-- youtnote:transcript:end -->
`)}

${FILE_CLOSE}
`);
        }
    });

    it('rejects malformed caption escapes', () => {
        for (const badText of ['trailing \\', 'bad \\q escape', '\\x41 hex']) {
            expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `${NOTES_EMPTY}

<!-- youtnote:transcript:start -->
<!-- t=5 d=0 --> ${badText}
<!-- youtnote:transcript:end -->
`)}

${FILE_CLOSE}
`);
        }
    });

    it('rejects legacy link-based markers where a record is required', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

[1:23](timestamp)
Note body.

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

[general-note](general-note)
General body.

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
    });

    it('rejects old dev-v2 section-prefixed markers', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[V](${YT})
<!-- youtnote:section:source:end -->

<!-- youtnote:video:end -->
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:section:source:start -->
x
<!-- youtnote:section:source:end -->

${FILE_CLOSE}
`);
    });

    it('rejects stray markers and content at file scope', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:data:end -->

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:data:start -->
body
<!-- youtnote:other:end -->

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

some stray paragraph

${FILE_CLOSE}
`);
        expectInvalid(`${HEADER}
${FILE_OPEN}

<!-- youtnote:data:start -->
body
`);
    });

    it('treats unescaped reserved marker lines inside note bodies as structure, not text', () => {
        expectInvalid(`${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
Body.
<!-- youtnote:unknown:start -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`);
    });

    it('parses a transcript-only video', () => {
        const source = `${HEADER}
${FILE_OPEN}

${videoBlock(YT, 'V', `${NOTES_EMPTY}

<!-- youtnote:transcript:start -->
<!-- t=2 d=0 --> only captions
<!-- youtnote:transcript:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(0);
        expect(doc.videos[0].transcript).toEqual([{ startMs: 2000, text: 'only captions' }]);
    });

    it('preserves empty and blank opaque bodies', () => {
        const source = `${HEADER}
${FILE_OPEN}

<!-- youtnote:empty:start -->
<!-- youtnote:empty:end -->

<!-- youtnote:blank:start -->

<!-- youtnote:blank:end -->

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.fileSections).toHaveLength(2);
        expect(doc.fileSections[0].hasBody).toBe(false);
        expect(doc.fileSections[0].body).toBe('');
        const reparsed = parseOk(serializeYoutnoteDocument(doc));
        expect(reparsed.fileSections.map(s => s.hasBody)).toEqual(doc.fileSections.map(s => s.hasBody));
        expect(reparsed.fileSections.map(s => s.body)).toEqual(doc.fileSections.map(s => s.body));
    });

    it('preserves file sections in a document with zero videos and after deleting the last video', () => {
        const source = `${HEADER}
${FILE_OPEN}

<!-- youtnote:topic-description:start -->
only file-level content
<!-- youtnote:topic-description:end -->

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.videos).toHaveLength(0);
        expect(doc.fileSections).toHaveLength(1);
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('only file-level content');
        expect(serialized).toContain(FILE_OPEN);
        expect(parseOk(serialized).fileSections).toEqual(doc.fileSections);

        const withVideo = parseOk(BASIC);
        withVideo.fileSections = doc.fileSections;
        withVideo.videos = [];
        const deleted = serializeYoutnoteDocument(withVideo);
        expect(parseOk(deleted).fileSections).toEqual(doc.fileSections);
    });

    it('initializes fileSections to an empty array for legacy v1 documents', () => {
        const legacy = parseOk('---\nyoutnote: true\n---\n\n[V](https://www.youtube.com/watch?v=aircAruvnKk)\n');
        expect(legacy.sourceFormatVersion).toBe(1);
        expect(legacy.fileSections).toEqual([]);
        const declared = parseOk('---\nyoutnote: true\nyoutnote-format-version: 1\n---\n\n[V](https://www.youtube.com/watch?v=aircAruvnKk)\n');
        expect(declared.fileSections).toEqual([]);
    });
});

describe('createEmptyYoutnoteMarkdown', () => {
    it('produces a parseable empty v2 document', () => {
        const markdown = createEmptyYoutnoteMarkdown();
        expect(markdown).toBe(
            '---\nyoutnote: true\nyoutnote-format-version: 2\n---\n\n' +
            `${FILE_OPEN}\n\n${FILE_CLOSE}\n`);
        const doc = parseOk(markdown);
        expect(doc.videos).toHaveLength(0);
        expect(doc.notes).toHaveLength(0);
    });
});

const RICH_V2_FRONTMATTER = `---
# file-level comment preserved verbatim
title: "Notes: Part #1" # inline comment preserved
tags:
  - learning
  - video-notes
aliases:
  - first-alias
  - "Quoted: Alias #2"
youtnote: true
youtnote-format-version: 2
metadata:
  author: someone
  youtnote-format-version: 99
  nested:
    deep: true
literal_block: |
  literal line one
  literal line two: kept
folded_block: >
  folded text
  continues here
views: 42
draft: false
rating: null
# trailing comment
---`;

describe('rich custom frontmatter preservation', () => {
    it('keeps the raw frontmatter block exactly through parse, serialize, and reparse', () => {
        const source = `${RICH_V2_FRONTMATTER}
${FILE_OPEN}

${videoBlock(YT, 'V', `<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=0:05 -->
Note body.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->
`)}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.frontmatter.raw).toBe(RICH_V2_FRONTMATTER);
        const once = serializeYoutnoteDocument(doc);
        expect(extractFrontmatter(once).raw).toBe(RICH_V2_FRONTMATTER);
        const twice = serializeYoutnoteDocument(parseOk(once));
        expect(twice).toBe(once);
        expect(extractFrontmatter(twice).raw).toBe(RICH_V2_FRONTMATTER);
    });

    it('keeps the raw frontmatter block exactly for an empty v2 document', () => {
        const source = `${RICH_V2_FRONTMATTER}

${FILE_OPEN}

${FILE_CLOSE}
`;
        const doc = parseOk(source);
        expect(doc.videos).toHaveLength(0);
        const once = serializeYoutnoteDocument(doc);
        expect(once).toBe(source);
        expect(extractFrontmatter(once).raw).toBe(RICH_V2_FRONTMATTER);
        expect(serializeYoutnoteDocument(parseOk(once))).toBe(once);
    });
});
