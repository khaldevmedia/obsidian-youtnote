import { describe, expect, it } from 'vitest';
import {
    createEmptyYoutnoteMarkdown,
    parseYoutnoteDocument,
    serializeYoutnoteDocument,
} from './index';
import type { OpaqueYoutnoteSection } from './types';

const HEADER = '---\nyoutnote: true\nyoutnote-format-version: 2\n---\n';

function sourceBlock(url: string, title: string): string {
    return `<!-- youtnote:section:source:start -->\n[${title}](${url})\n<!-- youtnote:section:source:end -->`;
}

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
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
<!-- youtnote:video:start -->

${sourceBlock(YT, 'Test Video')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:start -->
General body.
<!-- youtnote:general-note:end -->

<!-- youtnote:timestamped-notes:start -->

\`1:23\` <!-- youtnote:timestamp -->
Note body.

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:section:transcript:start -->

\`0:00.120\` <!-- d=4320 --> first
\`5\` <!-- d=0 --> second

<!-- youtnote:section:transcript:end -->

<!-- youtnote:video:end -->
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
<!-- youtnote:video:start -->

${sourceBlock(YT, 'One')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

\`0:05\` <!-- youtnote:timestamp -->
note one

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->

<!-- youtnote:video:start -->

${sourceBlock(YT2, 'Two')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

\`0:10\` <!-- youtnote:timestamp -->
note two

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:section:transcript:start -->

\`7\` <!-- d=0 --> cap

<!-- youtnote:section:transcript:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.videos).toHaveLength(2);
        expect(doc.notes).toHaveLength(2);
        expect(doc.notes[0].videoId).toBe(doc.videos[0].id);
        expect(doc.notes[1].videoId).toBe(doc.videos[1].id);
        expect(doc.videos[0].transcript).toBeUndefined();
        expect(doc.videos[1].transcript).toEqual([{ startMs: 7000, text: 'cap' }]);
    });

    it('isolates markers by section: caption-looking lines in notes are body text', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

\`0:05\` <!-- youtnote:timestamp -->
\`5\` <!-- d=0 --> this is note body, not a caption

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.videos[0].transcript).toBeUndefined();
        expect(doc.notes[0].bodyMarkdown).toContain('`5` <!-- d=0 --> this is note body, not a caption');
    });

    it('treats exact markers inside fenced code blocks as content', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

\`0:05\` <!-- youtnote:timestamp -->
\`\`\`
<!-- youtnote:video:start -->
\`1:00\` <!-- youtnote:timestamp -->
<!-- youtnote:general-note:start -->
<!-- youtnote:general-note:end -->
<!-- youtnote:timestamped-notes:start -->
<!-- youtnote:timestamped-notes:end -->
\`\`\`

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.videos).toHaveLength(1);
        expect(doc.notes).toHaveLength(1);
        expect(doc.notes[0].isGeneral).not.toBe(true);
        expect(doc.notes[0].bodyMarkdown).toContain('<!-- youtnote:video:start -->');
        expect(doc.notes[0].bodyMarkdown).toContain('`1:00` <!-- youtnote:timestamp -->');
        expect(doc.notes[0].bodyMarkdown).toContain('<!-- youtnote:general-note:start -->');
        expect(doc.notes[0].bodyMarkdown).toContain('<!-- youtnote:general-note:end -->');
        expect(doc.notes[0].bodyMarkdown).toContain('<!-- youtnote:timestamped-notes:start -->');
        expect(doc.notes[0].bodyMarkdown).toContain('<!-- youtnote:timestamped-notes:end -->');
    });

    it('preserves unknown sections verbatim and in order', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:section:bookmarks:start version=3 -->
raw *opaque* content
<!-- youtnote:video:start -->
[1:00](timestamp)
<!-- youtnote:section:bookmarks:end -->

<!-- youtnote:section:transcript:start -->

\`1\` <!-- d=0 --> cap

<!-- youtnote:section:transcript:end -->

<!-- youtnote:section:extra:start -->
second opaque
<!-- youtnote:section:extra:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        const layout = doc.videoLayouts[0];
        expect(layout.sections.map(s => s.kind === 'opaque' ? s.type : s.kind)).toEqual([
            'source', 'notes', 'bookmarks', 'transcript', 'extra',
        ]);
        const opaque = layout.sections[2] as OpaqueYoutnoteSection;
        expect(opaque.openingMarker).toBe('<!-- youtnote:section:bookmarks:start version=3 -->');
        expect(opaque.body).toContain('<!-- youtnote:video:start -->');
        expect(opaque.closingMarker).toBe('<!-- youtnote:section:bookmarks:end -->');

        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('<!-- youtnote:section:bookmarks:start version=3 -->');
        expect(serialized).toContain('raw *opaque* content\n<!-- youtnote:video:start -->\n[1:00](timestamp)');
        expect(serialized.indexOf('section:bookmarks:start')).toBeLessThan(serialized.indexOf('section:transcript:start'));
        expect(serialized.indexOf('section:transcript:start')).toBeLessThan(serialized.indexOf('section:extra:start'));

        const reparsed = parseOk(serialized);
        const reparsedOpaque = reparsed.videoLayouts[0].sections[2] as OpaqueYoutnoteSection;
        expect(reparsedOpaque.openingMarker).toBe(opaque.openingMarker);
        expect(reparsedOpaque.body).toBe(opaque.body);
        expect(reparsedOpaque.closingMarker).toBe(opaque.closingMarker);
        const reparsedExtra = reparsed.videoLayouts[0].sections[4] as OpaqueYoutnoteSection;
        const extra = layout.sections[4] as OpaqueYoutnoteSection;
        expect(reparsedExtra).toEqual(extra);
    });

    it('serializes transcript only when non-empty and always writes source and notes sections', () => {
        const doc = parseOk(BASIC);
        doc.videos[0].transcript = [];
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized).toContain('<!-- youtnote:section:source:start -->');
        expect(serialized).toContain('<!-- youtnote:section:notes:start -->');
        expect(serialized).not.toContain('<!-- youtnote:section:transcript:start -->');
    });

    it('round-trips deterministically including the source section', () => {
        const doc = parseOk(BASIC);
        const once = serializeYoutnoteDocument(doc);
        expect(once).toContain('<!-- youtnote:section:source:start -->\n[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n<!-- youtnote:section:source:end -->');
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
        expect(serialized.match(/<!-- youtnote:section:source:start -->/g)).toHaveLength(1);
        expect(serialized.match(/<!-- youtnote:section:source:end -->/g)).toHaveLength(1);
        expect(parseOk(serialized).videos).toHaveLength(1);
    });

    it('emits a notes section for a parsed video whose layout has none', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.videoLayouts[0].sections.map(s => s.kind)).toEqual(['source']);
        const serialized = serializeYoutnoteDocument(doc);
        expect(serialized.match(/<!-- youtnote:section:notes:start -->/g)).toHaveLength(1);
        expect(serialized.match(/<!-- youtnote:section:notes:end -->/g)).toHaveLength(1);
        expect(parseOk(serialized).videos).toHaveLength(1);
    });

    it('keeps a timestamp marker with trailing text as note body', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

\`0:05\` <!-- youtnote:timestamp -->
\`1:00\` <!-- youtnote:timestamp --> trailing text stays body

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(1);
        expect(doc.notes[0].bodyMarkdown).toContain('`1:00` <!-- youtnote:timestamp --> trailing text stays body');
    });

    it('rejects an invalid timestamp value inside the timestamped-notes collection', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

\`1::2\` <!-- youtnote:timestamp -->

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a bare unbounded timestamp marker outside a note record', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

\`1:23\` <!-- youtnote:timestamp -->
Note body.

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects legacy link-based markers where a record is required', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

[1:23](timestamp)
Note body.

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

[general-note](general-note)
General body.

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:transcript:start -->

[5](caption) caption text

<!-- youtnote:section:transcript:end -->

<!-- youtnote:video:end -->
`);
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:transcript:start -->

[0:00.320](caption?durationMs=14260) caption text

<!-- youtnote:section:transcript:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a general-note end marker without a start', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a nested general-note start marker', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:start -->
Body.
<!-- youtnote:general-note:start -->
Nested.
<!-- youtnote:general-note:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a general note missing its end marker before the notes section ends', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:start -->
Body.

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('parses multiple timestamped notes inside one collection', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

\`0:05\` <!-- youtnote:timestamp -->
First body.

\`0:10\` <!-- youtnote:timestamp -->
Second body.

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(2);
        expect(doc.notes[0].timestampSec).toBe(5);
        expect(doc.notes[0].bodyMarkdown).toBe('First body.');
        expect(doc.notes[1].timestampSec).toBe(10);
        expect(doc.notes[1].bodyMarkdown).toBe('Second body.');
        expect(doc.notes.every(n => n.isGeneral !== true)).toBe(true);
    });

    it('starts a second note when a second timestamp marker appears', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->
\`0:05\` <!-- youtnote:timestamp -->
First body.
\`0:10\` <!-- youtnote:timestamp -->
<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(2);
        expect(doc.notes.map(n => n.timestampSec)).toEqual([5, 10]);
        expect(doc.notes[1].bodyMarkdown).toBe('');
    });

    it('rejects a timestamped-notes end marker without a start', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a nested or duplicate timestamped-notes collection', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->
\`0:05\` <!-- youtnote:timestamp -->
Body.
<!-- youtnote:timestamped-notes:start -->
\`0:10\` <!-- youtnote:timestamp -->
Nested.
<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->
<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:timestamped-notes:start -->
<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a timestamped-notes collection missing its end before the notes section ends', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->
\`0:05\` <!-- youtnote:timestamp -->
Body.

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects non-blank content before the first timestamp marker in a collection', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->
Body before the first timestamp.
\`0:05\` <!-- youtnote:timestamp -->
<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->
\`\`\`
fenced before first timestamp
\`\`\`
\`0:05\` <!-- youtnote:timestamp -->
<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a general-note start inside a timestamped-notes collection and vice versa', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->
\`0:05\` <!-- youtnote:timestamp -->
Body.
<!-- youtnote:general-note:start -->
<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:start -->
Body.
<!-- youtnote:timestamped-notes:start -->
<!-- youtnote:general-note:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a mismatched end marker for the open record type', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:start -->
Body.
<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->
\`0:05\` <!-- youtnote:timestamp -->
Body.
<!-- youtnote:general-note:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('serializes exactly one timestamped-notes collection even with zero timestamped notes', () => {
        const generalOnly = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:start -->
General body.
<!-- youtnote:general-note:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const serialized = serializeYoutnoteDocument(parseOk(generalOnly));
        expect(serialized.match(/<!-- youtnote:timestamped-notes:start -->/g)).toHaveLength(1);
        expect(serialized.match(/<!-- youtnote:timestamped-notes:end -->/g)).toHaveLength(1);
        expect(serialized).toContain('<!-- youtnote:timestamped-notes:start -->\n\n<!-- youtnote:timestamped-notes:end -->');
        expect(serialized).toContain('<!-- youtnote:general-note:start -->\nGeneral body.\n<!-- youtnote:general-note:end -->\n\n<!-- youtnote:timestamped-notes:start -->');
        expect(parseOk(serialized).notes).toHaveLength(1);
    });

    it('parses an empty timestamped-notes collection', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(0);
    });

    it('parses a notes section with a general note and no collection', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:start -->
General body.
<!-- youtnote:general-note:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(1);
        expect(doc.notes[0].isGeneral).toBe(true);
    });

    it('treats timestamp-looking lines inside a general note as body', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:general-note:start -->
Summary text.
\`1:23\` <!-- youtnote:timestamp -->
still the general note body
<!-- youtnote:general-note:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(1);
        expect(doc.notes[0].isGeneral).toBe(true);
        expect(doc.notes[0].timestampSec).toBe(-1);
        expect(doc.notes[0].bodyMarkdown).toContain('`1:23` <!-- youtnote:timestamp -->');
        expect(doc.notes[0].bodyMarkdown).toContain('still the general note body');
    });

    it('serializes without legacy synthetic links', () => {
        const serialized = serializeYoutnoteDocument(parseOk(BASIC));
        expect(serialized).not.toContain('](timestamp)');
        expect(serialized).not.toContain('](caption');
        expect(serialized).not.toContain('](general-note)');
        expect(serialized).not.toContain('youtnote:caption');
        expect(serialized).toContain('<!-- youtnote:general-note:start -->\nGeneral body.\n<!-- youtnote:general-note:end -->');
        expect(serialized).toContain('<!-- youtnote:timestamped-notes:start -->\n\n`1:23` <!-- youtnote:timestamp -->\nNote body.\n\n<!-- youtnote:timestamped-notes:end -->');
        expect(serialized).toContain('`0:00.120` <!-- d=4320 --> first');
        expect(serialized).toContain('`5` <!-- d=0 --> second');
        const reparsed = parseOk(serialized);
        expect(reparsed.notes.map(n => ({ ts: n.timestampSec, body: n.bodyMarkdown, general: n.isGeneral === true }))).toEqual(
            parseOk(BASIC).notes.map(n => ({ ts: n.timestampSec, body: n.bodyMarkdown, general: n.isGeneral === true }))
        );
        expect(reparsed.videos[0].transcript).toEqual(parseOk(BASIC).videos[0].transcript);
    });

    it('rejects a video block with no source section', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a bare video link outside the source section', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->
[V](${YT})

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a duplicate source section', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

${sourceBlock(YT2, 'V2')}

<!-- youtnote:video:end -->
`);
    });

    it('rejects a source section after another section', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

${sourceBlock(YT, 'V')}

<!-- youtnote:video:end -->
`);
    });

    it('rejects a source section with attributes', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

<!-- youtnote:section:source:start foo=1 -->
[V](${YT})
<!-- youtnote:section:source:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects an empty source section', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->

<!-- youtnote:section:source:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a source section with two nonblank lines', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[V](${YT})
[Other](${YT2})
<!-- youtnote:section:source:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects a non-YouTube link in the source section', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[Doc](https://example.com)
<!-- youtnote:section:source:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects content before the first video block', () => {
        expectInvalid(`${HEADER}\nstray\n\n${BASIC.slice(HEADER.length)}`);
    });

    it('rejects nested video blocks', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:video:start -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects duplicate managed sections', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects managed sections with attributes', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start foo=1 -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects mismatched section end markers', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:transcript:end -->

<!-- youtnote:video:end -->
`);
    });

    it('rejects unclosed sections and unclosed videos', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->
`);
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}
`);
    });

    it('rejects non-caption content inside transcript sections', () => {
        expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:transcript:start -->

not a caption

<!-- youtnote:section:transcript:end -->

<!-- youtnote:video:end -->
`);
    });

    it('parses a transcript-only video', () => {
        const source = `${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:section:transcript:start -->

\`2\` <!-- d=0 --> only captions

<!-- youtnote:section:transcript:end -->

<!-- youtnote:video:end -->
`;
        const doc = parseOk(source);
        expect(doc.notes).toHaveLength(0);
        expect(doc.videos[0].transcript).toEqual([{ startMs: 2000, text: 'only captions' }]);
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
        expect(serialized).toContain('`0:00.100` <!-- d=2501 --> rounded');
        expect(serialized).toContain('`0:00.200` <!-- d=0 --> absent');
        expect(serialized).toContain('`0:00.300` <!-- d=0 --> zero');
        expect(serialized).toContain('`0:00.400` <!-- d=0 --> negative');
    });

    it('rejects caption lines without a valid numeric d field', () => {
        for (const captionLine of [
            '`5` no comment at all',
            '`5` <!-- --> empty comment',
            '`5` <!-- youtnote:caption --> long form',
            '`5` <!-- youtnote:caption durationMs=1000 --> long form with duration',
            '`5` <!-- d=-1 --> negative duration',
            '`5` <!-- d=abc --> non-numeric duration',
            '`5` <!-- d= --> empty duration',
        ]) {
            expectInvalid(`${HEADER}
<!-- youtnote:video:start -->

${sourceBlock(YT, 'V')}

<!-- youtnote:section:transcript:start -->

${captionLine}

<!-- youtnote:section:transcript:end -->

<!-- youtnote:video:end -->
`);
        }
    });
});

describe('createEmptyYoutnoteMarkdown', () => {
    it('produces a parseable empty v2 document', () => {
        const markdown = createEmptyYoutnoteMarkdown();
        expect(markdown).toBe('---\nyoutnote: true\nyoutnote-format-version: 2\n---\n\n');
        const doc = parseOk(markdown);
        expect(doc.videos).toHaveLength(0);
        expect(doc.notes).toHaveLength(0);
    });
});
