import type { Note, TranscriptEntry, Video } from '../types';
import { detectYoutnoteFormat } from './detect';
import { extractFrontmatter, withFormatVersion } from './frontmatter';
import {
    CURRENT_FORMAT_VERSION,
    LEGACY_FORMAT_VERSION,
    MigrationResult,
    ParseYoutnoteResult,
    YoutnoteDocument,
} from './types';
import { parseLegacyYoutnote, readLegacyDocument } from './v1';
import { alignVideoLayouts, parseV2Youtnote, serializeV2Youtnote } from './v2';

export { detectYoutnoteFormat } from './detect';
export { withFormatVersion } from './frontmatter';
export { parseLegacyYoutnote, buildDefaultLayout } from './v1';
export { alignVideoLayouts, serializeV2Youtnote, parseV2Youtnote } from './v2';
export { exportToMarkdown, exportSingleVideoToMarkdown } from './export';
export * from './types';

export function parseYoutnoteDocument(source: string): ParseYoutnoteResult {
    const detection = detectYoutnoteFormat(source);
    switch (detection.kind) {
        case 'unsupported-version':
            return { ok: false, reason: 'unsupported-version', version: detection.version, maxSupported: detection.maxSupported };
        case 'malformed-version':
            return { ok: false, reason: 'malformed-version', rawValue: detection.rawValue };
        case 'legacy': {
            const result = readLegacyDocument(source);
            if (!result.ok) {
                return { ok: false, reason: 'invalid-document', message: result.message };
            }
            return { ok: true, document: result.document };
        }
        case 'supported': {
            const result = parseV2Youtnote(source);
            if (!result.ok) {
                return { ok: false, reason: 'invalid-document', message: result.message };
            }
            return { ok: true, document: result.document };
        }
    }
}

export function serializeYoutnoteDocument(document: YoutnoteDocument): string {
    return serializeV2Youtnote(document);
}

export function updateYoutnoteDocument(document: YoutnoteDocument, videos: Video[], notes: Note[]): YoutnoteDocument {
    return {
        ...document,
        videos,
        notes,
        videoLayouts: alignVideoLayouts(videos, document.videoLayouts),
    };
}

function transcriptsEqual(a: TranscriptEntry[] | undefined, b: TranscriptEntry[] | undefined): boolean {
    const left = a ?? [];
    const right = b ?? [];
    if (left.length !== right.length) return false;
    return left.every((entry, i) =>
        entry.startMs === right[i].startMs &&
        entry.durationMs === right[i].durationMs &&
        entry.text === right[i].text
    );
}

export function youtnoteDocumentsEquivalent(a: YoutnoteDocument, b: YoutnoteDocument): boolean {
    if (a.videos.length !== b.videos.length || a.notes.length !== b.notes.length) {
        return false;
    }
    const videoIndexById = new Map(b.videos.map((video, index) => [video.id, index]));
    for (let i = 0; i < a.videos.length; i++) {
        const va = a.videos[i];
        const vb = b.videos[i];
        if (va.url !== vb.url || (va.title ?? '') !== (vb.title ?? '')) {
            return false;
        }
        if (!transcriptsEqual(va.transcript, vb.transcript)) {
            return false;
        }
    }
    const sortedNotes = (doc: YoutnoteDocument, map?: Map<string, number>) =>
        [...doc.notes].map(note => ({
            videoIndex: map ? map.get(note.videoId) : doc.videos.findIndex(v => v.id === note.videoId),
            timestampSec: note.timestampSec,
            bodyMarkdown: note.bodyMarkdown,
            isGeneral: note.isGeneral === true || note.timestampSec === -1,
        })).sort((x, y) =>
            (x.videoIndex ?? -1) - (y.videoIndex ?? -1) ||
            x.timestampSec - y.timestampSec ||
            x.bodyMarkdown.localeCompare(y.bodyMarkdown)
        );
    const na = sortedNotes(a);
    const nb = sortedNotes(b, videoIndexById);
    return na.every((note, i) =>
        note.videoIndex === nb[i].videoIndex &&
        note.timestampSec === nb[i].timestampSec &&
        note.bodyMarkdown === nb[i].bodyMarkdown &&
        note.isGeneral === nb[i].isGeneral
    );
}

export function migrateLegacyYoutnote(source: string): MigrationResult {
    const parsed = parseYoutnoteDocument(source);
    if (parsed.ok) {
        if (parsed.document.sourceFormatVersion !== LEGACY_FORMAT_VERSION) {
            return { ok: true, document: parsed.document, markdown: serializeV2Youtnote(parsed.document), migration: 'none' };
        }

        const markdown = serializeV2Youtnote(parsed.document);
        const reparsed = parseV2Youtnote(markdown);
        if (!reparsed.ok) {
            return { ok: false, reason: 'invalid-document', message: `Generated v2 output failed validation: ${reparsed.message}` };
        }
        if (!youtnoteDocumentsEquivalent(parsed.document, reparsed.document)) {
            return { ok: false, reason: 'invalid-document', message: 'Generated v2 output is not semantically equivalent to the legacy source.' };
        }
        return { ok: true, document: reparsed.document, markdown, migration: 'legacy-to-current' };
    }

    if (parsed.reason !== 'invalid-document' || detectYoutnoteFormat(source).kind !== 'legacy') {
        return parsed;
    }

    const v2Attempt = parseV2Youtnote(source);
    if (!v2Attempt.ok) {
        return parsed;
    }
    const { raw, body } = extractFrontmatter(source);
    const corrected = `${withFormatVersion({ raw }, CURRENT_FORMAT_VERSION)}${body}`;
    const correctedParsed = parseYoutnoteDocument(corrected);
    if (!correctedParsed.ok || correctedParsed.document.sourceFormatVersion !== CURRENT_FORMAT_VERSION) {
        return parsed;
    }
    return { ok: true, document: correctedParsed.document, markdown: corrected, migration: 'corrected-declaration' };
}

export function createEmptyYoutnoteMarkdown(): string {
    const { raw } = extractFrontmatter('');
    return `${withFormatVersion({ raw }, CURRENT_FORMAT_VERSION)}\n\n`;
}

export function parseYoutnoteArrays(source: string): { videos: Video[]; notes: Note[] } {
    const detection = detectYoutnoteFormat(source);
    if (detection.kind === 'supported') {
        const result = parseV2Youtnote(source);
        if (result.ok) {
            return { videos: result.document.videos, notes: result.document.notes };
        }
        return { videos: [], notes: [] };
    }
    if (detection.kind !== 'legacy') {
        return { videos: [], notes: [] };
    }
    const { videos, notes } = parseLegacyYoutnote(source);
    return { videos, notes };
}
