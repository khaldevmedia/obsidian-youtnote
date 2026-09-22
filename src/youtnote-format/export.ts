import { ExportOptions, Note, Video } from '../types';
import { extractYouTubeId, formatSecondsToDisplay } from '../utils';
import { buildSortedNotesByVideo } from './v1';

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
                const timeStr = formatSecondsToDisplay(entry.startMs / 1000, 0);

                const timestampUrl = ytId
                    ? `https://youtu.be/${ytId}?t=${Math.floor(entry.startMs / 1000)}`
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
