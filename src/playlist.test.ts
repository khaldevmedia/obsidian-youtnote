import { describe, expect, it } from 'vitest';
import {
    classifyPlaylistId,
    parseContinuationResponse,
    parseInitialPlaylistResponse,
    PlaylistError,
} from './playlist';

const PLAYLIST_ID = 'PLVbEymL-83SyVXXqT7fYX5sEvELvyGjL7';
const VID_1 = 'F44f57YzC9M';
const VID_2 = 'aYKN5_b7yVo';
const VID_3 = '_4B5Hzuvy_0';

function lockupItem(videoId: string, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        lockupViewModel: {
            contentImage: {
                thumbnailViewModel: {
                    image: {
                        sources: [
                            { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg?sqp=abc`, width: 168, height: 94 },
                            { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg?sqp=def`, width: 336, height: 188 },
                        ],
                    },
                },
            },
            metadata: {
                lockupMetadataViewModel: {
                    title: { content: title },
                },
            },
            contentId: videoId,
            contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
            rendererContext: {
                commandContext: {
                    onTap: {
                        innertubeCommand: {
                            watchEndpoint: {
                                videoId,
                                playlistId: PLAYLIST_ID,
                                index: 0,
                            },
                        },
                    },
                },
            },
            ...extra,
        },
    };
}

function modernContinuation(token: string): Record<string, unknown> {
    return {
        continuationItemViewModel: {
            trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
            continuationCommand: {
                innertubeCommand: {
                    continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' },
                },
            },
        },
    };
}

function initialResponse(options: {
    items?: unknown[];
    omitItemContents?: boolean;
    title?: unknown;
    sectionListTargetId?: string | null;
    itemSectionTargetId?: string | null;
    outerContents?: unknown[];
    alerts?: unknown[];
    contentsKey?: 'twoColumnBrowseResultsRenderer' | 'singleColumnBrowseResultsRenderer';
} = {}): Record<string, unknown> {
    const itemSection: Record<string, unknown> = {};
    if (!options.omitItemContents) {
        itemSection.contents = options.items ?? [lockupItem(VID_1, 'Video one'), lockupItem(VID_2, 'Video two')];
    }
    if (options.itemSectionTargetId !== null) {
        itemSection.targetId = options.itemSectionTargetId ?? PLAYLIST_ID;
    }
    const sectionList: Record<string, unknown> = {
        contents: [
            { itemSectionRenderer: itemSection },
            ...(options.outerContents ?? [modernContinuation('OUTER-TOKEN')]),
        ],
    };
    if (options.sectionListTargetId !== null) {
        sectionList.targetId = options.sectionListTargetId ?? `VL${PLAYLIST_ID}`;
    }
    const root: Record<string, unknown> = {
        contents: {
            [options.contentsKey ?? 'twoColumnBrowseResultsRenderer']: {
                tabs: [
                    { tabRenderer: { selected: true, content: { sectionListRenderer: sectionList } } },
                ],
            },
        },
        metadata: { playlistMetadataRenderer: { title: options.title ?? 'My playlist' } },
    };
    if (options.alerts) {
        root.alerts = options.alerts;
    }
    return root;
}

function continuationResponse(options: {
    items?: unknown[];
    targetId?: string;
    actionsKey?: 'onResponseReceivedActions' | 'onResponseReceivedEndpoints';
    extraActions?: unknown[];
} = {}): Record<string, unknown> {
    const actions = [
        {
            appendContinuationItemsAction: {
                continuationItems: options.items ?? [lockupItem(VID_3, 'Video three')],
                targetId: options.targetId ?? PLAYLIST_ID,
            },
        },
        ...(options.extraActions ?? []),
    ];
    return {
        [options.actionsKey ?? 'onResponseReceivedActions']: actions,
        contents: {
            twoColumnBrowseResultsRenderer: {
                tabs: [{ tabRenderer: { selected: true } }],
            },
        },
    };
}

function errorAlert(): Record<string, unknown> {
    return { alertWithButtonRenderer: { type: 'ERROR', text: { simpleText: 'The playlist does not exist.' } } };
}

function infoAlert(): Record<string, unknown> {
    return { alertWithButtonRenderer: { type: 'INFO', text: { simpleText: 'Unavailable videos are hidden' } } };
}

function codeOf(fn: () => unknown): string {
    try {
        fn();
    } catch (err) {
        return err instanceof PlaylistError ? err.code : 'not-playlist-error';
    }
    return 'no-throw';
}

describe('classifyPlaylistId', () => {
    it('accepts regular playlist ids', () => {
        expect(classifyPlaylistId('PLVbEymL-83SyVXXqT7fYX5sEvELvyGjL7')).toBe('regular');
        expect(classifyPlaylistId('UUuploader123')).toBe('regular');
        expect(classifyPlaylistId('OLAK5uy_abc')).toBe('regular');
        expect(classifyPlaylistId('FLrandom')).toBe('regular');
    });

    it('rejects mix ids', () => {
        expect(classifyPlaylistId('RDMM')).toBe('mix');
        expect(classifyPlaylistId('RDAMVMxyz')).toBe('mix');
        expect(classifyPlaylistId('RDCLAK5uy_abc')).toBe('mix');
        expect(classifyPlaylistId('RD')).toBe('mix');
    });

    it('rejects account-only ids', () => {
        expect(classifyPlaylistId('WL')).toBe('unsupported');
        expect(classifyPlaylistId('LL')).toBe('unsupported');
        expect(classifyPlaylistId('LLabcdef')).toBe('unsupported');
    });

    it('rejects malformed ids', () => {
        expect(classifyPlaylistId('')).toBe('invalid');
        expect(classifyPlaylistId('X')).toBe('invalid');
        expect(classifyPlaylistId('has spaces')).toBe('invalid');
        expect(classifyPlaylistId('A'.repeat(151))).toBe('invalid');
    });
});

describe('parseInitialPlaylistResponse', () => {
    it('extracts title and modern lockup entries in order', () => {
        const page = parseInitialPlaylistResponse(initialResponse(), PLAYLIST_ID);
        expect(page.title).toBe('My playlist');
        expect(page.entries).toHaveLength(2);
        expect(page.entries[0].key).toBe('i0');
        expect(page.entries[0].youtubeId).toBe(VID_1);
        expect(page.entries[0].title).toBe('Video one');
        expect(page.entries[0].available).toBe(true);
        expect(page.entries[0].thumbnail).toBe(`https://i.ytimg.com/vi/${VID_1}/hqdefault.jpg?sqp=def`);
        expect(page.entries[1].youtubeId).toBe(VID_2);
    });

    it('follows the item-section continuation, not the outer section-list one', () => {
        const page = parseInitialPlaylistResponse(initialResponse({
            items: [lockupItem(VID_1, 'v1'), modernContinuation('INNER-TOKEN')],
            outerContents: [modernContinuation('OUTER-TOKEN')],
        }), PLAYLIST_ID);
        expect(page.entries).toHaveLength(1);
        expect(page.continuation).toBe('INNER-TOKEN');
    });

    it('returns null continuation when the list has none', () => {
        const page = parseInitialPlaylistResponse(initialResponse(), PLAYLIST_ID);
        expect(page.continuation).toBeNull();
    });

    it('supports the single-column layout', () => {
        const page = parseInitialPlaylistResponse(initialResponse({ contentsKey: 'singleColumnBrowseResultsRenderer' }), PLAYLIST_ID);
        expect(page.entries).toHaveLength(2);
    });

    it('supports playlist metadata titles expressed as runs', () => {
        const page = parseInitialPlaylistResponse(initialResponse({
            title: { runs: [{ text: 'Part ' }, { text: 'one' }] },
        }), PLAYLIST_ID);
        expect(page.title).toBe('Part one');
    });

    it('keeps repeated video ids as separate entries', () => {
        const page = parseInitialPlaylistResponse(initialResponse({
            items: [lockupItem(VID_1, 'first'), lockupItem(VID_1, 'second')],
        }), PLAYLIST_ID);
        expect(page.entries).toHaveLength(2);
        expect(page.entries[0].youtubeId).toBe(VID_1);
        expect(page.entries[1].youtubeId).toBe(VID_1);
        expect(page.entries[0].key).not.toBe(page.entries[1].key);
    });

    it('keeps an unavailable lockup row disabled instead of dropping it', () => {
        const page = parseInitialPlaylistResponse(initialResponse({
            items: [
                {
                    lockupViewModel: {
                        metadata: { lockupMetadataViewModel: { title: { content: 'Deleted video' } } },
                        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                    },
                },
            ],
        }), PLAYLIST_ID);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0].available).toBe(false);
        expect(page.entries[0].youtubeId).toBeNull();
        expect(page.entries[0].title).toBe('Deleted video');
    });

    it('skips non-video lockup content types', () => {
        const page = parseInitialPlaylistResponse(initialResponse({
            items: [
                lockupItem(VID_1, 'v1'),
                { lockupViewModel: { contentId: 'PLother12345', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: 'mix' } } } } },
            ],
        }), PLAYLIST_ID);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0].youtubeId).toBe(VID_1);
    });

    it('falls back to a derived thumbnail when no trusted source exists', () => {
        const item = lockupItem(VID_1, 'v1');
        const vm = item.lockupViewModel as Record<string, unknown>;
        (vm.contentImage as Record<string, unknown>).thumbnailViewModel = {
            image: { sources: [{ url: 'https://evil.example/x.jpg', width: 1, height: 1 }] },
        };
        const page = parseInitialPlaylistResponse(initialResponse({ items: [item] }), PLAYLIST_ID);
        expect(page.entries[0].thumbnail).toBe(`https://img.youtube.com/vi/${VID_1}/default.jpg`);
    });

    it('accepts trusted ytimg and youtube thumbnail hosts', () => {
        for (const good of [
            'https://i.ytimg.com/vi/x/hqdefault.jpg',
            'https://img.youtube.com/vi/x/default.jpg',
            'https://cdn.ytimg.com/vi/x/mqdefault.jpg',
        ]) {
            const item = lockupItem(VID_1, 'v1');
            const vm = item.lockupViewModel as Record<string, unknown>;
            (vm.contentImage as Record<string, unknown>).thumbnailViewModel = {
                image: { sources: [{ url: good, width: 1, height: 1 }] },
            };
            const page = parseInitialPlaylistResponse(initialResponse({ items: [item] }), PLAYLIST_ID);
            expect(page.entries[0].thumbnail).toBe(good);
        }
    });

    it('rejects deceptive thumbnail urls and derives a safe fallback', () => {
        for (const bad of [
            'https://evil.example\\@cdn.ytimg.com/x.jpg',
            'https://user:pass@i.ytimg.com/x.jpg',
            'https://evil.example@i.ytimg.com/x.jpg',
            'https://ytimg.com.evil.example/x.jpg',
            'http://i.ytimg.com/vi/x/hqdefault.jpg',
            'javascript:alert(1)',
            'not a url',
        ]) {
            const item = lockupItem(VID_1, 'v1');
            const vm = item.lockupViewModel as Record<string, unknown>;
            (vm.contentImage as Record<string, unknown>).thumbnailViewModel = {
                image: { sources: [{ url: bad, width: 1, height: 1 }] },
            };
            const page = parseInitialPlaylistResponse(initialResponse({ items: [item] }), PLAYLIST_ID);
            expect(page.entries[0].thumbnail).toBe(`https://img.youtube.com/vi/${VID_1}/default.jpg`);
        }
    });

    it('ignores INFO alerts but fails on ERROR alerts', () => {
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({ alerts: [infoAlert()] }), PLAYLIST_ID)))
            .toBe('no-throw');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({ alerts: [infoAlert(), errorAlert()] }), PLAYLIST_ID)))
            .toBe('unavailable');
    });

    it('treats an empty item section as an empty playlist', () => {
        const page = parseInitialPlaylistResponse(initialResponse({ items: [] }), PLAYLIST_ID);
        expect(page.entries).toHaveLength(0);
        expect(page.continuation).toBeNull();
    });

    it('fails on malformed or unrelated structures', () => {
        expect(codeOf(() => parseInitialPlaylistResponse(null, PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse('string', PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse({}, PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse({ contents: {} }, PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({ sectionListTargetId: 'VLotherPlaylist1' }), PLAYLIST_ID)))
            .toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({ itemSectionTargetId: 'otherPlaylist1' }), PLAYLIST_ID)))
            .toBe('invalid-response');
    });

    it('supports legacy playlistVideoListRenderer rows', () => {
        const page = parseInitialPlaylistResponse(initialResponse({
            items: [
                {
                    playlistVideoListRenderer: {
                        contents: [
                            {
                                playlistVideoRenderer: {
                                    videoId: VID_1,
                                    title: { runs: [{ text: 'Legacy one' }] },
                                    thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${VID_1}/mqdefault.jpg`, width: 1, height: 1 }] },
                                    lengthSeconds: '187',
                                    isPlayable: true,
                                },
                            },
                            {
                                playlistVideoRenderer: {
                                    videoId: VID_2,
                                    title: { simpleText: 'Gone' },
                                    isPlayable: false,
                                },
                            },
                            { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'LEGACY-NEXT' } } } },
                        ],
                    },
                },
            ],
        }), PLAYLIST_ID);
        expect(page.entries).toHaveLength(2);
        expect(page.entries[0].youtubeId).toBe(VID_1);
        expect(page.entries[0].title).toBe('Legacy one');
        expect(page.entries[0].durationSec).toBe(187);
        expect(page.entries[0].available).toBe(true);
        expect(page.entries[1].available).toBe(false);
        expect(page.entries[1].youtubeId).toBe(VID_2);
        expect(page.continuation).toBe('LEGACY-NEXT');
    });

    it('reads the legacy list-level nextContinuationData token', () => {
        const page = parseInitialPlaylistResponse(initialResponse({
            items: [
                {
                    playlistVideoListRenderer: {
                        contents: [
                            { playlistVideoRenderer: { videoId: VID_1, title: { simpleText: 'v1' }, isPlayable: true } },
                        ],
                        continuations: [{ nextContinuationData: { continuation: 'LIST-LEVEL' } }],
                    },
                },
            ],
        }), PLAYLIST_ID);
        expect(page.continuation).toBe('LIST-LEVEL');
    });

    it('treats a benign message row inside the list as an empty playlist', () => {
        const page = parseInitialPlaylistResponse(initialResponse({
            items: [{ messageRenderer: { text: { simpleText: 'No videos' } } }],
        }), PLAYLIST_ID);
        expect(page.entries).toHaveLength(0);
        expect(page.continuation).toBeNull();
    });

    it('fails on unsupported rows inside a recognized list instead of reporting emptiness', () => {
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: [lockupItem(VID_1, 'v1'), { completelyUnknownRenderer: { data: 1 } }],
        }), PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: ['not-an-object', null],
        }), PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: [{ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } }],
        }), PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: [{ playlistVideoRenderer: {} }],
        }), PLAYLIST_ID))).toBe('invalid-response');
    });

    it('fails when a required list container is missing', () => {
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({ omitItemContents: true }), PLAYLIST_ID)))
            .toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: [{ playlistVideoListRenderer: { continuations: [] } }],
        }), PLAYLIST_ID))).toBe('invalid-response');
    });

    it('fails on a recognized continuation row without a usable token', () => {
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: [
                lockupItem(VID_1, 'v1'),
                { continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: {} } } } },
            ],
        }), PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: [
                lockupItem(VID_1, 'v1'),
                { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: '   ' } } } },
            ],
        }), PLAYLIST_ID))).toBe('invalid-response');
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: [
                lockupItem(VID_1, 'v1'),
                { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 42 } } } },
            ],
        }), PLAYLIST_ID))).toBe('invalid-response');
    });

    it('fails on conflicting inner continuation tokens', () => {
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({
            items: [lockupItem(VID_1, 'v1'), modernContinuation('T1'), modernContinuation('T2')],
        }), PLAYLIST_ID))).toBe('invalid-response');
    });

    it('fails on excessively nested playlist list structures', () => {
        const nested = (depth: number): Record<string, unknown> => ({
            playlistVideoListRenderer: {
                contents: depth === 0
                    ? [{ playlistVideoRenderer: { videoId: VID_1, title: { simpleText: 'v' } } }]
                    : [nested(depth - 1)],
            },
        });
        expect(codeOf(() => parseInitialPlaylistResponse(initialResponse({ items: [nested(6)] }), PLAYLIST_ID)))
            .toBe('invalid-response');
    });
});

describe('parseContinuationResponse', () => {
    it('appends rows for the matching targetId only', () => {
        const page = parseContinuationResponse(continuationResponse(), PLAYLIST_ID, 2);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0].key).toBe('i2');
        expect(page.entries[0].youtubeId).toBe(VID_3);
    });

    it('extracts the next modern continuation token', () => {
        const page = parseContinuationResponse(continuationResponse({
            items: [lockupItem(VID_3, 'v3'), modernContinuation('NEXT-2')],
        }), PLAYLIST_ID, 1);
        expect(page.continuation).toBe('NEXT-2');
    });

    it('accepts the VL-prefixed target id', () => {
        const page = parseContinuationResponse(continuationResponse({ targetId: `VL${PLAYLIST_ID}` }), PLAYLIST_ID, 0);
        expect(page.entries).toHaveLength(1);
    });

    it('ignores append actions for other targets', () => {
        const response = continuationResponse({
            items: [lockupItem(VID_3, 'recommended')],
            extraActions: [
                { appendContinuationItemsAction: { continuationItems: [lockupItem(VID_3, 'other')] , targetId: 'engagement-panel' } },
            ],
            targetId: 'engagement-panel',
        });
        expect(codeOf(() => parseContinuationResponse(response, PLAYLIST_ID, 0))).toBe('invalid-response');
    });

    it('supports onResponseReceivedEndpoints', () => {
        const page = parseContinuationResponse(continuationResponse({ actionsKey: 'onResponseReceivedEndpoints' }), PLAYLIST_ID, 0);
        expect(page.entries).toHaveLength(1);
    });

    it('supports the legacy playlistVideoListContinuation shape', () => {
        const page = parseContinuationResponse({
            continuationContents: {
                playlistVideoListContinuation: {
                    contents: [
                        { playlistVideoRenderer: { videoId: VID_3, title: { simpleText: 'legacy' }, isPlayable: true, lengthSeconds: '42' } },
                        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'LEG-NEXT-2' } } } },
                    ],
                },
            },
        }, PLAYLIST_ID, 5);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0].key).toBe('i5');
        expect(page.entries[0].durationSec).toBe(42);
        expect(page.continuation).toBe('LEG-NEXT-2');
    });

    it('does not append the legacy continuation root when a modern action already matched', () => {
        const response = continuationResponse({ items: [lockupItem(VID_3, 'from-action')] });
        response.continuationContents = {
            playlistVideoListContinuation: {
                contents: [
                    { playlistVideoRenderer: { videoId: VID_2, title: { simpleText: 'legacy' }, isPlayable: true } },
                ],
            },
        };
        const page = parseContinuationResponse(response, PLAYLIST_ID, 0);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0].youtubeId).toBe(VID_3);
    });

    it('uses the legacy continuation root only when its target matches', () => {
        const matching = parseContinuationResponse({
            continuationContents: {
                playlistVideoListContinuation: {
                    targetId: `VL${PLAYLIST_ID}`,
                    contents: [
                        { playlistVideoRenderer: { videoId: VID_3, title: { simpleText: 'legacy' }, isPlayable: true } },
                    ],
                },
            },
        }, PLAYLIST_ID, 0);
        expect(matching.entries).toHaveLength(1);
        expect(codeOf(() => parseContinuationResponse({
            continuationContents: {
                playlistVideoListContinuation: {
                    targetId: 'unrelated-target',
                    contents: [
                        { playlistVideoRenderer: { videoId: VID_3, title: { simpleText: 'legacy' }, isPlayable: true } },
                    ],
                },
            },
        }, PLAYLIST_ID, 0))).toBe('invalid-response');
    });

    it('fails on a matching append action without items', () => {
        expect(codeOf(() => parseContinuationResponse({
            onResponseReceivedActions: [
                { appendContinuationItemsAction: { targetId: PLAYLIST_ID } },
            ],
        }, PLAYLIST_ID, 0))).toBe('invalid-response');
    });

    it('fails on a malformed continuation inside an appended page', () => {
        expect(codeOf(() => parseContinuationResponse(continuationResponse({
            items: [
                lockupItem(VID_3, 'v3'),
                { continuationItemViewModel: { continuationCommand: { innertubeCommand: {} } } },
            ],
        }), PLAYLIST_ID, 0))).toBe('invalid-response');
    });

    it('fails when no continuation action matches the playlist', () => {
        expect(codeOf(() => parseContinuationResponse({}, PLAYLIST_ID, 0))).toBe('invalid-response');
        expect(codeOf(() => parseContinuationResponse(continuationResponse({ targetId: 'something-else' }), PLAYLIST_ID, 0)))
            .toBe('invalid-response');
        expect(codeOf(() => parseContinuationResponse({ alerts: [errorAlert()] }, PLAYLIST_ID, 0))).toBe('unavailable');
    });
});
