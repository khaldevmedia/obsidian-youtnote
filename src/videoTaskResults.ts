import { applyGeneratedNotes } from './ai/notePersistence';
import { extractYouTubeId } from './utils';
import type { GeneratedNoteDraft } from './ai/notes';
import type { GeneratedNotePersistenceOptions } from './ai/notePersistence';
import type { Note, TranscriptEntry, Video } from './types';

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
