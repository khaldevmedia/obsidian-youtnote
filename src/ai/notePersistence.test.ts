import { describe, expect, it } from 'vitest';
import { applyGeneratedNotes } from './notePersistence';
import type { GeneratedNoteDraft } from './notes';
import type { Note, NoteId, VideoId } from '../types';

const videoA = 'video-a' as VideoId;
const videoB = 'video-b' as VideoId;

function makeNote(overrides: Partial<Note> = {}): Note {
    return {
        id: 'note-id' as NoteId,
        videoId: videoA,
        timestampSec: 10,
        bodyMarkdown: 'existing',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeIdFactory(prefix = 'gen'): () => NoteId {
    let counter = 0;
    return () => `${prefix}-${++counter}` as NoteId;
}

describe('applyGeneratedNotes', () => {
    it('replace removes every note for the target video, including general notes, and keeps other videos', () => {
        const existing = [
            makeNote({ id: 'a-1' as NoteId }),
            makeNote({ id: 'a-2' as NoteId, timestampSec: -1, isGeneral: true }),
            makeNote({ id: 'b-1' as NoteId, videoId: videoB }),
        ];
        const drafts: GeneratedNoteDraft[] = [
            { timestampSec: 5, bodyMarkdown: 'first' },
            { timestampSec: 20, bodyMarkdown: 'second' },
        ];

        const result = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'replace',
            now: '2025-01-01T00:00:00.000Z',
            createId: makeIdFactory(),
        });

        expect(result.map(note => note.id)).toEqual(['b-1', 'gen-1', 'gen-2']);
        expect(result[0]).toBe(existing[2]);
    });

    it('append retains all existing notes and duplicate timestamps', () => {
        const existing = [
            makeNote({ id: 'a-1' as NoteId, timestampSec: 10 }),
            makeNote({ id: 'a-2' as NoteId, timestampSec: -1, isGeneral: true }),
        ];
        const drafts: GeneratedNoteDraft[] = [
            { timestampSec: 10, bodyMarkdown: 'duplicate timestamp' },
        ];

        const result = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'append',
            now: '2025-01-01T00:00:00.000Z',
            createId: makeIdFactory(),
        });

        expect(result).toHaveLength(3);
        expect(result[0]).toBe(existing[0]);
        expect(result[1]).toBe(existing[1]);
        expect(result[2].timestampSec).toBe(10);
    });

    it('fills note fields, shares one timestamp, and uses the ID factory per draft', () => {
        const drafts: GeneratedNoteDraft[] = [
            { timestampSec: 1, bodyMarkdown: 'one' },
            { timestampSec: 2, bodyMarkdown: 'two' },
        ];

        const result = applyGeneratedNotes([], videoA, drafts, {
            mode: 'append',
            now: '2025-06-15T12:00:00.000Z',
            createId: makeIdFactory('id'),
        });

        expect(result).toEqual([
            {
                id: 'id-1',
                videoId: videoA,
                timestampSec: 1,
                bodyMarkdown: 'one',
                createdAt: '2025-06-15T12:00:00.000Z',
                updatedAt: '2025-06-15T12:00:00.000Z',
            },
            {
                id: 'id-2',
                videoId: videoA,
                timestampSec: 2,
                bodyMarkdown: 'two',
                createdAt: '2025-06-15T12:00:00.000Z',
                updatedAt: '2025-06-15T12:00:00.000Z',
            },
        ]);
    });

    it('defaults to crypto.randomUUID and a shared current ISO timestamp', () => {
        const result = applyGeneratedNotes([], videoA, [{ timestampSec: 3, bodyMarkdown: 'x' }], {
            mode: 'append',
        });

        expect(result).toHaveLength(1);
        expect(typeof result[0].id).toBe('string');
        expect(result[0].id.length).toBeGreaterThan(0);
        expect(result[0].createdAt).toBe(result[0].updatedAt);
        expect(Number.isNaN(Date.parse(result[0].createdAt))).toBe(false);
    });

    it('does not mutate the input notes array, notes, or drafts', () => {
        const noteA = makeNote({ id: 'a-1' as NoteId });
        const noteB = makeNote({ id: 'b-1' as NoteId, videoId: videoB });
        const existing = [noteA, noteB];
        const drafts: GeneratedNoteDraft[] = [{ timestampSec: 5, bodyMarkdown: 'gen' }];
        const existingSnapshot = structuredClone(existing);
        const draftsSnapshot = structuredClone(drafts);

        const replaceResult = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'replace',
            now: '2025-01-01T00:00:00.000Z',
            createId: makeIdFactory(),
        });
        const appendResult = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'append',
            now: '2025-01-01T00:00:00.000Z',
            createId: makeIdFactory(),
        });

        expect(existing).toEqual(existingSnapshot);
        expect(drafts).toEqual(draftsSnapshot);
        expect(replaceResult).not.toBe(existing);
        expect(appendResult).not.toBe(existing);
    });
});
