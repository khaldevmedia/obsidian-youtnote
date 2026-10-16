import { Note, NoteId, TranscriptEntry, Video, VideoId } from '../types';
import { formatCaptionFileTimestamp, parseCaptionFileTimestamp } from '../transcript';
import { extractYouTubeId, formatSecondsToDisplay } from '../utils';
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

export const FILE_START_MARKER = '<!-- youtnote:file:start -->';
export const FILE_END_MARKER = '<!-- youtnote:file:end -->';
export const VIDEO_START_MARKER = '<!-- youtnote:video:start -->';
export const VIDEO_END_MARKER = '<!-- youtnote:video:end -->';
export const GENERAL_NOTE_START_MARKER = '<!-- youtnote:general-note:start -->';
export const GENERAL_NOTE_END_MARKER = '<!-- youtnote:general-note:end -->';
export const TIMESTAMPED_NOTE_START_PREFIX = '<!-- youtnote:timestamped-note:start ';
export const TIMESTAMPED_NOTE_END_MARKER = '<!-- youtnote:timestamped-note:end -->';
export const SOURCE_START_MARKER = '<!-- youtnote:source:start -->';
export const SOURCE_END_MARKER = '<!-- youtnote:source:end -->';
export const TITLE_START_MARKER = '<!-- youtnote:title:start -->';
export const TITLE_END_MARKER = '<!-- youtnote:title:end -->';
export const URL_START_MARKER = '<!-- youtnote:url:start -->';
export const URL_END_MARKER = '<!-- youtnote:url:end -->';
export const NOTES_START_MARKER = '<!-- youtnote:notes:start -->';
export const NOTES_END_MARKER = '<!-- youtnote:notes:end -->';
export const TRANSCRIPT_START_MARKER = '<!-- youtnote:transcript:start -->';
export const TRANSCRIPT_END_MARKER = '<!-- youtnote:transcript:end -->';

export const NOTE_TIMESTAMP_PATTERN = /^`([\d:]+)` <!-- youtnote:timestamp -->\s*$/;

const MARKER_OPEN_PATTERN = /^<!-- youtnote:([A-Za-z0-9_-]+):start(?: ([^\r\n]*\S))? -->$/;
const MARKER_END_PATTERN = /^<!-- youtnote:([A-Za-z0-9_-]+):end -->$/;
const RESERVED_LINE_PATTERN = /^<!--\s*youtnote:/;
const FENCE_LINE_PATTERN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE_PATTERN = /^\s*(`{3,}|~{3,})\s*$/;
const CAPTION_PATTERN = /^<!-- t=(\S+) d=(\d+) --> ([^\r\n]*)$/;
const NOTE_TIME_PATTERN = /^\d+(:[0-5]\d){0,2}$/;

const KNOWN_MARKERS = new Set([
    'file', 'video', 'source', 'title', 'url',
    'notes', 'general-note', 'timestamped-note', 'transcript',
]);

function markerEnd(type: string): string {
    return `<!-- youtnote:${type}:end -->`;
}

export function isReservedMarkerLine(line: string): boolean {
    return RESERVED_LINE_PATTERN.test(line.trimStart());
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
        if (this.fenceChar === null) {
            const open = line.match(FENCE_LINE_PATTERN);
            if (open) {
                this.fenceChar = open[1][0];
                this.fenceLength = open[1].length;
            }
            return false;
        }
        const close = line.match(FENCE_CLOSE_PATTERN);
        if (close && close[1][0] === this.fenceChar && close[1].length >= this.fenceLength) {
            this.fenceChar = null;
            this.fenceLength = 0;
        }
        return true;
    }
}

function encodeContentLines(text: string): string[] {
    const lines = text.split('\n');
    return lines.map(line => {
        if (line.startsWith('\\')
            || FENCE_LINE_PATTERN.test(line)
            || isReservedMarkerLine(line)) {
            return `\\${line}`;
        }
        return line;
    });
}

function decodeContentLine(line: string, fence: FenceTracker): string {
    if (line.startsWith('\\')) {
        const rest = line.slice(1);
        if (rest.startsWith('\\')
            || isReservedMarkerLine(rest)
            || FENCE_LINE_PATTERN.test(rest)) {
            return rest;
        }
        return line;
    }
    fence.feed(line);
    return line;
}

function encodeCaptionText(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

function decodeCaptionText(text: string): string | null {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch !== '\\') {
            result += ch;
            continue;
        }
        const next = text[i + 1];
        if (next === '\\') {
            result += '\\';
        } else if (next === 'r') {
            result += '\r';
        } else if (next === 'n') {
            result += '\n';
        } else {
            return null;
        }
        i++;
    }
    return result;
}

function parseNoteTimestampAttr(value: string): number | null {
    if (!NOTE_TIME_PATTERN.test(value)) {
        return null;
    }
    const parts = value.split(':').map(Number);
    const seconds = parts.length === 1
        ? parts[0]
        : parts.length === 2
            ? parts[0] * 60 + parts[1]
            : parts[0] * 3600 + parts[1] * 60 + parts[2];
    return Number.isSafeInteger(seconds) ? seconds : null;
}

type ParseResult = { ok: true; document: YoutnoteDocument } | { ok: false; message: string };

export function parseV2Youtnote(source: string): ParseResult {
    const { raw, body } = extractFrontmatter(source);
    const frontmatter: PreservedFrontmatter = { raw };

    const videos: Video[] = [];
    const notes: Note[] = [];
    const videoLayouts: YoutnoteVideoLayout[] = [];
    const fileSections: OpaqueYoutnoteSection[] = [];

    const lines = body.split('\n');
    let index = 0;

    const fail = (message: string): ParseResult => invalid(message);

    const isBlank = (line: string) => line.trim() === '';

    const expectExact = (line: string | undefined, marker: string, context: string): LineResult => {
        if (line !== marker) {
            return invalid(`Expected "${marker}" inside ${context}, found "${(line ?? '').trim()}".`);
        }
        return OK;
    };

    const readContentBody = (
        endMarker: string,
        context: string,
    ): { ok: true; lines: string[] } | { ok: false; message: string } => {
        const collected: string[] = [];
        const fence = new FenceTracker();
        while (index < lines.length) {
            const line = lines[index];
            if (!line.startsWith('\\') && !fence.inFence && isReservedMarkerLine(line)) {
                if (line === endMarker) {
                    index++;
                    return { ok: true, lines: collected };
                }
                return invalid(`Unexpected marker inside ${context}: "${line.trim()}".`);
            }
            collected.push(decodeContentLine(line, fence));
            index++;
        }
        return invalid(`Missing "${endMarker}" before end of file inside ${context}.`);
    };

    const readOpaqueSection = (
        scope: 'file' | 'video',
        opening: string,
        type: string,
    ): { ok: true; section: OpaqueYoutnoteSection } | { ok: false; message: string } => {
        const bodyLines: string[] = [];
        const fence = new FenceTracker();
        const openPat = new RegExp(`^<!-- youtnote:${type}:start(?: [^\r\n]*\\S)? -->$`);
        const endPat = markerEnd(type);
        let depth = 1;
        while (index < lines.length) {
            const line = lines[index];
            const fenced = fence.inFence;
            fence.feed(line);
            if (!fenced && !fence.inFence && line === endPat) {
                depth--;
                if (depth === 0) {
                    index++;
                    return {
                        ok: true,
                        section: {
                            kind: 'opaque',
                            type,
                            openingMarker: opening,
                            body: bodyLines.join('\n'),
                            hasBody: bodyLines.length > 0,
                            closingMarker: line,
                        },
                    };
                }
                bodyLines.push(line);
                index++;
                continue;
            }
            if (!fenced && !fence.inFence && openPat.test(line)) {
                depth++;
            }
            bodyLines.push(line);
            index++;
        }
        return invalid(`Missing "${endPat}" before end of file inside ${scope === 'file' ? 'the file' : 'a video'} block.`);
    };

    const readNotesContainer = (video: Video): LineResult => {
        while (index < lines.length) {
            const line = lines[index];
            if (isBlank(line)) {
                index++;
                continue;
            }
            if (line === NOTES_END_MARKER) {
                index++;
                return OK;
            }
            const openMatch = line.match(MARKER_OPEN_PATTERN);
            if (line === GENERAL_NOTE_START_MARKER
                || (openMatch && openMatch[1] === 'timestamped-note' && /^t=\S+$/.test(openMatch[2] ?? ''))) {
                const isGeneral = line === GENERAL_NOTE_START_MARKER;
                const timestampSec = isGeneral ? -1 : parseNoteTimestampAttr(openMatch![2].slice(2));
                if (!isGeneral && timestampSec === null) {
                    return invalid(`Invalid timestamped-note timestamp in a notes section: "${line.trim()}".`);
                }
                const endMarker = isGeneral ? GENERAL_NOTE_END_MARKER : TIMESTAMPED_NOTE_END_MARKER;
                index++;
                const bodyResult = readContentBody(endMarker, 'a note record');
                if (!bodyResult.ok) {
                    return invalid(bodyResult.message);
                }
                notes.push({
                    id: crypto.randomUUID() as NoteId,
                    videoId: video.id,
                    timestampSec: timestampSec ?? -1,
                    bodyMarkdown: bodyResult.lines.join('\n'),
                    ...(isGeneral ? { isGeneral: true } : {}),
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
                continue;
            }
            if (isReservedMarkerLine(line)) {
                return invalid(`Unexpected marker inside a notes section: "${line.trim()}".`);
            }
            return invalid(`Unexpected content inside a notes section: "${line.trim()}".`);
        }
        return invalid(`Missing "${NOTES_END_MARKER}" before end of file.`);
    };

    const readTranscriptContainer = (video: Video): LineResult => {
        while (index < lines.length) {
            const line = lines[index];
            if (isBlank(line)) {
                index++;
                continue;
            }
            if (line === TRANSCRIPT_END_MARKER) {
                index++;
                return OK;
            }
            const captionMatch = line.match(CAPTION_PATTERN);
            if (!captionMatch) {
                return invalid(`Unexpected content inside a transcript section: "${line.trim()}".`);
            }
            const startMs = parseCaptionFileTimestamp(captionMatch[1]);
            if (startMs === null || !Number.isSafeInteger(startMs)) {
                return invalid(`Invalid caption timestamp in a transcript section: "${line.trim()}".`);
            }
            const durationValue = Number(captionMatch[2]);
            if (!Number.isSafeInteger(durationValue)) {
                return invalid(`Invalid caption duration in a transcript section: "${line.trim()}".`);
            }
            const text = decodeCaptionText(captionMatch[3]);
            if (text === null) {
                return invalid(`Malformed escape sequence in a transcript caption: "${line.trim()}".`);
            }
            const entry: TranscriptEntry = { startMs, text };
            if (durationValue > 0) {
                entry.durationMs = durationValue;
            }
            if (!video.transcript) {
                video.transcript = [];
            }
            video.transcript.push(entry);
            index++;
        }
        return invalid(`Missing "${TRANSCRIPT_END_MARKER}" before end of file.`);
    };

    const readSourceContainer = (): { ok: true; video: Video } | { ok: false; message: string } => {
        while (index < lines.length && isBlank(lines[index])) index++;
        const openTitle = expectExact(lines[index], TITLE_START_MARKER, 'a source section');
        if (!openTitle.ok) return openTitle;
        index++;
        const titleResult = readContentBody(TITLE_END_MARKER, 'a title field');
        if (!titleResult.ok) return titleResult;
        const title = titleResult.lines.join('\n');

        while (index < lines.length && isBlank(lines[index])) index++;
        const openUrl = expectExact(lines[index], URL_START_MARKER, 'a source section');
        if (!openUrl.ok) return openUrl;
        index++;
        const urlLines: string[] = [];
        let urlClosed = false;
        while (index < lines.length) {
            const line = lines[index];
            if (line === URL_END_MARKER) {
                index++;
                urlClosed = true;
                break;
            }
            if (isReservedMarkerLine(line)) {
                return invalid(`Unexpected marker inside a url field: "${line.trim()}".`);
            }
            urlLines.push(line);
            index++;
        }
        if (!urlClosed) {
            return invalid(`Missing "${URL_END_MARKER}" before end of file inside a source section.`);
        }
        if (urlLines.length !== 1 || urlLines[0].trim() === '') {
            return invalid('The "url" field must contain exactly one non-empty line.');
        }
        const url = urlLines[0];
        if (/[\r\n]/.test(url)) {
            return invalid('The "url" field must not contain a line break.');
        }
        const ytId = extractYouTubeId(url);
        if (!ytId) {
            return invalid(`The "url" field requires a supported YouTube URL, found "${url.trim()}".`);
        }
        while (index < lines.length && isBlank(lines[index])) index++;
        const close = expectExact(lines[index], SOURCE_END_MARKER, 'a source section');
        if (!close.ok) return close;
        index++;
        return {
            ok: true,
            video: {
                id: crypto.randomUUID() as VideoId,
                title,
                url,
                durationSec: 0,
                thumbnail: `https://img.youtube.com/vi/${ytId}/default.jpg`,
            },
        };
    };

    const readVideo = (): LineResult => {
        let currentVideo: Video | null = null;
        let currentSections: YoutnoteSectionSlot[] = [];
        let notesSeen = false;
        let transcriptSeen = false;

        while (index < lines.length) {
            const line = lines[index];
            if (isBlank(line)) {
                index++;
                continue;
            }
            if (line === VIDEO_END_MARKER) {
                index++;
                if (!currentVideo) {
                    return fail(`Video block is missing the required "${SOURCE_START_MARKER}" section.`);
                }
                if (!notesSeen) {
                    return fail(`Video block is missing the required "${NOTES_START_MARKER}" section.`);
                }
                videoLayouts.push({ videoId: currentVideo.id, sections: currentSections });
                return OK;
            }
            const openMatch = line.match(MARKER_OPEN_PATTERN);
            if (openMatch) {
                const type = openMatch[1];
                const attrs = openMatch[2];
                if (type === 'file' || type === 'video') {
                    return fail(`Unexpected nested "${line.trim()}" marker.`);
                }
                if (type === 'general-note' || type === 'timestamped-note' || type === 'title' || type === 'url') {
                    return fail(`The "${type}" marker is only valid inside its parent section: "${line.trim()}".`);
                }
                if (type === 'source') {
                    if (attrs !== undefined) {
                        return fail('The "source" section does not accept attributes.');
                    }
                    if (currentVideo !== null || currentSections.length > 0) {
                        return fail('The "source" section must be the first section of a video block.');
                    }
                    index++;
                    const result = readSourceContainer();
                    if (!result.ok) {
                        return fail(result.message);
                    }
                    currentVideo = result.video;
                    videos.push(currentVideo);
                    currentSections.push({ kind: 'source' });
                    continue;
                }
                if (type === 'notes' || type === 'transcript') {
                    if (attrs !== undefined) {
                        return fail(`The "${type}" section does not accept attributes.`);
                    }
                    if (currentVideo === null) {
                        return fail(`A "${type}" section requires a "${SOURCE_START_MARKER}" section first.`);
                    }
                    if (type === 'notes') {
                        if (notesSeen) {
                            return fail('Duplicate "notes" section in a single video.');
                        }
                        notesSeen = true;
                        index++;
                        const result = readNotesContainer(currentVideo);
                        if (!result.ok) {
                            return fail(result.message);
                        }
                        currentSections.push({ kind: 'notes' });
                        continue;
                    }
                    if (transcriptSeen) {
                        return fail('Duplicate "transcript" section in a single video.');
                    }
                    transcriptSeen = true;
                    index++;
                    const result = readTranscriptContainer(currentVideo);
                    if (!result.ok) {
                        return fail(result.message);
                    }
                    currentSections.push({ kind: 'transcript' });
                    continue;
                }
                index++;
                const result = readOpaqueSection('video', line, type);
                if (!result.ok) {
                    return fail(result.message);
                }
                currentSections.push(result.section);
                continue;
            }
            if (MARKER_END_PATTERN.test(line)) {
                return fail(`Marker "${line.trim()}" without a matching start.`);
            }
            if (isReservedMarkerLine(line)) {
                return fail(`Unexpected youtnote marker inside a video block: "${line.trim()}".`);
            }
            return fail(`Unexpected content inside a video block: "${line.trim()}".`);
        }
        return fail(`Missing "${VIDEO_END_MARKER}" before end of file.`);
    };

    while (index < lines.length && isBlank(lines[index])) index++;
    if (lines[index] !== FILE_START_MARKER) {
        return fail(`Missing "${FILE_START_MARKER}" wrapper.`);
    }
    index++;

    let fileClosed = false;
    while (index < lines.length) {
        const line = lines[index];
        if (isBlank(line)) {
            index++;
            continue;
        }
        if (line === FILE_END_MARKER) {
            index++;
            fileClosed = true;
            break;
        }
        if (line === VIDEO_START_MARKER) {
            index++;
            const result = readVideo();
            if (!result.ok) {
                return result;
            }
            continue;
        }
        const openMatch = line.match(MARKER_OPEN_PATTERN);
        if (openMatch) {
            const type = openMatch[1];
            if (KNOWN_MARKERS.has(type)) {
                return fail(`The "${type}" marker is not valid at file scope: "${line.trim()}".`);
            }

            index++;
            const result = readOpaqueSection('file', line, type);
            if (!result.ok) {
                return result;
            }
            fileSections.push(result.section);
            continue;
        }
        if (MARKER_END_PATTERN.test(line)) {
            return fail(`Marker "${line.trim()}" without a matching start.`);
        }
        if (isReservedMarkerLine(line)) {
            return fail(`Unexpected youtnote marker at file scope: "${line.trim()}".`);
        }
        return fail(`Unexpected content inside the file wrapper: "${line.trim()}".`);
    }
    if (!fileClosed) {
        return fail(`Missing "${FILE_END_MARKER}" before end of file.`);
    }
    while (index < lines.length) {
        if (!isBlank(lines[index])) {
            return fail(`Unexpected content after "${FILE_END_MARKER}": "${lines[index].trim()}".`);
        }
        index++;
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
            fileSections,
        },
    };
}

function emitOpaqueSection(lines: string[], section: OpaqueYoutnoteSection): void {
    lines.push(section.openingMarker);
    if (section.hasBody) {
        lines.push(section.body);
    }
    lines.push(section.closingMarker);
    lines.push('');
}

export function serializeV2Youtnote(document: YoutnoteDocument): string {
    const lines: string[] = [];
    const notesByVideo = buildSortedNotesByVideo(document.notes);
    const layoutsByVideo = new Map(document.videoLayouts.map(layout => [layout.videoId, layout]));

    lines.push(withFormatVersion(document.frontmatter, CURRENT_FORMAT_VERSION));
    lines.push('');
    lines.push(FILE_START_MARKER);
    lines.push('');

    for (const section of document.fileSections) {
        emitOpaqueSection(lines, section);
    }

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
            lines.push(TRANSCRIPT_START_MARKER);
            const sorted = [...video.transcript].sort((a, b) => a.startMs - b.startMs);
            for (const entry of sorted) {
                if (!Number.isSafeInteger(entry.startMs) || entry.startMs < 0) {
                    throw new Error(`Cannot serialize a caption with an invalid timestamp: ${entry.startMs}`);
                }
                const durationMs = entry.durationMs !== undefined && Number.isFinite(entry.durationMs) && entry.durationMs > 0
                    ? Math.round(entry.durationMs)
                    : 0;
                if (!Number.isSafeInteger(durationMs)) {
                    throw new Error(`Cannot serialize a caption with an invalid duration: ${entry.durationMs}`);
                }
                lines.push(`<!-- t=${formatCaptionFileTimestamp(entry.startMs)} d=${durationMs} --> ${encodeCaptionText(entry.text)}`);
            }
            lines.push(TRANSCRIPT_END_MARKER);
            lines.push('');
        };

        for (const slot of sections) {
            if (slot.kind === 'source') {
                lines.push(SOURCE_START_MARKER);
                lines.push(TITLE_START_MARKER);
                const titleLines = encodeContentLines(video.title ?? '');
                if (titleLines.length > 0 && !(titleLines.length === 1 && titleLines[0] === '')) {
                    lines.push(...titleLines);
                }
                lines.push(TITLE_END_MARKER);
                lines.push(URL_START_MARKER);
                if (/[\r\n]/.test(video.url) || !extractYouTubeId(video.url)) {
                    throw new Error(`Cannot serialize an unsupported video URL: ${video.url}`);
                }
                lines.push(video.url);
                lines.push(URL_END_MARKER);
                lines.push(SOURCE_END_MARKER);
                lines.push('');
            } else if (slot.kind === 'notes') {
                lines.push(NOTES_START_MARKER);
                lines.push('');
                const videoNotes = notesByVideo.get(video.id) || [];
                const generalNotes = videoNotes.filter(note => note.isGeneral === true || note.timestampSec === -1);
                const timestampedNotes = videoNotes.filter(note => note.isGeneral !== true && note.timestampSec !== -1);
                for (const note of generalNotes) {
                    lines.push(GENERAL_NOTE_START_MARKER);
                    if (note.bodyMarkdown !== '') {
                        lines.push(...encodeContentLines(note.bodyMarkdown));
                    }
                    lines.push(GENERAL_NOTE_END_MARKER);
                    lines.push('');
                }
                for (const note of timestampedNotes) {
                    if (!Number.isSafeInteger(note.timestampSec) || note.timestampSec < 0) {
                        throw new Error(`Cannot serialize a note with an invalid timestamp: ${note.timestampSec}`);
                    }
                    lines.push(`<!-- youtnote:timestamped-note:start t=${formatSecondsToDisplay(note.timestampSec, 0)} -->`);
                    if (note.bodyMarkdown !== '') {
                        lines.push(...encodeContentLines(note.bodyMarkdown));
                    }
                    lines.push(TIMESTAMPED_NOTE_END_MARKER);
                    lines.push('');
                }
                lines.push(NOTES_END_MARKER);
                lines.push('');
            } else if (slot.kind === 'transcript') {
                emitTranscript();
            } else {
                emitOpaqueSection(lines, slot);
            }
        }

        if (!transcriptWritten && video.transcript && video.transcript.length > 0) {
            emitTranscript();
        }

        lines.push(VIDEO_END_MARKER);
        lines.push('');
    }

    lines.push(FILE_END_MARKER);

    return `${lines.join('\n')}\n`;
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
