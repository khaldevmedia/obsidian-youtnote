import { Video, Note, VideoId, NoteId, ExportOptions } from './types';
import {
    compareNotes,
    extractYouTubeId,
    formatSecondsToDisplay,
    parseTimestampInput
} from './utils';

function buildSortedNotesByVideo(notes: Note[]): Map<VideoId, Note[]> {
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

// Format:
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

export function parseMarkdownToData(markdown: string): { videos: Video[], notes: Note[] } {
    const videos: Video[] = [];
    const notes: Note[] = [];

    const lines = markdown.split('\n');
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

    let inFrontmatter = false;
    let frontmatterLines = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip frontmatter
        if (line === '---' && frontmatterLines === 0) {
            inFrontmatter = true;
            frontmatterLines++;
            continue;
        }
        if (inFrontmatter) {
            if (line === '---') {
                inFrontmatter = false;
            }
            continue;
        }

        // Match Transcript caption: [1:23](transcript) caption text
        // Checked before the video-link regex because a caption whose text
        // ends with ')' would otherwise match it.
        const transcriptMatch = line.match(/^\[([\d:]+)\]\(transcript\) ?(.*)$/);
        if (transcriptMatch) {
            if (currentVideo) {
                commitNote();
                const result = parseTimestampInput(transcriptMatch[1], 0);
                if (!currentVideo.transcript) {
                    currentVideo.transcript = [];
                }
                currentVideo.transcript.push({ timestampSec: result.seconds, text: transcriptMatch[2] });
            }
            continue;
        }

        // Match Video: [Title](URL) - must not be a timestamp or general-note link
        const videoMatch = line.match(/^\[(.*?)\]\((.+)\)$/);
        if (videoMatch && videoMatch[2] !== 'timestamp' && videoMatch[2] !== 'general-note') {
            const ytId = extractYouTubeId(videoMatch[2]);
            if (!ytId) {
                // Regular markdown link in note body, not a video section delimiter.
                if (currentNote) {
                    currentNote.bodyMarkdown += (currentNote.bodyMarkdown ? '\n' : '') + line;
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
        if (timeMatch && currentVideo) {
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
            continue;
        }

        // Match General Note: [general-note](general-note)
        if (line === '[general-note](general-note)' && currentVideo) {
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
            continue;
        }

        // Accumulate note body
        if (currentNote) {
            currentNote.bodyMarkdown += (currentNote.bodyMarkdown ? '\n' : '') + line;
        }
    }

    commitNote();

    return { videos, notes };
}

export function serializeDataToMarkdown(videos: Video[], notes: Note[]): string {
    const lines: string[] = [];
    const notesByVideo = buildSortedNotesByVideo(notes);

    // Add frontmatter
    lines.push('---');
    lines.push('youtnote: true');
    lines.push('---');
    lines.push('');

    for (const video of videos) {
        lines.push(`[${video.title || video.url}](${video.url})`);
        lines.push('');

        const videoNotes = notesByVideo.get(video.id) || [];

        for (const note of videoNotes) {
            if (note.isGeneral === true || note.timestampSec === -1) {
                lines.push('[general-note](general-note)');
            } else {
                const timeStr = formatSecondsToDisplay(note.timestampSec, 0);
                lines.push(`[${timeStr}](timestamp)`);
            }
            lines.push(note.bodyMarkdown);
            lines.push('');
        }

        if (video.transcript?.length) {
            for (const entry of video.transcript) {
                lines.push(`[${formatSecondsToDisplay(entry.timestampSec, 0)}](transcript) ${entry.text}`);
            }
            lines.push('');
        }

        lines.push(''); // Extra spacing between videos
    }

    return lines.join('\n').trim() + '\n';
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = { includeNotes: true, includeTranscripts: true };

/**
 * Helper function to generate export content for a list of videos and their notes.
 * Creates markdown with YouTube timestamp links.
 */
function generateExportContent(videos: Video[], notes: Note[], options: ExportOptions = DEFAULT_EXPORT_OPTIONS): string {
    const lines: string[] = [];
    const notesByVideo = buildSortedNotesByVideo(notes);

    for (const video of videos) {
        // Video title as a link (paragraph, not heading)
        lines.push(`[${video.title || video.url}](${video.url})`);
        lines.push('');

        const videoNotes = notesByVideo.get(video.id) || [];
        const ytId = extractYouTubeId(video.url);

        if (options.includeNotes) {
            for (const note of videoNotes) {
                const isGeneral = note.isGeneral === true || note.timestampSec === -1;

                if (isGeneral) {
                    lines.push('**General note:**');
                    lines.push(note.bodyMarkdown);
                    lines.push('');
                    continue;
                }

                const timeStr = formatSecondsToDisplay(note.timestampSec, 0);

                // Create YouTube timestamp link
                const timestampUrl = ytId
                    ? `https://youtu.be/${ytId}?t=${Math.floor(note.timestampSec)}`
                    : video.url;

                lines.push(`[${timeStr}](${timestampUrl})`);
                lines.push(note.bodyMarkdown);
                lines.push('');
            }
        }

        if (options.includeTranscripts && video.transcript?.length) {
            lines.push('**Transcript:**');
            lines.push('');

            for (const entry of video.transcript) {
                const timeStr = formatSecondsToDisplay(entry.timestampSec, 0);

                const timestampUrl = ytId
                    ? `https://youtu.be/${ytId}?t=${Math.floor(entry.timestampSec)}`
                    : video.url;

                lines.push(`[${timeStr}](${timestampUrl}) ${entry.text}`);
            }
            lines.push('');
        }

        lines.push(''); // Extra spacing between videos
    }

    return lines.join('\n').trim() + '\n';
}

/**
 * Export all videos and notes to markdown format.
 */
export function exportToMarkdown(videos: Video[], notes: Note[], options?: ExportOptions): string {
    return generateExportContent(videos, notes, options);
}

/**
 * Export a single video and its notes to markdown format.
 */
export function exportSingleVideoToMarkdown(video: Video, notes: Note[], options?: ExportOptions): string {
    return generateExportContent([video], notes, options);
}
