import { Note, NoteId, TranscriptEntry, Video, VideoId } from '../types';
import { formatCaptionFileTimestamp, parseCaptionFileTimestamp } from '../transcript';
import { compareNotes, extractYouTubeId, formatSecondsToDisplay, parseTimestampInput } from '../utils';
import { extractFrontmatter } from './frontmatter';
import { LEGACY_FORMAT_VERSION, YoutnoteDocument, YoutnoteSectionSlot } from './types';

interface LegacyParseState {
    videos: Video[];
    notes: Note[];
    lostLines: string[];
}

// Format (v1, unversioned):
// ---
// youtnote: true
// ---
//
// [Video Title](Video URL)
//
// [01:23](timestamp)
// Note body here
//
// [02:45](timestamp)
// Another note here
//
// [0:00.120](caption?durationMs=4320) Caption text

export function parseLegacyYoutnote(source: string): LegacyParseState {
    const videos: Video[] = [];
    const notes: Note[] = [];
    const lostLines: string[] = []; // nonblank body lines the legacy model cannot account for

    const { body } = extractFrontmatter(source);
    const lines = body.split('\n');
    let currentVideo: Video | null = null;
    let currentNote: Partial<Note> | null = null;

    // Helper to commit the current note
    const commitNote = () => {
        if (currentNote && currentNote.videoId && currentNote.timestampSec !== undefined && currentNote.bodyMarkdown !== undefined) {
            currentNote.bodyMarkdown = currentNote.bodyMarkdown.trim();
            notes.push(currentNote as Note);
        }
        currentNote = null;
    };

    const consumeBodyLine = (line: string): boolean => {
        if (currentNote) {
            currentNote.bodyMarkdown += (currentNote.bodyMarkdown ? '\n' : '') + line;
            return true;
        }
        return false;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isBlank = line.trim() === '';

        // Match caption: [1:23](caption) caption text, optionally with a
        // ?durationMs=<ms> marker
        // Checked before the video-link regex because a caption whose text
        // ends with ')' would otherwise match it.
        const captionMatch = line.match(/^\[([\d:.]+)\]\(caption(?:\?durationMs=(\d+))?\) ?(.*)$/);
        if (captionMatch) {
            let consumed = false;
            if (currentVideo) {
                commitNote();
                const startMs = parseCaptionFileTimestamp(captionMatch[1]);
                if (startMs !== null) {
                    const entry: TranscriptEntry = { startMs, text: captionMatch[3] };
                    if (captionMatch[2] !== undefined) {
                        const durationMs = Number(captionMatch[2]);
                        if (Number.isFinite(durationMs) && durationMs > 0) {
                            entry.durationMs = durationMs;
                        }
                    }
                    if (!currentVideo.transcript) {
                        currentVideo.transcript = [];
                    }
                    currentVideo.transcript.push(entry);
                    consumed = true;
                }
            }
            if (!consumed && !isBlank) {
                lostLines.push(line);
            }
            continue;
        }

        // Match Video: [Title](URL) - must not be a timestamp or general-note link
        const videoMatch = line.match(/^\[(.*?)\]\((.+)\)$/);
        if (videoMatch && videoMatch[2] !== 'timestamp' && videoMatch[2] !== 'general-note') {
            const ytId = extractYouTubeId(videoMatch[2]);
            if (!ytId) {
                // Regular markdown link in note body, not a video section delimiter.
                if (!consumeBodyLine(line) && !isBlank) {
                    lostLines.push(line);
                }
                continue;
            }

            commitNote();

            const title = videoMatch[1];
            const url = videoMatch[2];

            currentVideo = {
                id: crypto.randomUUID() as VideoId,
                title: title,
                url: url,
                durationSec: 0,
                ...(ytId && { thumbnail: `https://img.youtube.com/vi/${ytId}/default.jpg` })
            };
            videos.push(currentVideo);
            continue;
        }

        // Match Note Timestamp: [01:23](timestamp)
        const timeMatch = line.match(/^\[([\d:]+)\]\(timestamp\)/);
        if (timeMatch) {
            if (currentVideo) {
                commitNote();

                const timeStr = timeMatch[1];
                const result = parseTimestampInput(timeStr, 0);
                const seconds = result.seconds;

                currentNote = {
                    id: crypto.randomUUID() as NoteId,
                    videoId: currentVideo.id,
                    timestampSec: seconds,
                    bodyMarkdown: '',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
            } else if (!isBlank) {
                lostLines.push(line);
            }
            continue;
        }

        // Match General Note: [general-note](general-note)
        if (line === '[general-note](general-note)') {
            if (currentVideo) {
                commitNote();

                currentNote = {
                    id: crypto.randomUUID() as NoteId,
                    videoId: currentVideo.id,
                    timestampSec: -1,
                    bodyMarkdown: '',
                    isGeneral: true,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
            } else {
                lostLines.push(line);
            }
            continue;
        }

        // Accumulate note body
        if (!consumeBodyLine(line) && !isBlank) {
            lostLines.push(line);
        }
    }

    commitNote();

    for (const video of videos) {
        video.transcript?.sort((a, b) => a.startMs - b.startMs);
    }

    return { videos, notes, lostLines };
}

export function buildDefaultLayout(video: Video): YoutnoteSectionSlot[] {
    const sections: YoutnoteSectionSlot[] = [{ kind: 'source' }, { kind: 'notes' }];
    if (video.transcript && video.transcript.length > 0) {
        sections.push({ kind: 'transcript' });
    }
    return sections;
}

export function readLegacyDocument(source: string): { ok: true; document: YoutnoteDocument } | { ok: false; message: string } {
    const frontmatter = extractFrontmatter(source);
    const { videos, notes, lostLines } = parseLegacyYoutnote(source);

    if (lostLines.length > 0) {
        const preview = lostLines[0].length > 80 ? `${lostLines[0].slice(0, 80)}…` : lostLines[0];
        return {
            ok: false,
            message: `The file contains content the legacy Youtnote format cannot represent (first occurrence: "${preview}").`,
        };
    }

    return {
        ok: true,
        document: {
            sourceFormatVersion: LEGACY_FORMAT_VERSION,
            frontmatter: { raw: frontmatter.raw },
            videos,
            notes,
            videoLayouts: videos.map(video => ({
                videoId: video.id,
                sections: buildDefaultLayout(video),
            })),
        },
    };
}

export function buildSortedNotesByVideo(notes: Note[]): Map<VideoId, Note[]> {
    const notesByVideo = new Map<VideoId, Note[]>();

    for (const note of notes) {
        const list = notesByVideo.get(note.videoId);
        if (list) {
            list.push(note);
        } else {
            notesByVideo.set(note.videoId, [note]);
        }
    }

    notesByVideo.forEach((videoNotes) => {
        // General notes (timestampSec === -1) always come first
        videoNotes.sort(compareNotes);
    });

    return notesByVideo;
}

export { formatCaptionFileTimestamp, formatSecondsToDisplay };
