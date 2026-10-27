import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvidedVideoUrl } from './videoUrlList';

vi.mock('obsidian', () => ({
    requestUrl: vi.fn(),
}));

const { requestUrl } = await import('obsidian');
const mockedRequestUrl = vi.mocked(requestUrl);
const { fetchProvidedVideos } = await import('./videoUrlListFetch');
const { PlaylistError } = await import('./playlist');

const ID1 = 'aircAruvnKk';
const ID2 = 'SZorAJ4I7xg';
const ID3 = 'ytNewVid901';
const ID4 = 'ytNewVid902';
const ID5 = 'ytNewVid903';
const ID6 = 'ytNewVid904';
const ID7 = 'ytNewVid905';
const ID8 = 'ytNewVid906';

function provided(youtubeId: string, key?: string): ProvidedVideoUrl {
    return { key: key ?? `k-${youtubeId}-${Math.random().toString(36).slice(2, 7)}`, youtubeId, url: `https://www.youtube.com/watch?v=${youtubeId}`, line: 1 };
}

function makeResponse(json: unknown, status = 200) {
    return { status, json, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

function oembedData(id: string, extra: Record<string, unknown> = {}) {
    return makeResponse({ title: `title-${id}`, thumbnail_url: 'https://i.ytimg.com/vi/x/default.jpg', ...extra });
}

function requestedId(call: unknown[]): string {
    const req = call[0] as { url: string };
    const encoded = req.url.split('url=')[1].split('&')[0];
    return decodeURIComponent(encoded).slice(-11);
}

function errorCode(promise: Promise<unknown>): Promise<string> {
    return promise.then(
        () => 'resolved',
        (err: unknown) => (err instanceof PlaylistError ? err.code : `other:${String(err)}`),
    );
}

function flush(): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, 0));
}

function stubWindow(): void {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
}

beforeEach(() => {
    mockedRequestUrl.mockReset();
    stubWindow();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('fetchProvidedVideos', () => {
    it('returns entries in pasted order even when requests finish out of order', async () => {
        const deferreds = new Map<string, { resolve: (v: ReturnType<typeof makeResponse>) => void }>();
        mockedRequestUrl.mockImplementation(((req: { url: string }) => new Promise(resolve => {
            const id = decodeURIComponent(req.url.split('url=')[1].split('&')[0]).slice(-11);
            deferreds.set(id, { resolve });
        })) as never);
        const promise = fetchProvidedVideos([provided(ID1, 'p0'), provided(ID2, 'p1'), provided(ID3, 'p2')]);
        await flush();
        deferreds.get(ID3)!.resolve(oembedData(ID3));
        deferreds.get(ID1)!.resolve(oembedData(ID1));
        deferreds.get(ID2)!.resolve(oembedData(ID2));
        const result = await promise;
        expect(result.entries.map(e => e.key)).toEqual(['p0', 'p1', 'p2']);
        expect(result.entries.map(e => e.youtubeId)).toEqual([ID1, ID2, ID3]);
        expect(result.entries.map(e => e.title)).toEqual([`title-${ID1}`, `title-${ID2}`, `title-${ID3}`]);
        expect(result.entries.every(e => e.available)).toBe(true);
    });

    it('requests each unique id once and keeps repeated rows', async () => {
        mockedRequestUrl.mockImplementation((async (req: { url: string }) => oembedData(requestedId([req]))) as never);
        const result = await fetchProvidedVideos([provided(ID1, 'p0'), provided(ID2, 'p1'), provided(ID1, 'p2')]);
        expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
        expect(result.entries.map(e => e.key)).toEqual(['p0', 'p1', 'p2']);
        expect(result.entries.map(e => e.youtubeId)).toEqual([ID1, ID2, ID1]);
        expect(result.entries.every(e => e.available)).toBe(true);
    });

    it('marks rejected, non-200 and malformed results unavailable beside successes', async () => {
        mockedRequestUrl.mockImplementation((async (req: { url: string }) => {
            const id = requestedId([req]);
            if (id === ID2) return makeResponse({}, 500);
            if (id === ID3) throw new Error('net down');
            if (id === ID4) return makeResponse({ title: '' });
            return oembedData(id);
        }) as never);
        const result = await fetchProvidedVideos([provided(ID1, 'p0'), provided(ID2, 'p1'), provided(ID3, 'p2'), provided(ID4, 'p3')]);
        expect(result.entries.map(e => e.available)).toEqual([true, false, false, false]);
        expect(result.entries[0].title).toBe(`title-${ID1}`);
        for (const entry of result.entries.slice(1)) {
            expect(entry.youtubeId).toBeTruthy();
            expect(entry.title).toBe(`https://www.youtube.com/watch?v=${entry.youtubeId}`);
            expect(entry.thumbnail).toBe(`https://img.youtube.com/vi/${entry.youtubeId}/default.jpg`);
        }
    });

    it('rejects a non-object payload as unavailable', async () => {
        mockedRequestUrl.mockResolvedValue(makeResponse('not json'));
        const result = await fetchProvidedVideos([provided(ID1, 'p0')]);
        expect(result.entries[0].available).toBe(false);
    });

    it('keeps trusted thumbnails and falls back for untrusted or missing ones', async () => {
        mockedRequestUrl.mockImplementation((async (req: { url: string }) => {
            const id = requestedId([req]);
            if (id === ID2) return oembedData(id, { thumbnail_url: 'https://evil.example/x.jpg' });
            if (id === ID3) return oembedData(id, { thumbnail_url: 42 });
            return oembedData(id, { thumbnail_url: 'https://i.ytimg.com/vi/x/hq.jpg' });
        }) as never);
        const result = await fetchProvidedVideos([provided(ID1, 'p0'), provided(ID2, 'p1'), provided(ID3, 'p2')]);
        expect(result.entries[0].thumbnail).toBe('https://i.ytimg.com/vi/x/hq.jpg');
        expect(result.entries[1].thumbnail).toBe(`https://img.youtube.com/vi/${ID2}/default.jpg`);
        expect(result.entries[2].thumbnail).toBe(`https://img.youtube.com/vi/${ID3}/default.jpg`);
    });

    it('caps concurrency at four in-flight requests', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const deferreds: { resolve: (v: ReturnType<typeof makeResponse>) => void; id: string }[] = [];
        mockedRequestUrl.mockImplementation(((req: { url: string }) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            const id = requestedId([req]);
            return new Promise(resolve => {
                deferreds.push({
                    id,
                    resolve: (value) => {
                        inFlight -= 1;
                        resolve(value);
                    },
                });
            });
        }) as never);
        const promise = fetchProvidedVideos([ID1, ID2, ID3, ID4, ID5, ID6, ID7, ID8].map(id => provided(id)));
        await flush();
        expect(mockedRequestUrl).toHaveBeenCalledTimes(4);
        expect(maxInFlight).toBe(4);
        for (const deferred of deferreds.splice(0)) {
            deferred.resolve(oembedData(deferred.id));
        }
        await flush();
        for (const deferred of deferreds.splice(0)) {
            deferred.resolve(oembedData(deferred.id));
        }
        const result = await promise;
        expect(result.entries).toHaveLength(8);
        expect(mockedRequestUrl).toHaveBeenCalledTimes(8);
        expect(maxInFlight).toBe(4);
    });

    it('uses only canonical encoded oEmbed watch urls', async () => {
        mockedRequestUrl.mockImplementation((async (req: { url: string }) => oembedData(requestedId([req]))) as never);
        await fetchProvidedVideos([provided(ID1), provided(ID2)]);
        for (const call of mockedRequestUrl.mock.calls) {
            const req = call[0] as { url: string; method?: string };
            expect(req.url.startsWith('https://www.youtube.com/oembed?url=')).toBe(true);
            expect(req.url).not.toContain('browse');
            expect(req.url).not.toContain('playlist');
            const decoded = decodeURIComponent(req.url.split('url=')[1].split('&')[0]);
            expect(decoded.startsWith('https://www.youtube.com/watch?v=')).toBe(true);
        }
    });

    it('marks a per-request timed-out video unavailable', async () => {
        vi.useFakeTimers();
        stubWindow();
        mockedRequestUrl.mockImplementation((async (req: { url: string }) => {
            const id = requestedId([req]);
            if (id === ID2) return new Promise(() => {});
            return oembedData(id);
        }) as never);
        const promise = fetchProvidedVideos([provided(ID1, 'p0'), provided(ID2, 'p1'), provided(ID3, 'p2')]);
        await vi.advanceTimersByTimeAsync(11000);
        const result = await promise;
        expect(result.entries.map(e => e.available)).toEqual([true, false, true]);
        expect(result.entries[1].youtubeId).toBe(ID2);
    });

    it('rejects with timeout past the total deadline without a partial result', async () => {
        vi.useFakeTimers();
        stubWindow();
        mockedRequestUrl.mockImplementation((() => new Promise(() => {})) as never);
        const many = Array.from({ length: 60 }, (_, i) => provided(`deadline-${String(i).padStart(8, '0')}x`));
        const result = errorCode(fetchProvidedVideos(many));
        await vi.advanceTimersByTimeAsync(121000);
        await expect(result).resolves.toBe('timeout');
    });

    it('cancels promptly, stops queued requests and ignores late completions', async () => {
        const controller = new AbortController();
        const deferreds: { id: string; resolve: (v: ReturnType<typeof makeResponse>) => void }[] = [];
        mockedRequestUrl.mockImplementation(((req: { url: string }) => new Promise(resolve => {
            deferreds.push({ id: requestedId([req]), resolve });
        })) as never);
        const progress: number[] = [];
        const result = errorCode(fetchProvidedVideos(
            [ID1, ID2, ID3, ID4, ID5].map(id => provided(id)),
            { signal: controller.signal, onProgress: n => progress.push(n) },
        ));
        await flush();
        expect(mockedRequestUrl).toHaveBeenCalledTimes(4);
        controller.abort();
        await expect(result).resolves.toBe('cancelled');
        for (const deferred of deferreds.splice(0)) {
            deferred.resolve(oembedData(deferred.id));
        }
        await flush();
        expect(mockedRequestUrl).toHaveBeenCalledTimes(4);
        expect(progress).toEqual([]);
    });

    it('rejects an already-aborted signal without requesting', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(errorCode(fetchProvidedVideos([provided(ID1)], { signal: controller.signal }))).resolves.toBe('cancelled');
        expect(mockedRequestUrl).not.toHaveBeenCalled();
    });

    it('reports progress per row including repeated ids', async () => {
        mockedRequestUrl.mockImplementation((async (req: { url: string }) => oembedData(requestedId([req]))) as never);
        const progress: number[] = [];
        const result = await fetchProvidedVideos(
            [provided(ID1), provided(ID2), provided(ID1), provided(ID2), provided(ID3)],
            { onProgress: n => progress.push(n) },
        );
        expect(result.entries).toHaveLength(5);
        expect(progress[progress.length - 1]).toBe(5);
        expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    });

    it('handles empty input defensively and rejects over-limit input', async () => {
        const empty = await fetchProvidedVideos([]);
        expect(empty.entries).toEqual([]);
        expect(mockedRequestUrl).not.toHaveBeenCalled();
        const tooMany = Array.from({ length: 1001 }, (_, i) => provided(ID1, `k${i}`));
        await expect(errorCode(fetchProvidedVideos(tooMany))).resolves.toBe('limit');
        expect(mockedRequestUrl).not.toHaveBeenCalled();
    });
});
