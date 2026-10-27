import { extractYouTubeId } from './utils';

export const MAX_VIDEO_URLS = 1000;
export const MAX_VIDEO_URL_TEXT_LENGTH = 200000;

export interface ProvidedVideoUrl {
    key: string;
    youtubeId: string;
    url: string;
    line: number;
}

export interface InvalidVideoUrlEntry {
    line: number;
    text: string;
    start: number;
    end: number;
}

export type ParseVideoUrlListResult =
    | { ok: true; videos: ProvidedVideoUrl[] }
    | { ok: false; code: 'empty' | 'limit' | 'text-limit'; lines: number[] }
    | { ok: false; code: 'invalid'; lines: number[]; invalidEntries: InvalidVideoUrlEntry[] };

const NUMBER_PREFIX_REGEX = /^\d+\.\s+/;
const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WHITESPACE_REGEX = /\s/;

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
        const body = trimmed.replace(NUMBER_PREFIX_REGEX, '').trim();
        let youtubeId: string | null = null;
        if (body !== '' && !WHITESPACE_REGEX.test(body)) {
            const candidate = SCHEME_REGEX.test(body) ? body : `https://${body}`;
            let parsed: URL | null = null;
            try {
                parsed = new URL(candidate);
            } catch {
                parsed = null;
            }
            if (parsed !== null
                && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
                && parsed.username === ''
                && parsed.password === '') {
                youtubeId = extractYouTubeId(parsed.href);
            }
        }
        if (youtubeId === null) {
            invalidEntries.push({ line: lineNo, text: rawLine, start: lineStart, end: lineStart + rawLine.length });
            continue;
        }
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
