import { describe, expect, it, vi } from 'vitest';
import {
    applyGeneratedNotesForYoutubeVideo,
    setTranscriptForYoutubeVideo,
    updateYoutnoteSource,
} from './videoTaskResults';
import type { GeneratedNoteDraft } from './ai/notes';
import type { Note, NoteId, TranscriptEntry, Video, VideoId } from './types';

function makeVideo(id: string, youtubeId: string, transcript?: TranscriptEntry[]): Video {
    return {
        id: id as VideoId,
        url: `https://www.youtube.com/watch?v=${youtubeId}`,
        title: `Video ${youtubeId}`,
        ...(transcript ? { transcript } : {}),
    };
}

function makeNote(overrides: Partial<Note> = {}): Note {
    return {
        id: 'note-id' as NoteId,
        videoId: 'video-a' as VideoId,
        timestampSec: 10,
        bodyMarkdown: 'existing',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        ...overrides,
    };
}

const ENTRIES: TranscriptEntry[] = [
    { startMs: 0, durationMs: 1000, text: 'hello' },
    { startMs: 1000, text: 'world' },
];

describe('setTranscriptForYoutubeVideo', () => {
    it('replaces the transcript of the video matching the YouTube ID', () => {
        const videos = [
            makeVideo('video-a', 'aaaaaaaaaaa', [{ startMs: 5, text: 'old' }]),
            makeVideo('video-b', 'bbbbbbbbbbb'),
        ];
        const next = setTranscriptForYoutubeVideo(videos, 'bbbbbbbbbbb', ENTRIES);
        expect(next).not.toBeNull();
        expect(next![0]).toBe(videos[0]);
        expect(next![0].transcript).toEqual([{ startMs: 5, text: 'old' }]);
        expect(next![1]).not.toBe(videos[1]);
        expect(next![1].transcript).toBe(ENTRIES);
    });

    it('does not mutate the input array or target video', () => {
        const videos = [makeVideo('video-a', 'aaaaaaaaaaa')];
        const next = setTranscriptForYoutubeVideo(videos, 'aaaaaaaaaaa', ENTRIES);
        expect(next).not.toBe(videos);
        expect(videos[0].transcript).toBeUndefined();
    });

    it('returns null when no video matches the YouTube ID', () => {
        const videos = [makeVideo('video-a', 'aaaaaaaaaaa')];
        expect(setTranscriptForYoutubeVideo(videos, 'ccccccccccc', ENTRIES)).toBeNull();
    });
});

describe('applyGeneratedNotesForYoutubeVideo', () => {
    const drafts: GeneratedNoteDraft[] = [
        { timestampSec: 30, bodyMarkdown: 'generated' },
    ];

    it('binds generated notes to the current VideoId of the matching YouTube ID', () => {
        const videos = [
            makeVideo('video-a', 'aaaaaaaaaaa'),
            makeVideo('video-b', 'bbbbbbbbbbb'),
        ];
        const notes = [makeNote({ videoId: 'video-a' as VideoId })];
        const next = applyGeneratedNotesForYoutubeVideo(videos, notes, 'bbbbbbbbbbb', drafts, {
            mode: 'replace',
            createId: () => 'gen-1' as NoteId,
            now: '2025-01-01T00:00:00.000Z',
        });
        expect(next).not.toBeNull();
        const generated = next!.filter(note => note.videoId === 'video-b');
        expect(generated).toHaveLength(1);
        expect(generated[0]).toMatchObject({
            id: 'gen-1',
            timestampSec: 30,
            bodyMarkdown: 'generated',
        });
        expect(next!.filter(note => note.videoId === 'video-a')).toHaveLength(1);
    });

    it('preserves persistence options like append mode and general note handling', () => {
        const videos = [makeVideo('video-a', 'aaaaaaaaaaa')];
        const notes = [
            makeNote({ id: 'n-1' as NoteId, timestampSec: 10, bodyMarkdown: 'keep me' }),
            makeNote({ id: 'n-2' as NoteId, timestampSec: -1, bodyMarkdown: 'old general', isGeneral: true }),
        ];
        const withGeneral: GeneratedNoteDraft[] = [
            { timestampSec: -1, bodyMarkdown: 'new general', isGeneral: true },
            { timestampSec: 30, bodyMarkdown: 'generated' },
        ];
        const next = applyGeneratedNotesForYoutubeVideo(videos, notes, 'aaaaaaaaaaa', withGeneral, {
            mode: 'append',
            generalNoteMode: 'append',
            createId: () => 'gen-1' as NoteId,
            now: '2025-01-01T00:00:00.000Z',
        });
        expect(next).not.toBeNull();
        const general = next!.find(note => note.id === 'n-2');
        expect(general?.bodyMarkdown).toBe('old general\n\nnew general');
        expect(next!.some(note => note.id === 'n-1' && note.bodyMarkdown === 'keep me')).toBe(true);
        expect(next!.filter(note => note.timestampSec === 30)).toHaveLength(1);
    });

    it('returns null when no video matches the YouTube ID', () => {
        const videos = [makeVideo('video-a', 'aaaaaaaaaaa')];
        expect(applyGeneratedNotesForYoutubeVideo(videos, [], 'ccccccccccc', drafts, { mode: 'replace' })).toBeNull();
    });
});

// ─── updateYoutnoteSource (guarded background persistence) ─────────────────

const V2_SOURCE = `---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[Video aaaaaaaaaaa](https://www.youtube.com/watch?v=aaaaaaaaaaa)
<!-- youtnote:section:source:end -->

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;

describe('updateYoutnoteSource', () => {
    it('applies updates to a supported document and reserializes', () => {
        const result = updateYoutnoteSource(V2_SOURCE, (document) => {
            const videos = setTranscriptForYoutubeVideo(document.videos, 'aaaaaaaaaaa', ENTRIES);
            return videos ? { videos } : null;
        });
        expect(result.status).toBe('updated');
        if (result.status !== 'updated') return;
        expect(result.markdown).toContain('<!-- youtnote:section:transcript:start -->');
        expect(result.markdown).toContain('`0` <!-- d=1000 --> hello');
    });

    it('reports missing-target when the video is absent', () => {
        const result = updateYoutnoteSource(V2_SOURCE, (document) => {
            const videos = setTranscriptForYoutubeVideo(document.videos, 'ccccccccccc', ENTRIES);
            return videos ? { videos } : null;
        });
        expect(result.status).toBe('missing-target');
    });

    it.each([
        ['unsupported', '---\nyoutnote: true\nyoutnote-format-version: 3\n---\n'],
        ['malformed', '---\nyoutnote: true\nyoutnote-format-version: two\n---\n'],
        ['invalid', '---\nyoutnote: true\nyoutnote-format-version: 2\n---\n\nstray content\n'],
    ])('returns incompatible for %s sources without producing markdown', (_label, source) => {
        const result = updateYoutnoteSource(source, () => ({ notes: [] }));
        expect(result.status).toBe('incompatible');
        expect(result).not.toHaveProperty('markdown');
    });

    it.each([
        ['unversioned', '---\nyoutnote: true\n---\n\n[Video](https://www.youtube.com/watch?v=aaaaaaaaaaa)\n'],
        ['declared v1', '---\nyoutnote: true\nyoutnote-format-version: 1\n---\n\n[Video](https://www.youtube.com/watch?v=aaaaaaaaaaa)\n'],
    ])('refuses %s legacy sources before calling apply', (_label, source) => {
        const apply = vi.fn(() => ({ notes: [] }));
        const result = updateYoutnoteSource(source, apply);
        expect(result.status).toBe('incompatible');
        if (result.status === 'incompatible') {
            expect(result.message).toContain('legacy Youtnote format');
            expect(result.message).toContain('Convert to v2');
        }
        expect(apply).not.toHaveBeenCalled();
    });

    it('preserves file-level sections through a transcript source update', () => {
        const source = `---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:section:topic-description:start id=x -->
file-level payload
<!-- youtnote:section:topic-description:end -->

<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[Video](https://www.youtube.com/watch?v=aaaaaaaaaaa)
<!-- youtnote:section:source:end -->

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const result = updateYoutnoteSource(source, (document) => {
            const videos = setTranscriptForYoutubeVideo(document.videos, 'aaaaaaaaaaa', ENTRIES);
            return videos ? { videos } : null;
        });
        expect(result.status).toBe('updated');
        if (result.status !== 'updated') return;
        const section = result.markdown.indexOf('section:topic-description:start');
        expect(section).toBeGreaterThan(-1);
        expect(result.markdown).toContain('file-level payload');
        expect(section).toBeLessThan(result.markdown.indexOf('youtnote:video:start'));
        expect(result.markdown).toContain('`0` <!-- d=1000 --> hello');
    });

    it('preserves file-level sections through a generated-notes source update', () => {
        const source = `---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:section:topic-description:start -->
file-level payload
<!-- youtnote:section:topic-description:end -->

<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[Video](https://www.youtube.com/watch?v=aaaaaaaaaaa)
<!-- youtnote:section:source:end -->

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;
        const result = updateYoutnoteSource(source, (document) => {
            const notes = applyGeneratedNotesForYoutubeVideo(
                document.videos,
                document.notes,
                'aaaaaaaaaaa',
                [{ timestampSec: 3, bodyMarkdown: 'draft' }],
                { mode: 'append', generalNoteMode: 'append' },
            );
            return notes ? { notes } : null;
        });
        expect(result.status).toBe('updated');
        if (result.status !== 'updated') return;
        const section = result.markdown.indexOf('section:topic-description:start');
        expect(section).toBeGreaterThan(-1);
        expect(result.markdown).toContain('file-level payload');
        expect(section).toBeLessThan(result.markdown.indexOf('youtnote:video:start'));
        expect(result.markdown).toContain('draft');
    });
});
