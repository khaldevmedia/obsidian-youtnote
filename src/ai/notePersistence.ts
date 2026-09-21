import type { Note, NoteId, VideoId } from '../types';
import type { GeneratedNoteDraft } from './notes';

export type AINoteSaveMode = 'replace' | 'append';
export type AIGeneralNoteMode = 'replace' | 'append';

export interface GeneratedNotePersistenceOptions {
    mode: AINoteSaveMode;
    generalNoteMode?: AIGeneralNoteMode;
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
    const isGeneralNote = (note: Note): boolean => note.isGeneral === true || note.timestampSec === -1;
    const isGeneralDraft = (draft: GeneratedNoteDraft): boolean => draft.isGeneral === true || draft.timestampSec === -1;
    const generatedGeneral = drafts.find(isGeneralDraft);
    const timestampedDrafts = drafts.filter(draft => !isGeneralDraft(draft));
    const existingGeneral = existing.find(note => note.videoId === videoId && isGeneralNote(note));

    let base = existing.filter(note =>
        note.videoId !== videoId || isGeneralNote(note) || options.mode === 'append'
    );

    if (generatedGeneral && existingGeneral) {
        const bodyMarkdown = options.generalNoteMode === 'append'
            ? `${existingGeneral.bodyMarkdown.trimEnd()}\n\n${generatedGeneral.bodyMarkdown.trimStart()}`
            : generatedGeneral.bodyMarkdown;
        base = base
            .filter(note => note.videoId !== videoId || !isGeneralNote(note) || note.id === existingGeneral.id)
            .map(note => note.id === existingGeneral.id ? {
                ...note,
                timestampSec: -1,
                bodyMarkdown,
                isGeneral: true,
                updatedAt: now,
            } : note);
    } else if (generatedGeneral) {
        base = [...base, {
            id: createId(),
            videoId,
            timestampSec: -1,
            bodyMarkdown: generatedGeneral.bodyMarkdown,
            isGeneral: true,
            createdAt: now,
            updatedAt: now,
        }];
    }

    const generatedTimestamped: Note[] = timestampedDrafts.map(draft => ({
        id: createId(),
        videoId,
        timestampSec: draft.timestampSec,
        bodyMarkdown: draft.bodyMarkdown,
        createdAt: now,
        updatedAt: now,
    }));
    return [...base, ...generatedTimestamped];
}
