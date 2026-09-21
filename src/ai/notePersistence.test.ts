import { describe, expect, it } from 'vitest';
import { applyGeneratedNotes } from './notePersistence';
import type { GeneratedNoteDraft } from './notes';
import type { Note, NoteId, VideoId } from '../types';

const videoA = 'video-a' as VideoId;
const videoB = 'video-b' as VideoId;
const NOW = '2025-01-01T00:00:00.000Z';

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

const TIMESTAMPED_DRAFTS: GeneratedNoteDraft[] = [
    { timestampSec: 5, bodyMarkdown: 'first' },
    { timestampSec: 20, bodyMarkdown: 'second' },
];

describe('applyGeneratedNotes', () => {
    it('replace without a generated general preserves the target general and other videos, removing old timestamped notes', () => {
        const existing = [
            makeNote({ id: 'a-gen' as NoteId, timestampSec: -1, isGeneral: true, bodyMarkdown: 'old general' }),
            makeNote({ id: 'a-1' as NoteId }),
            makeNote({ id: 'a-2' as NoteId, timestampSec: 30 }),
            makeNote({ id: 'b-1' as NoteId, videoId: videoB }),
        ];

        const result = applyGeneratedNotes(existing, videoA, TIMESTAMPED_DRAFTS, {
            mode: 'replace',
            now: NOW,
            createId: makeIdFactory(),
        });

        expect(result.map(note => note.id)).toEqual(['a-gen', 'b-1', 'gen-1', 'gen-2']);
        expect(result[0]).toBe(existing[0]);
        expect(result[1]).toBe(existing[3]);
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
            now: NOW,
            createId: makeIdFactory(),
        });

        expect(result).toHaveLength(3);
        expect(result[0]).toBe(existing[0]);
        expect(result[1]).toBe(existing[1]);
        expect(result[2].timestampSec).toBe(10);
    });

    it('replaces the existing general note in place under both timestamp modes', () => {
        const existing = [
            makeNote({
                id: 'a-gen' as NoteId,
                timestampSec: -1,
                isGeneral: true,
                bodyMarkdown: 'old general',
                createdAt: 'old-created',
                updatedAt: 'old-updated',
            }),
            makeNote({ id: 'a-1' as NoteId, timestampSec: 10 }),
            makeNote({ id: 'a-gen-dup' as NoteId, timestampSec: -1, isGeneral: true, bodyMarkdown: 'dup general' }),
            makeNote({ id: 'b-gen' as NoteId, videoId: videoB, timestampSec: -1, isGeneral: true }),
            makeNote({ id: 'b-1' as NoteId, videoId: videoB }),
        ];
        const drafts: GeneratedNoteDraft[] = [
            { timestampSec: -1, bodyMarkdown: 'new general', isGeneral: true },
            { timestampSec: 5, bodyMarkdown: 'gen note' },
        ];

        const appended = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'append',
            generalNoteMode: 'replace',
            now: NOW,
            createId: makeIdFactory(),
        });
        expect(appended.map(note => note.id)).toEqual(['a-gen', 'a-1', 'b-gen', 'b-1', 'gen-1']);
        const updated = appended[0];
        expect(updated.createdAt).toBe('old-created');
        expect(updated.updatedAt).toBe(NOW);
        expect(updated.bodyMarkdown).toBe('new general');
        expect(updated.timestampSec).toBe(-1);
        expect(updated.isGeneral).toBe(true);

        const replaced = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'replace',
            generalNoteMode: 'replace',
            now: NOW,
            createId: makeIdFactory(),
        });
        expect(replaced.map(note => note.id)).toEqual(['a-gen', 'b-gen', 'b-1', 'gen-1']);
        expect(replaced[0].bodyMarkdown).toBe('new general');
    });

    it('appends to the existing general note in place with exactly one blank line', () => {
        const existing = [
            makeNote({
                id: 'a-gen' as NoteId,
                timestampSec: -1,
                isGeneral: true,
                bodyMarkdown: 'old general  ',
                createdAt: 'old-created',
                updatedAt: 'old-updated',
            }),
            makeNote({ id: 'a-1' as NoteId, timestampSec: 10 }),
        ];
        const drafts: GeneratedNoteDraft[] = [
            { timestampSec: -1, bodyMarkdown: '  new general', isGeneral: true },
            { timestampSec: 5, bodyMarkdown: 'gen note' },
        ];

        const result = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'replace',
            generalNoteMode: 'append',
            now: NOW,
            createId: makeIdFactory(),
        });

        expect(result.map(note => note.id)).toEqual(['a-gen', 'gen-1']);
        const updated = result[0];
        expect(updated.bodyMarkdown).toBe('old general\n\nnew general');
        expect(updated.createdAt).toBe('old-created');
        expect(updated.updatedAt).toBe(NOW);
        expect(updated.timestampSec).toBe(-1);
        expect(updated.isGeneral).toBe(true);
    });

    it('preserves the existing general note in both timestamp modes when no general is generated', () => {
        const existing = [
            makeNote({ id: 'a-gen' as NoteId, timestampSec: -1, isGeneral: true }),
            makeNote({ id: 'a-1' as NoteId, timestampSec: 10 }),
        ];
        const drafts: GeneratedNoteDraft[] = [{ timestampSec: 5, bodyMarkdown: 'gen' }];

        const appended = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'append',
            now: NOW,
            createId: makeIdFactory(),
        });
        expect(appended.map(note => note.id)).toEqual(['a-gen', 'a-1', 'gen-1']);
        expect(appended[0]).toBe(existing[0]);

        const replaced = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'replace',
            now: NOW,
            createId: makeIdFactory(),
        });
        expect(replaced.map(note => note.id)).toEqual(['a-gen', 'gen-1']);
        expect(replaced[0]).toBe(existing[0]);
    });

    it('creates a general note when none exists and keeps generated timestamped drafts ordinary', () => {
        const existing = [makeNote({ id: 'a-1' as NoteId })];

        const result = applyGeneratedNotes(existing, videoA, [
            { timestampSec: -1, bodyMarkdown: 'Overview' },
            { timestampSec: 10, bodyMarkdown: 'Note' },
        ], {
            mode: 'append',
            now: NOW,
            createId: makeIdFactory(),
        });

        expect(result.map(note => note.id)).toEqual(['a-1', 'gen-1', 'gen-2']);
        expect(result[1]).toEqual({
            id: 'gen-1',
            videoId: videoA,
            timestampSec: -1,
            bodyMarkdown: 'Overview',
            isGeneral: true,
            createdAt: NOW,
            updatedAt: NOW,
        });
        expect(result[2]).not.toHaveProperty('isGeneral');
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
        const noteGen = makeNote({ id: 'a-gen' as NoteId, timestampSec: -1, isGeneral: true });
        const noteB = makeNote({ id: 'b-1' as NoteId, videoId: videoB });
        const existing = [noteA, noteGen, noteB];
        const drafts: GeneratedNoteDraft[] = [
            { timestampSec: -1, bodyMarkdown: 'gen general', isGeneral: true },
            { timestampSec: 5, bodyMarkdown: 'gen' },
        ];
        const existingSnapshot = structuredClone(existing);
        const draftsSnapshot = structuredClone(drafts);

        const replaceResult = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'replace',
            generalNoteMode: 'append',
            now: NOW,
            createId: makeIdFactory(),
        });
        const appendResult = applyGeneratedNotes(existing, videoA, drafts, {
            mode: 'append',
            generalNoteMode: 'append',
            now: NOW,
            createId: makeIdFactory(),
        });

        expect(existing).toEqual(existingSnapshot);
        expect(drafts).toEqual(draftsSnapshot);
        expect(replaceResult).not.toBe(existing);
        expect(appendResult).not.toBe(existing);
    });
});
