import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import { isTrustedThumbnailUrl, PlaylistError } from './playlist';
import type { PlaylistResult } from './playlist';
import { MAX_VIDEO_URLS } from './videoUrlList';
import type { ProvidedVideoUrl } from './videoUrlList';

const OEMBED_ENDPOINT = 'https://www.youtube.com/oembed';
const WORKER_COUNT = 4;
const REQUEST_TIMEOUT_MS = 10000;
const TOTAL_TIMEOUT_MS = 120000;

export interface FetchProvidedVideosOptions {
    signal?: AbortSignal;
    onProgress?: (loaded: number) => void;
}

interface OEmbedData {
    title?: string;
    thumbnail_url?: string;
}

function cancelledError(): PlaylistError {
    return new PlaylistError('cancelled', 'Video import was cancelled.');
}

function fallbackThumbnail(youtubeId: string): string {
    return `https://img.youtube.com/vi/${youtubeId}/default.jpg`;
}

async function requestMetadata(youtubeId: string, timeoutMs: number, signal: AbortSignal): Promise<OEmbedData | null> {
    const watchUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
    const oembedUrl = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(watchUrl)}&format=json`;
    let timer: number | null = null;
    let onAbort: (() => void) | null = null;
    const request: Promise<RequestUrlResponse | null> = requestUrl({ url: oembedUrl }).then(null, () => null);
    try {
        const response = await Promise.race([
            request,
            new Promise<never>((_resolve, reject) => {
                timer = window.setTimeout(() => {
                    reject(new PlaylistError('timeout', 'Video request timed out.'));
                }, timeoutMs);
                onAbort = () => reject(cancelledError());
                signal.addEventListener('abort', onAbort);
            }),
        ]);
        if (response === null || response.status !== 200) {
            return null;
        }
        const data = response.json as unknown;
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
            return null;
        }
        const record = data as OEmbedData;
        if (typeof record.title !== 'string' || record.title.trim() === '') {
            return null;
        }
        return record;
    } finally {
        if (timer !== null) {
            window.clearTimeout(timer);
        }
        if (onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    }
}

export async function fetchProvidedVideos(
    videos: ProvidedVideoUrl[],
    options: FetchProvidedVideosOptions = {},
): Promise<PlaylistResult> {
    if (videos.length > MAX_VIDEO_URLS) {
        throw new PlaylistError('limit', 'Too many video links were provided.');
    }
    const signal = options.signal;
    if (signal?.aborted) {
        throw cancelledError();
    }
    const entries = videos.map(video => ({
        key: video.key,
        youtubeId: video.youtubeId,
        title: video.url,
        available: false,
        thumbnail: fallbackThumbnail(video.youtubeId),
    }));
    if (videos.length === 0) {
        return { title: 'Provided videos', entries };
    }

    const uniqueIds: string[] = [];
    const rowsPerId = new Map<string, number>();
    for (const video of videos) {
        const count = rowsPerId.get(video.youtubeId);
        if (count === undefined) {
            rowsPerId.set(video.youtubeId, 1);
            uniqueIds.push(video.youtubeId);
        } else {
            rowsPerId.set(video.youtubeId, count + 1);
        }
    }

    const local = new AbortController();
    const onExternalAbort = () => local.abort();
    signal?.addEventListener('abort', onExternalAbort);

    let deadlineTimer: number | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = window.setTimeout(() => {
            local.abort();
            reject(new PlaylistError('timeout', 'Video import timed out.'));
        }, TOTAL_TIMEOUT_MS);
    });

    const metadata = new Map<string, OEmbedData | null>();
    let queueIndex = 0;
    let completed = 0;

    const worker = async (): Promise<void> => {
        while (queueIndex < uniqueIds.length && !local.signal.aborted) {
            const youtubeId = uniqueIds[queueIndex];
            queueIndex += 1;
            try {
                metadata.set(youtubeId, await requestMetadata(youtubeId, REQUEST_TIMEOUT_MS, local.signal));
            } catch (error) {
                if (error instanceof PlaylistError && error.code === 'cancelled') {
                    throw error;
                }
                metadata.set(youtubeId, null);
            }
            completed += rowsPerId.get(youtubeId) ?? 0;
            if (!local.signal.aborted) {
                options.onProgress?.(completed);
            }
        }
    };

    const run = async (): Promise<void> => {
        await Promise.all(Array.from({ length: Math.min(WORKER_COUNT, uniqueIds.length) }, () => worker()));
    };

    try {
        await Promise.race([run(), deadline]);
    } finally {
        if (deadlineTimer !== null) {
            window.clearTimeout(deadlineTimer);
        }
        if (signal && onExternalAbort) {
            signal.removeEventListener('abort', onExternalAbort);
        }
        local.abort();
    }
    if (signal?.aborted) {
        throw cancelledError();
    }

    for (const entry of entries) {
        const data = metadata.get(entry.youtubeId) ?? null;
        if (data === null || typeof data.title !== 'string' || data.title.trim() === '') {
            continue;
        }
        entry.available = true;
        entry.title = data.title;
        if (typeof data.thumbnail_url === 'string' && isTrustedThumbnailUrl(data.thumbnail_url)) {
            entry.thumbnail = data.thumbnail_url;
        }
    }
    return { title: 'Provided videos', entries };
}
