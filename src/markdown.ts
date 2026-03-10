import { Video, Note, VideoId, NoteId } from './types';
import {
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
        videoNotes.sort((a, b) => a.timestampSec - b.timestampSec);
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

        // Match Video: [Title](URL) - must not be a timestamp link
        const videoMatch = line.match(/^\[(.*?)\]\((.+)\)$/);
        if (videoMatch && videoMatch[2] !== 'timestamp') {
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
            const timeStr = formatSecondsToDisplay(note.timestampSec, 0);
            lines.push(`[${timeStr}](timestamp)`);
            lines.push(note.bodyMarkdown);
            lines.push('');
        }
        
        lines.push(''); // Extra spacing between videos
    }

    return lines.join('\n').trim() + '\n';
}

/**
 * Helper function to generate export content for a list of videos and their notes.
 * Creates markdown with YouTube timestamp links.
 */
function generateExportContent(videos: Video[], notes: Note[]): string {
    const lines: string[] = [];
    const notesByVideo = buildSortedNotesByVideo(notes);

    for (const video of videos) {
        // Video title as a link (paragraph, not heading)
        lines.push(`[${video.title || video.url}](${video.url})`);
        lines.push('');

        const videoNotes = notesByVideo.get(video.id) || [];
        const ytId = extractYouTubeId(video.url);

        for (const note of videoNotes) {
            const timeStr = formatSecondsToDisplay(note.timestampSec, 0);
            
            // Create YouTube timestamp link
            const timestampUrl = ytId 
                ? `https://youtu.be/${ytId}?t=${Math.floor(note.timestampSec)}`
                : video.url;
            
            lines.push(`[${timeStr}](${timestampUrl})`);
            lines.push(note.bodyMarkdown);
            lines.push('');
        }
        
        lines.push(''); // Extra spacing between videos
    }

    return lines.join('\n').trim() + '\n';
}

/**
 * Export all videos and notes to markdown format.
 */
export function exportToMarkdown(videos: Video[], notes: Note[]): string {
    return generateExportContent(videos, notes);
}

/**
 * Export a single video and its notes to markdown format.
 */
export function exportSingleVideoToMarkdown(video: Video, notes: Note[]): string {
    return generateExportContent([video], notes);
}
