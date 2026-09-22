import { applyGeneratedNotes } from './ai/notePersistence';
import { extractYouTubeId } from './utils';
import type { GeneratedNoteDraft } from './ai/notes';
import type { GeneratedNotePersistenceOptions } from './ai/notePersistence';
import type { Note, TranscriptEntry, Video } from './types';
import {
    parseYoutnoteDocument,
    serializeYoutnoteDocument,
    updateYoutnoteDocument,
} from './youtnote-format';
import type { ParseYoutnoteResult, YoutnoteDocument } from './youtnote-format';

export function setTranscriptForYoutubeVideo(
    videos: Video[],
    youtubeId: string,
    entries: TranscriptEntry[],
): Video[] | null {
    let found = false;
    const next = videos.map(video => {
        if (extractYouTubeId(video.url) !== youtubeId) {
            return video;
        }
        found = true;
        return { ...video, transcript: entries };
    });
    return found ? next : null;
}

export function applyGeneratedNotesForYoutubeVideo(
    videos: Video[],
    notes: Note[],
    youtubeId: string,
    drafts: GeneratedNoteDraft[],
    options: GeneratedNotePersistenceOptions,
): Note[] | null {
    const target = videos.find(video => extractYouTubeId(video.url) === youtubeId);
    if (!target) {
        return null;
    }
    return applyGeneratedNotes(notes, target.id, drafts, options);
}

export type YoutnoteSourceUpdate =
    | { status: 'updated'; markdown: string }
    | { status: 'missing-target' }
    | { status: 'incompatible'; message: string };

function describeParseFailure(result: ParseYoutnoteResult): string {
    if (result.ok) {
        return '';
    }
    if (result.reason === 'unsupported-version') {
        return `the file uses Youtnote format ${result.version}, which this plugin (formats up to ${result.maxSupported}) cannot write`;
    }
    if (result.reason === 'malformed-version') {
        return `the file declares an invalid Youtnote format version ("${result.rawValue}")`;
    }
    return `the file's contents do not match the Youtnote format (${result.message})`;
}

export function updateYoutnoteSource(
    source: string,
    apply: (document: YoutnoteDocument) => { videos?: Video[]; notes?: Note[] } | null,
): YoutnoteSourceUpdate {
    const parsed = parseYoutnoteDocument(source);
    if (!parsed.ok) {
        return { status: 'incompatible', message: describeParseFailure(parsed) };
    }
    const updated = apply(parsed.document);
    if (!updated) {
        return { status: 'missing-target' };
    }
    const next = updateYoutnoteDocument(
        parsed.document,
        updated.videos ?? parsed.document.videos,
        updated.notes ?? parsed.document.notes,
    );
    return { status: 'updated', markdown: serializeYoutnoteDocument(next) };
}
