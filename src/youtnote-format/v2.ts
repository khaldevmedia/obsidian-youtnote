import { Note, NoteId, TranscriptEntry, Video, VideoId } from '../types';
import { formatCaptionFileTimestamp, parseCaptionFileTimestamp } from '../transcript';
import { extractYouTubeId, formatSecondsToDisplay, parseTimestampInput } from '../utils';
import { extractFrontmatter, withFormatVersion } from './frontmatter';
import {
    CURRENT_FORMAT_VERSION,
    OpaqueYoutnoteSection,
    PreservedFrontmatter,
    YoutnoteDocument,
    YoutnoteSectionSlot,
    YoutnoteVideoLayout,
} from './types';
import { buildDefaultLayout, buildSortedNotesByVideo } from './v1';

export const VIDEO_START_MARKER = '<!-- youtnote:video:start -->';
export const VIDEO_END_MARKER = '<!-- youtnote:video:end -->';

const SECTION_OPEN_PATTERN = /^<!--\s*youtnote:section:([A-Za-z0-9_-]+):start(\s[^]*)?-->$/;
const MANAGED_SECTION_TYPES = new Set(['source', 'notes', 'transcript']);

function sectionOpenMarker(type: string): string {
    return `<!-- youtnote:section:${type}:start -->`;
}

function sectionEndMarker(type: string): string {
    return `<!-- youtnote:section:${type}:end -->`;
}

function invalid(message: string): { ok: false; message: string } {
    return { ok: false, message };
}

type LineResult = { ok: true } | { ok: false; message: string };

const OK: LineResult = { ok: true };

class FenceTracker {
    private fenceChar: string | null = null;
    private fenceLength = 0;

    get inFence(): boolean {
        return this.fenceChar !== null;
    }

    feed(line: string): boolean {
        const match = line.match(/^\s*(`{3,}|~{3,})/);
        if (this.fenceChar === null) {
            if (match) {
                this.fenceChar = match[1][0];
                this.fenceLength = match[1].length;
            }
            return false;
        }
        if (match && match[1][0] === this.fenceChar && match[1].length >= this.fenceLength) {
            this.fenceChar = null;
            this.fenceLength = 0;
        }
        return true;
    }
}

class NotesSectionParser {
    private notes: Note[] = [];
    private currentNote: Partial<Note> | null = null;

    constructor(private video: Video) {}

    feed(line: string): LineResult {
        const timeMatch = line.match(/^\[([\d:]+)\]\(timestamp\)\s*$/);
        if (timeMatch) {
            const result = parseTimestampInput(timeMatch[1], 0);
            if (result.error) {
                return invalid(`Invalid timestamp marker in a notes section: "${line.trim()}".`);
            }
            this.commit();
            this.currentNote = {
                id: crypto.randomUUID() as NoteId,
                videoId: this.video.id,
                timestampSec: result.seconds,
                bodyMarkdown: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            return OK;
        }

        if (line === '[general-note](general-note)') {
            this.commit();
            this.currentNote = {
                id: crypto.randomUUID() as NoteId,
                videoId: this.video.id,
                timestampSec: -1,
                bodyMarkdown: '',
                isGeneral: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            return OK;
        }

        if (line.trim() === '') {
            if (this.currentNote) {
                this.currentNote.bodyMarkdown += (this.currentNote.bodyMarkdown ? '\n' : '') + line;
            }
            return OK;
        }

        if (!this.currentNote) {
            return invalid(`Unexpected content inside a notes section: "${line.trim()}".`);
        }
        this.currentNote.bodyMarkdown += (this.currentNote.bodyMarkdown ? '\n' : '') + line;
        return OK;
    }

    feedRaw(line: string): LineResult {
        if (!this.currentNote) {
            if (line.trim() === '') {
                return OK;
            }
            return invalid(`Unexpected content inside a notes section: "${line.trim()}".`);
        }
        this.currentNote.bodyMarkdown += (this.currentNote.bodyMarkdown ? '\n' : '') + line;
        return OK;
    }

    finish(): Note[] {
        this.commit();
        return this.notes;
    }

    private commit(): void {
        if (this.currentNote && this.currentNote.videoId && this.currentNote.timestampSec !== undefined && this.currentNote.bodyMarkdown !== undefined) {
            this.currentNote.bodyMarkdown = this.currentNote.bodyMarkdown.trim();
            this.notes.push(this.currentNote as Note);
        }
        this.currentNote = null;
    }
}

function parseTranscriptLine(line: string, video: Video): LineResult {
    const captionMatch = line.match(/^\[([\d:.]+)\]\(caption(?:\?durationMs=(\d+))?\) ?(.*)$/);
    if (!captionMatch) {
        return invalid(`Unexpected content inside a transcript section: "${line.trim()}".`);
    }
    const startMs = parseCaptionFileTimestamp(captionMatch[1]);
    if (startMs === null) {
        return invalid(`Invalid caption timestamp in a transcript section: "${line.trim()}".`);
    }
    const entry: TranscriptEntry = { startMs, text: captionMatch[3] };
    if (captionMatch[2] !== undefined) {
        const durationMs = Number(captionMatch[2]);
        if (Number.isFinite(durationMs) && durationMs > 0) {
            entry.durationMs = durationMs;
        }
    }
    if (!video.transcript) {
        video.transcript = [];
    }
    video.transcript.push(entry);
    return OK;
}

type ParseResult = { ok: true; document: YoutnoteDocument } | { ok: false; message: string };

export function parseV2Youtnote(source: string): ParseResult {
    const { raw, body } = extractFrontmatter(source);
    const frontmatter: PreservedFrontmatter = { raw };

    const videos: Video[] = [];
    const notes: Note[] = [];
    const videoLayouts: YoutnoteVideoLayout[] = [];

    const lines = body.split('\n');
    const fence = new FenceTracker();

    let state: 'top' | 'video' | 'section' = 'top';
    let currentVideo: Video | null = null;
    let currentSections: YoutnoteSectionSlot[] = [];
    let managedSeen = new Set<string>();
    let sectionType = '';
    let sectionOpening = '';
    let sectionOpaqueLines: string[] = [];
    let sourceLines: string[] = [];
    let notesParser: NotesSectionParser | null = null;

    const fail = (message: string): ParseResult => invalid(message);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (state === 'section' && sectionOpaque(sectionType)) {
            const wasFenced = fence.inFence;
            fence.feed(line);
            if (!wasFenced && !fence.inFence && line === sectionEndMarker(sectionType)) {
                currentSections.push({
                    kind: 'opaque',
                    type: sectionType,
                    openingMarker: sectionOpening,
                    body: sectionOpaqueLines.join('\n'),
                    closingMarker: line,
                });
                state = 'video';
            } else {
                sectionOpaqueLines.push(line);
            }
            continue;
        }

        const fencedContent = fence.inFence;

        if (!fencedContent && state !== 'section') {
            if (line === VIDEO_START_MARKER) {
                if (state !== 'top') {
                    return fail('Unexpected nested youtnote video start marker.');
                }
                currentVideo = null;
                currentSections = [];
                managedSeen = new Set();
                state = 'video';
                fence.feed(line);
                continue;
            }
            if (line === VIDEO_END_MARKER) {
                if (state !== 'video') {
                    return fail('Unexpected youtnote video end marker.');
                }
                if (!currentVideo) {
                    return fail(`Video block is missing the required "${sectionOpenMarker('source')}" section.`);
                }
                finishVideo();
                state = 'top';
                fence.feed(line);
                continue;
            }
            const sectionMatch = line.match(SECTION_OPEN_PATTERN);
            if (sectionMatch) {
                if (state !== 'video') {
                    return fail(`Section marker "${line.trim()}" is not inside a video block.`);
                }
                const type = sectionMatch[1];
                if (MANAGED_SECTION_TYPES.has(type)) {
                    if (line !== sectionOpenMarker(type)) {
                        return fail(`The "${type}" section does not accept attributes.`);
                    }
                    if (managedSeen.has(type)) {
                        return fail(`Duplicate "${type}" section in a single video.`);
                    }
                }
                if (type === 'source') {
                    if (currentVideo !== null || currentSections.length > 0) {
                        return fail('The "source" section must be the first section of a video block.');
                    }
                } else if (currentVideo === null) {
                    return fail(`A "${type}" section requires a "${sectionOpenMarker('source')}" section first.`);
                }
                managedSeen.add(type);
                sectionType = type;
                sectionOpening = line;
                sectionOpaqueLines = [];
                sourceLines = [];
                notesParser = type === 'notes' ? new NotesSectionParser(currentVideo!) : null;
                state = 'section';
                fence.feed(line);
                continue;
            }
            const sectionEndMatch = line.match(/^<!--\s*youtnote:section:([A-Za-z0-9_-]+):end\s*-->$/);
            if (sectionEndMatch) {
                return fail(`Section end marker "${line.trim()}" without a matching start.`);
            }
        }

        fence.feed(line);

        switch (state) {
            case 'top': {
                if (line.trim() !== '') {
                    return fail(`Unexpected content outside a video block: "${line.trim()}".`);
                }
                break;
            }
            case 'video': {
                if (line.trim() !== '') {
                    return fail(`Unexpected content inside a video block: "${line.trim()}".`);
                }
                break;
            }
            case 'section': {
                if (!fencedContent && line === sectionEndMarker(sectionType)) {
                    const closed = closeManagedSection();
                    if (!closed.ok) {
                        return fail(closed.message);
                    }
                    break;
                }
                if (!fencedContent && line.trim().startsWith('<!--') && /youtnote:(video|section):/.test(line)) {
                    return fail(`Unexpected youtnote marker inside a "${sectionType}" section: "${line.trim()}".`);
                }
                let result: LineResult = OK;
                if (sectionType === 'source') {
                    if (line.trim() !== '') {
                        if (sourceLines.length > 0) {
                            return fail('The "source" section must contain exactly one video link line.');
                        }
                        sourceLines.push(line.trim());
                    }
                } else if (sectionType === 'notes') {
                    result = fencedContent ? notesParser!.feedRaw(line) : notesParser!.feed(line);
                } else if (sectionType === 'transcript') {
                    result = line.trim() === '' ? OK : parseTranscriptLine(line, currentVideo!);
                }
                if (!result.ok) {
                    return fail(result.message);
                }
                break;
            }
        }
    }

    if (state === 'section') {
        return fail(`Missing "${sectionEndMarker(sectionType)}" before end of file.`);
    }
    if (state === 'video') {
        return fail(`Missing "${VIDEO_END_MARKER}" before end of file.`);
    }

    for (const video of videos) {
        video.transcript?.sort((a, b) => a.startMs - b.startMs);
    }

    return {
        ok: true,
        document: {
            sourceFormatVersion: CURRENT_FORMAT_VERSION,
            frontmatter,
            videos,
            notes,
            videoLayouts,
        },
    };

    function sectionOpaque(type: string): boolean {
        return !MANAGED_SECTION_TYPES.has(type);
    }

    function closeManagedSection(): LineResult {
        if (sectionType === 'source') {
            if (sourceLines.length !== 1) {
                return invalid('The "source" section must contain exactly one video link line.');
            }
            const videoMatch = sourceLines[0].match(/^\[(.*?)\]\((.+)\)$/);
            const ytId = videoMatch ? extractYouTubeId(videoMatch[2]) : null;
            if (!videoMatch || !ytId) {
                return invalid(`The "source" section requires a YouTube video link, found "${sourceLines[0]}".`);
            }
            currentVideo = {
                id: crypto.randomUUID() as VideoId,
                title: videoMatch[1],
                url: videoMatch[2],
                durationSec: 0,
                thumbnail: `https://img.youtube.com/vi/${ytId}/default.jpg`,
            };
            videos.push(currentVideo);
        } else if (sectionType === 'notes' && notesParser) {
            notes.push(...notesParser.finish());
            notesParser = null;
        }
        currentSections.push({ kind: sectionType } as YoutnoteSectionSlot);
        state = 'video';
        return OK;
    }

    function finishVideo(): void {
        if (!currentVideo) {
            return;
        }
        videoLayouts.push({ videoId: currentVideo.id, sections: currentSections });
        currentVideo = null;
        currentSections = [];
    }
}

export function serializeV2Youtnote(document: YoutnoteDocument): string {
    if (document.videos.length === 0) {
        return `${withFormatVersion(document.frontmatter, CURRENT_FORMAT_VERSION)}\n\n`;
    }

    const lines: string[] = [];
    const notesByVideo = buildSortedNotesByVideo(document.notes);
    const layoutsByVideo = new Map(document.videoLayouts.map(layout => [layout.videoId, layout]));

    lines.push(withFormatVersion(document.frontmatter, CURRENT_FORMAT_VERSION));
    lines.push('');

    for (const video of document.videos) {
        const layout = layoutsByVideo.get(video.id);
        const recordedSections = layout ? layout.sections : buildDefaultLayout(video);
        const nonSourceSections = recordedSections.filter(slot => slot.kind !== 'source');
        const sectionsWithNotes = nonSourceSections.some(slot => slot.kind === 'notes')
            ? nonSourceSections
            : [{ kind: 'notes' } as YoutnoteSectionSlot, ...nonSourceSections];
        const sections: YoutnoteSectionSlot[] = [{ kind: 'source' }, ...sectionsWithNotes];

        lines.push(VIDEO_START_MARKER);
        lines.push('');

        let transcriptWritten = false;
        const emitTranscript = () => {
            if (!video.transcript || video.transcript.length === 0) {
                return;
            }
            transcriptWritten = true;
            lines.push(sectionOpenMarker('transcript'));
            lines.push('');
            const sorted = [...video.transcript].sort((a, b) => a.startMs - b.startMs);
            for (const entry of sorted) {
                const durationQuery = entry.durationMs === undefined ? '' : `?durationMs=${entry.durationMs}`;
                lines.push(`[${formatCaptionFileTimestamp(entry.startMs)}](caption${durationQuery}) ${entry.text}`);
            }
            lines.push('');
            lines.push(sectionEndMarker('transcript'));
            lines.push('');
        };

        for (const slot of sections) {
            if (slot.kind === 'source') {
                lines.push(sectionOpenMarker('source'));
                lines.push(`[${video.title || video.url}](${video.url})`);
                lines.push(sectionEndMarker('source'));
                lines.push('');
            } else if (slot.kind === 'notes') {
                lines.push(sectionOpenMarker('notes'));
                lines.push('');
                const videoNotes = notesByVideo.get(video.id) || [];
                for (const note of videoNotes) {
                    if (note.isGeneral === true || note.timestampSec === -1) {
                        lines.push('[general-note](general-note)');
                    } else {
                        lines.push(`[${formatSecondsToDisplay(note.timestampSec, 0)}](timestamp)`);
                    }
                    if (note.bodyMarkdown) {
                        lines.push(note.bodyMarkdown);
                    }
                    lines.push('');
                }
                lines.push(sectionEndMarker('notes'));
                lines.push('');
            } else if (slot.kind === 'transcript') {
                emitTranscript();
            } else {
                lines.push(slot.openingMarker);
                if (slot.body !== '') {
                    lines.push(slot.body);
                }
                lines.push(slot.closingMarker);
                lines.push('');
            }
        }

        if (!transcriptWritten && video.transcript && video.transcript.length > 0) {
            emitTranscript();
        }

        lines.push(VIDEO_END_MARKER);
        lines.push('');
    }

    return lines.join('\n').replace(/\n+$/, '\n');
}

export function alignVideoLayouts(
    videos: Video[],
    layouts: YoutnoteVideoLayout[],
): YoutnoteVideoLayout[] {
    const byId = new Map(layouts.map(layout => [layout.videoId, layout]));
    return videos.map(video => {
        const existing = byId.get(video.id);
        if (existing) {
            return existing;
        }
        return { videoId: video.id, sections: buildDefaultLayout(video) };
    });
}

export type { OpaqueYoutnoteSection };
