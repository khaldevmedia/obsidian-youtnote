import type { Note, NoteId, VideoId } from '../types';
import type { GeneratedNoteDraft } from './notes';

export type AINoteSaveMode = 'replace' | 'append';

export interface GeneratedNotePersistenceOptions {
    mode: AINoteSaveMode;
    now?: string;
    createId?: () => NoteId;
}

export function applyGeneratedNotes(
    existing: Note[],
    videoId: VideoId,
    drafts: GeneratedNoteDraft[],
    options: GeneratedNotePersistenceOptions,
): Note[] {
    const now = options.now ?? new Date().toISOString();
    const createId = options.createId ?? (() => crypto.randomUUID() as NoteId);
    const base = options.mode === 'replace'
        ? existing.filter(note => note.videoId !== videoId)
        : [...existing];
    const generated: Note[] = drafts.map(draft => ({
        id: createId(),
        videoId,
        timestampSec: draft.timestampSec,
        bodyMarkdown: draft.bodyMarkdown,
        createdAt: now,
        updatedAt: now,
    }));
    return [...base, ...generated];
}
