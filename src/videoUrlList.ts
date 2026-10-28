import { extractYouTubeId } from './utils';

export const MAX_VIDEO_URLS = 1000;
export const MAX_VIDEO_URL_TEXT_LENGTH = 200000;

export interface ProvidedVideoUrl {
    key: string;
    youtubeId: string;
    url: string;
    line: number;
}

export type InvalidVideoUrlReason = 'numbering' | 'url' | 'entry';

export interface InvalidVideoUrlEntry {
    line: number;
    text: string;
    start: number;
    end: number;
    reason: InvalidVideoUrlReason;
}

export type ParseVideoUrlListResult =
    | { ok: true; videos: ProvidedVideoUrl[] }
    | { ok: false; code: 'empty' | 'limit' | 'text-limit'; lines: number[] }
    | { ok: false; code: 'invalid'; lines: number[]; invalidEntries: InvalidVideoUrlEntry[] };

const NUMBER_PREFIX_REGEX = /^\d+\.\s*/;
const UNSUPPORTED_NUMBER_PREFIX_REGEX = /^\d+(?:\)\s*|\s+)/;
const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WHITESPACE_REGEX = /\s/;

function checkVideoUrl(body: string): { youtubeId: string | null; isUrl: boolean } {
    const hasScheme = SCHEME_REGEX.test(body);
    if (body === '' || WHITESPACE_REGEX.test(body)) {
        return { youtubeId: null, isUrl: hasScheme };
    }
    const candidate = hasScheme ? body : `https://${body}`;
    let parsed: URL | null = null;
    try {
        parsed = new URL(candidate);
    } catch {
        parsed = null;
    }
    if (parsed === null) {
        return { youtubeId: null, isUrl: hasScheme };
    }
    const isUrl = hasScheme || parsed.hostname.includes('.');
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username !== ''
        || parsed.password !== '') {
        return { youtubeId: null, isUrl };
    }
    return { youtubeId: extractYouTubeId(parsed.href), isUrl };
}

function classifyInvalidEntry(trimmed: string, hasAcceptedPrefix: boolean, isUrl: boolean): InvalidVideoUrlReason {
    if (hasAcceptedPrefix) {
        return 'url';
    }
    const unsupported = UNSUPPORTED_NUMBER_PREFIX_REGEX.exec(trimmed);
    if (unsupported !== null) {
        const remainder = trimmed.slice(unsupported[0].length).trim();
        return checkVideoUrl(remainder).youtubeId !== null ? 'numbering' : 'entry';
    }
    return isUrl ? 'url' : 'entry';
}

export function parseVideoUrlList(text: string): ParseVideoUrlListResult {
    if (text.length > MAX_VIDEO_URL_TEXT_LENGTH) {
        return { ok: false, code: 'text-limit', lines: [] };
    }
    const lines = text.split(/\r\n|\r|\n/);
    const videos: ProvidedVideoUrl[] = [];
    const invalidEntries: InvalidVideoUrlEntry[] = [];
    let nonblank = 0;
    let offset = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const lineNo = i + 1;
        const rawLine = lines[i];
        const lineStart = offset;
        offset += rawLine.length;
        if (offset < text.length) {
            offset += text.startsWith('\r\n', offset) ? 2 : 1;
        }
        const trimmed = rawLine.trim();
        if (trimmed === '') {
            continue;
        }
        nonblank += 1;
        const hasAcceptedPrefix = NUMBER_PREFIX_REGEX.test(trimmed);
        const body = trimmed.replace(NUMBER_PREFIX_REGEX, '').trim();
        const bodyCheck = checkVideoUrl(body);
        if (bodyCheck.youtubeId === null) {
            invalidEntries.push({
                line: lineNo,
                text: rawLine,
                start: lineStart,
                end: lineStart + rawLine.length,
                reason: classifyInvalidEntry(trimmed, hasAcceptedPrefix, bodyCheck.isUrl),
            });
            continue;
        }
        const youtubeId = bodyCheck.youtubeId;
        videos.push({
            key: `provided-${lineNo}`,
            youtubeId,
            url: `https://www.youtube.com/watch?v=${youtubeId}`,
            line: lineNo,
        });
    }
    if (nonblank === 0) {
        return { ok: false, code: 'empty', lines: [] };
    }
    if (nonblank > MAX_VIDEO_URLS) {
        return { ok: false, code: 'limit', lines: [] };
    }
    if (invalidEntries.length > 0) {
        return {
            ok: false,
            code: 'invalid',
            lines: invalidEntries.map(e => e.line),
            invalidEntries,
        };
    }
    return { ok: true, videos };
}
