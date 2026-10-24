import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import {
    classifyPlaylistId,
    parseContinuationResponse,
    parseInitialPlaylistResponse,
    PlaylistError,
} from './playlist';
import type { PlaylistResult } from './playlist';

const BROWSE_ENDPOINT = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';
const INNERTUBE_CLIENT_NAME = '1';
const INNERTUBE_CLIENT_VERSION = '2.20240726.00.00';
const REQUEST_TIMEOUT_MS = 15000;
const TOTAL_TIMEOUT_MS = 120000;
const MAX_PAGES = 20;
const MAX_ENTRIES = 1000;
const MAX_CONTINUATION_TOKEN_LENGTH = 8192;

const CLIENT_CONTEXT = {
    client: {
        clientName: 'WEB',
        clientVersion: INNERTUBE_CLIENT_VERSION,
        hl: 'en',
        gl: 'US',
    },
};

export interface FetchPlaylistOptions {
    signal?: AbortSignal;
    onProgress?: (loaded: number) => void;
}

function cancelledError(): PlaylistError {
    return new PlaylistError('cancelled', 'Playlist import was cancelled.');
}

async function requestPage(body: string, timeoutMs: number, signal?: AbortSignal): Promise<RequestUrlResponse> {
    let timer: number | null = null;
    let onAbort: (() => void) | null = null;
    const request = requestUrl({
        url: BROWSE_ENDPOINT,
        method: 'POST',
        throw: false,
        headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': INNERTUBE_CLIENT_NAME,
            'X-YouTube-Client-Version': INNERTUBE_CLIENT_VERSION,
        },
        body,
    }).then(null, (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new PlaylistError('http', `YouTube request failed (${message}).`);
    });
    try {
        return await Promise.race([
            request,
            new Promise<never>((_resolve, reject) => {
                timer = window.setTimeout(() => {
                    reject(new PlaylistError('timeout', 'Playlist request timed out.'));
                }, timeoutMs);
                if (signal) {
                    onAbort = () => reject(cancelledError());
                    signal.addEventListener('abort', onAbort);
                }
            }),
        ]);
    } finally {
        if (timer !== null) {
            window.clearTimeout(timer);
        }
        if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    }
}

export async function fetchPlaylist(playlistId: string, options: FetchPlaylistOptions = {}): Promise<PlaylistResult> {
    const kind = classifyPlaylistId(playlistId);
    if (kind === 'invalid') {
        throw new PlaylistError('invalid', 'Invalid playlist identifier.');
    }
    if (kind === 'mix') {
        throw new PlaylistError('mix', 'YouTube Mix playlists cannot be imported.');
    }
    if (kind === 'unsupported') {
        throw new PlaylistError('unsupported', 'This playlist requires a signed-in account and cannot be imported.');
    }

    const signal = options.signal;
    if (signal?.aborted) {
        throw cancelledError();
    }

    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    const seenTokens = new Set<string>();
    const entries: PlaylistResult['entries'] = [];
    let title = '';
    let continuation: string | null = null;
    let first = true;
    let pages = 0;

    while (true) {
        if (signal?.aborted) {
            throw cancelledError();
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new PlaylistError('timeout', 'Playlist import timed out.');
        }
        if (pages >= MAX_PAGES) {
            throw new PlaylistError('limit', 'Playlist is too large to import.');
        }

        const body = first
            ? JSON.stringify({ context: CLIENT_CONTEXT, browseId: `VL${playlistId}` })
            : JSON.stringify({ context: CLIENT_CONTEXT, continuation });

        const response = await requestPage(body, Math.min(REQUEST_TIMEOUT_MS, remaining), signal);
        if (response.status !== 200) {
            throw new PlaylistError('http', `YouTube request failed (status ${response.status}).`);
        }
        pages += 1;

        let pageEntries;
        let next: string | null;
        if (first) {
            const page = parseInitialPlaylistResponse(response.json, playlistId);
            title = page.title;
            pageEntries = page.entries;
            next = page.continuation;
        } else {
            const page = parseContinuationResponse(response.json, playlistId, entries.length);
            pageEntries = page.entries;
            next = page.continuation;
        }
        entries.push(...pageEntries);
        options.onProgress?.(entries.length);
        if (entries.length > MAX_ENTRIES) {
            throw new PlaylistError('limit', 'Playlist is too large to import.');
        }
        if (next === null) {
            break;
        }
        if (typeof next !== 'string' || next.length === 0 || next.length > MAX_CONTINUATION_TOKEN_LENGTH) {
            throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
        }
        if (entries.length >= MAX_ENTRIES) {
            throw new PlaylistError('limit', 'Playlist is too large to import.');
        }
        if (seenTokens.has(next)) {
            throw new PlaylistError('repeated-continuation', 'Playlist pagination did not advance.');
        }
        seenTokens.add(next);
        continuation = next;
        first = false;
    }

    return { title, entries };
}
