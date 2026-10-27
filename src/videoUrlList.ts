import { extractYouTubeId } from './utils';

export const MAX_VIDEO_URLS = 1000;
export const MAX_VIDEO_URL_TEXT_LENGTH = 200000;

export interface ProvidedVideoUrl {
    key: string;
    youtubeId: string;
    url: string;
    line: number;
}

export type ParseVideoUrlListResult =
    | { ok: true; videos: ProvidedVideoUrl[] }
    | { ok: false; code: 'empty' | 'limit' | 'text-limit' | 'invalid'; lines: number[] };

const NUMBER_PREFIX_REGEX = /^\d+\.\s+/;
const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WHITESPACE_REGEX = /\s/;

export function parseVideoUrlList(text: string): ParseVideoUrlListResult {
    if (text.length > MAX_VIDEO_URL_TEXT_LENGTH) {
        return { ok: false, code: 'text-limit', lines: [] };
    }
    const lines = text.split(/\r\n|\r|\n/);
    const videos: ProvidedVideoUrl[] = [];
    const invalid: number[] = [];
    let nonblank = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const lineNo = i + 1;
        const trimmed = lines[i].trim();
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
            invalid.push(lineNo);
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
    if (invalid.length > 0) {
        return { ok: false, code: 'invalid', lines: invalid };
    }
    return { ok: true, videos };
}
