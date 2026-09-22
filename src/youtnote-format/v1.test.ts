import { describe, expect, it } from 'vitest';
import { parseYoutnoteDocument } from './index';

const LEGACY_HEADER = '---\nyoutnote: true\n---\n';

function parseOk(source: string) {
    const result = parseYoutnoteDocument(source);
    if (!result.ok) {
        throw new Error(`expected ok parse, got ${JSON.stringify(result)}`);
    }
    return result.document;
}

describe('legacy (v1) reader', () => {
    it('keeps regular markdown links in note body and does not treat them as videos', () => {
        const markdown = `${LEGACY_HEADER}
[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[00:05](timestamp)
Line 1
[Google](https://google.com)
Line 2
`;

        const doc = parseOk(markdown);
        expect(doc.videos).toHaveLength(1);
        expect(doc.notes).toHaveLength(1);
        expect(doc.notes[0].bodyMarkdown).toContain('[Google](https://google.com)');
        expect(doc.notes[0].bodyMarkdown).toContain('Line 2');
    });

    it('parses general notes and timestamped notes', () => {
        const markdown = `${LEGACY_HEADER}
[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[general-note](general-note)
This is a general note about the whole video.

[00:05](timestamp)
First timestamped note.
`;

        const doc = parseOk(markdown);
        const general = doc.notes.find(n => n.isGeneral);
        expect(general?.timestampSec).toBe(-1);
        expect(general?.bodyMarkdown).toBe('This is a general note about the whole video.');
        const timestamped = doc.notes.find(n => !n.isGeneral);
        expect(timestamped?.timestampSec).toBe(5);
    });

    it('parses caption lines into the video transcript and sorts them', () => {
        const markdown = `${LEGACY_HEADER}
[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[0:05](timestamp)
A note.

[1:55](caption) late caption
[0:00.320](caption?durationMs=14260) early caption
[5](caption) middle caption
`;

        const doc = parseOk(markdown);
        expect(doc.notes[0].bodyMarkdown).toBe('A note.');
        expect(doc.videos[0].transcript).toEqual([
            { startMs: 320, durationMs: 14260, text: 'early caption' },
            { startMs: 5000, text: 'middle caption' },
            { startMs: 115000, text: 'late caption' },
        ]);
    });

    it('builds default layouts of notes then transcript per video', () => {
        const markdown = `${LEGACY_HEADER}
[With Transcript](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[5](caption) hi

[No Transcript](https://www.youtube.com/watch?v=abcdefghijk)

[0:10](timestamp)
note
`;

        const doc = parseOk(markdown);
        expect(doc.sourceFormatVersion).toBe(1);
        expect(doc.videoLayouts).toHaveLength(2);
        const layoutA = doc.videoLayouts.find(l => l.videoId === doc.videos[0].id);
        const layoutB = doc.videoLayouts.find(l => l.videoId === doc.videos[1].id);
        expect(layoutA?.sections.map(s => s.kind)).toEqual(['source', 'notes', 'transcript']);
        expect(layoutB?.sections.map(s => s.kind)).toEqual(['source', 'notes']);
    });

    it('fails when nonblank content appears before the first video', () => {
        const markdown = `${LEGACY_HEADER}
Stray paragraph.

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
`;
        const result = parseYoutnoteDocument(markdown);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('invalid-document');
    });

    it('fails when a caption-like line has no current video', () => {
        const markdown = `${LEGACY_HEADER}
[5](caption) orphan caption

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
`;
        const result = parseYoutnoteDocument(markdown);
        expect(result.ok).toBe(false);
    });

    it('fails when a timestamp marker appears outside a video', () => {
        const markdown = `${LEGACY_HEADER}
[0:05](timestamp)
Orphan note body.
`;
        const result = parseYoutnoteDocument(markdown);
        expect(result.ok).toBe(false);
    });

    it('absorbs trailing nonblank lines into the open note body like the old parser', () => {
        const markdown = `${LEGACY_HEADER}
[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[0:05](timestamp)
A note.

Stray text between records is impossible here;
`;

        const doc = parseOk(markdown);
        expect(doc.notes[0].bodyMarkdown).toContain('Stray text between records');
    });

    it('allows blank separator lines anywhere', () => {
        const markdown = `${LEGACY_HEADER}\n\n\n[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n\n\n`;
        const doc = parseOk(markdown);
        expect(doc.videos).toHaveLength(1);
    });
});
