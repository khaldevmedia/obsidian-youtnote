import { describe, expect, it } from 'vitest';
import {
    applyGeneratedNotesForYoutubeVideo,
    setTranscriptForYoutubeVideo,
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
