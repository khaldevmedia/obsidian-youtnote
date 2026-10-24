import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUrlResponse } from 'obsidian';

vi.mock('obsidian', () => ({
    requestUrl: vi.fn(),
}));

const { requestUrl } = await import('obsidian');
const mockedRequestUrl = vi.mocked(requestUrl);
const { fetchPlaylist } = await import('./playlistFetch');
const { PlaylistError } = await import('./playlist');

const PLAYLIST_ID = 'PLVbEymL-83SyVXXqT7fYX5sEvELvyGjL7';
const ENDPOINT = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';

function lockupItem(videoId: string, playlistId = PLAYLIST_ID): Record<string, unknown> {
    return {
        lockupViewModel: {
            metadata: { lockupMetadataViewModel: { title: { content: `title-${videoId}` } } },
            contentId: videoId,
            contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
            rendererContext: {
                commandContext: {
                    onTap: { innertubeCommand: { watchEndpoint: { videoId, playlistId, index: 0 } } },
                },
            },
        },
    };
}

function modernContinuation(token: string): Record<string, unknown> {
    return {
        continuationItemViewModel: {
            continuationCommand: { innertubeCommand: { continuationCommand: { token } } },
        },
    };
}

function pageResponse(videoIds: string[], nextToken: string | null, playlistId = PLAYLIST_ID): Record<string, unknown> {
    const items: unknown[] = videoIds.map(id => lockupItem(id, playlistId));
    if (nextToken !== null) {
        items.push(modernContinuation(nextToken));
    }
    return {
        contents: {
            twoColumnBrowseResultsRenderer: {
                tabs: [
                    {
                        tabRenderer: {
                            selected: true,
                            content: {
                                sectionListRenderer: {
                                    targetId: `VL${playlistId}`,
                                    contents: [
                                        { itemSectionRenderer: { targetId: playlistId, contents: items } },
                                    ],
                                },
                            },
                        },
                    },
                ],
            },
        },
        metadata: { playlistMetadataRenderer: { title: 'Fetched playlist' } },
    };
}

function continuationResponse(videoIds: string[], nextToken: string | null, playlistId = PLAYLIST_ID): Record<string, unknown> {
    const items: unknown[] = videoIds.map(id => lockupItem(id, playlistId));
    if (nextToken !== null) {
        items.push(modernContinuation(nextToken));
    }
    return {
        onResponseReceivedActions: [
            {
                appendContinuationItemsAction: {
                    targetId: playlistId,
                    continuationItems: items,
                },
            },
        ],
    };
}

function makeResponse(json: unknown, status = 200): { status: number; json: unknown; text: string; headers: Record<string, string>; arrayBuffer: ArrayBuffer } {
    return { status, json, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0) };
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

describe('fetchPlaylist', () => {
    it('posts the fixed browse endpoint with the VL-prefixed id and WEB context', async () => {
        mockedRequestUrl.mockResolvedValue(makeResponse(pageResponse(['aaaaaaaaaa1'], null)));
        const result = await fetchPlaylist(PLAYLIST_ID);
        expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
        const request = mockedRequestUrl.mock.calls[0][0] as { url: string; method: string; headers: Record<string, string>; body: string };
        expect(request.url).toBe(ENDPOINT);
        expect(request.method).toBe('POST');
        expect(request.headers['X-YouTube-Client-Name']).toBe('1');
        expect(request.headers['X-YouTube-Client-Version']).toBe('2.20240726.00.00');
        const body = JSON.parse(request.body) as { context: { client: { clientName: string } }; browseId: string };
        expect(body.browseId).toBe(`VL${PLAYLIST_ID}`);
        expect(body.context.client.clientName).toBe('WEB');
        expect(body.context.client).not.toHaveProperty('key');
        expect(result.title).toBe('Fetched playlist');
        expect(result.entries.map(e => e.youtubeId)).toEqual(['aaaaaaaaaa1']);
    });

    it('paginates with continuation payloads and reports progress in order', async () => {
        mockedRequestUrl
            .mockResolvedValueOnce(makeResponse(pageResponse(['aaaaaaaaaa1', 'aaaaaaaaaa2'], 'T1')))
            .mockResolvedValueOnce(makeResponse(continuationResponse(['aaaaaaaaaa3'], null)));
        const progress: number[] = [];
        const result = await fetchPlaylist(PLAYLIST_ID, { onProgress: n => progress.push(n) });
        expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
        const secondBody = JSON.parse((mockedRequestUrl.mock.calls[1][0] as { body: string }).body) as { continuation: string; browseId?: string };
        expect(secondBody.continuation).toBe('T1');
        expect(secondBody.browseId).toBeUndefined();
        expect(result.entries.map(e => e.youtubeId)).toEqual(['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3']);
        expect(result.entries.map(e => e.key)).toEqual(['i0', 'i1', 'i2']);
        expect(progress).toEqual([2, 3]);
    });

    it('rejects mixes and account-only lists before any request', async () => {
        await expect(errorCode(fetchPlaylist('RDMMabc'))).resolves.toBe('mix');
        await expect(errorCode(fetchPlaylist('RDCLAK5uy_x'))).resolves.toBe('mix');
        await expect(errorCode(fetchPlaylist('WL'))).resolves.toBe('unsupported');
        await expect(errorCode(fetchPlaylist('LLabcdef'))).resolves.toBe('unsupported');
        await expect(errorCode(fetchPlaylist('!!bad!!'))).resolves.toBe('invalid');
        expect(mockedRequestUrl).not.toHaveBeenCalled();
    });

    it('accepts non-PL playlist prefixes', async () => {
        mockedRequestUrl
            .mockResolvedValueOnce(makeResponse(pageResponse(['aaaaaaaaaa1'], null, 'UUuploader1')))
            .mockResolvedValueOnce(makeResponse(pageResponse(['aaaaaaaaaa1'], null, 'OLAK5uy_x')));
        await expect(fetchPlaylist('UUuploader1')).resolves.toBeDefined();
        await expect(fetchPlaylist('OLAK5uy_x')).resolves.toBeDefined();
        expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('rejects non-200 responses', async () => {
        mockedRequestUrl.mockResolvedValue(makeResponse({}, 500));
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('http');
    });

    it('rejects network failures with a stable error code', async () => {
        mockedRequestUrl.mockRejectedValue(new Error('net down'));
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('http');
    });

    it('rejects ERROR alerts but tolerates INFO alerts', async () => {
        const infoPage = pageResponse(['aaaaaaaaaa1'], null);
        infoPage.alerts = [{ alertWithButtonRenderer: { type: 'INFO', text: { simpleText: 'hidden' } } }];
        mockedRequestUrl.mockResolvedValueOnce(makeResponse(infoPage));
        await expect(fetchPlaylist(PLAYLIST_ID)).resolves.toBeDefined();

        const errorPage = pageResponse(['aaaaaaaaaa1'], null);
        errorPage.alerts = [{ alertWithButtonRenderer: { type: 'ERROR', text: { simpleText: 'gone' } } }];
        mockedRequestUrl.mockResolvedValueOnce(makeResponse(errorPage));
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('unavailable');
    });

    it('rejects malformed responses without yielding partial results', async () => {
        mockedRequestUrl.mockResolvedValueOnce(makeResponse({ unrelated: true }));
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('invalid-response');
        mockedRequestUrl.mockReset();
        mockedRequestUrl
            .mockResolvedValueOnce(makeResponse(pageResponse(['aaaaaaaaaa1'], 'T1')))
            .mockResolvedValueOnce(makeResponse({ unrelated: true }));
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('invalid-response');
    });

    it('rejects a repeated continuation token', async () => {
        mockedRequestUrl
            .mockResolvedValueOnce(makeResponse(pageResponse(['aaaaaaaaaa1'], 'LOOP')))
            .mockResolvedValueOnce(makeResponse(continuationResponse(['aaaaaaaaaa2'], 'LOOP')));
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('repeated-continuation');
        expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('stops at the page bound', async () => {
        let n = 0;
        mockedRequestUrl.mockImplementation((async () => {
            n += 1;
            return makeResponse(n === 1
                ? pageResponse(['aaaaaaaaaa1'], `T${n}`)
                : continuationResponse(['aaaaaaaaaa1'], `T${n}`));
        }) as never);
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('limit');
        expect(mockedRequestUrl).toHaveBeenCalledTimes(20);
    });

    it('allows exactly 1000 entries when no continuation remains', async () => {
        let n = 0;
        mockedRequestUrl.mockImplementation((async () => {
            n += 1;
            const ids = Array.from({ length: 100 }, (_, i) => `v${String(n).padStart(2, '0')}x${String(i).padStart(7, '0')}`);
            return makeResponse(n === 1
                ? pageResponse(ids, 't0')
                : continuationResponse(ids, n < 10 ? `t${n}` : null));
        }) as never);
        const result = await fetchPlaylist(PLAYLIST_ID);
        expect(result.entries).toHaveLength(1000);
        expect(mockedRequestUrl).toHaveBeenCalledTimes(10);
    });

    it('rejects when the entry bound is reached with a pending continuation', async () => {
        let n = 0;
        mockedRequestUrl.mockImplementation((async () => {
            n += 1;
            const ids = Array.from({ length: 100 }, (_, i) => `v${String(n).padStart(2, '0')}x${String(i).padStart(7, '0')}`);
            return makeResponse(n === 1
                ? pageResponse(ids, 't0')
                : continuationResponse(ids, `t${n}`));
        }) as never);
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('limit');
        expect(mockedRequestUrl).toHaveBeenCalledTimes(10);
    });

    it('rejects when a single page exceeds the entry bound', async () => {
        const ids = Array.from({ length: 1001 }, (_, i) => `v${String(i).padStart(10, '0')}`);
        mockedRequestUrl.mockResolvedValueOnce(makeResponse(pageResponse(ids, null)));
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('limit');
    });

    it('times out a hung request', async () => {
        vi.useFakeTimers();
        stubWindow();
        mockedRequestUrl.mockImplementation((() => new Promise(() => {})) as never);
        const result = errorCode(fetchPlaylist(PLAYLIST_ID));
        await vi.advanceTimersByTimeAsync(16000);
        await expect(result).resolves.toBe('timeout');
        expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('times out when the total budget is exceeded', async () => {
        vi.useFakeTimers();
        stubWindow();
        let n = 0;
        mockedRequestUrl.mockImplementation((async () => {
            n += 1;
            vi.setSystemTime(Date.now() + 40000);
            return makeResponse(n === 1
                ? pageResponse(['aaaaaaaaaa1'], `T${n}`)
                : continuationResponse(['aaaaaaaaaa1'], `T${n}`));
        }) as never);
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID))).resolves.toBe('timeout');
        expect(mockedRequestUrl.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('cancels promptly, ignores the late response, and stops requesting pages', async () => {
        const controller = new AbortController();
        const deferred: { resolve?: (value: RequestUrlResponse) => void } = {};
        mockedRequestUrl
            .mockImplementationOnce((() => new Promise<RequestUrlResponse>(resolve => { deferred.resolve = resolve; })) as never)
            .mockImplementation((async () => makeResponse(continuationResponse(['aaaaaaaaaa2'], null))) as never);
        const result = errorCode(fetchPlaylist(PLAYLIST_ID, { signal: controller.signal }));
        await flush();
        expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
        controller.abort();
        await expect(result).resolves.toBe('cancelled');
        deferred.resolve?.(makeResponse(pageResponse(['aaaaaaaaaa1'], 'T1')));
        await flush();
        expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('rejects an already-aborted signal without requesting', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(errorCode(fetchPlaylist(PLAYLIST_ID, { signal: controller.signal }))).resolves.toBe('cancelled');
        expect(mockedRequestUrl).not.toHaveBeenCalled();
    });

    it('follows the inner item-section continuation rather than the outer one', async () => {
        const first = pageResponse(['aaaaaaaaaa1'], 'INNER');
        const sectionList = ((first.contents as Record<string, { tabs: { tabRenderer: { content: { sectionListRenderer: { contents: unknown[] } } } }[] }>)
            .twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer);
        sectionList.contents.push(modernContinuation('OUTER'));
        mockedRequestUrl
            .mockResolvedValueOnce(makeResponse(first))
            .mockResolvedValueOnce(makeResponse(continuationResponse(['aaaaaaaaaa2'], null)));
        await fetchPlaylist(PLAYLIST_ID);
        const secondBody = JSON.parse((mockedRequestUrl.mock.calls[1][0] as { body: string }).body) as { continuation: string };
        expect(secondBody.continuation).toBe('INNER');
    });
});
