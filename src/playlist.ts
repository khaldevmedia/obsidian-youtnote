const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_REGEX = /^[A-Za-z0-9_-]{2,150}$/;

export interface PlaylistEntry {
    key: string;
    youtubeId: string | null;
    title: string;
    thumbnail?: string;
    durationSec?: number;
    available: boolean;
}

export interface PlaylistResult {
    title: string;
    entries: PlaylistEntry[];
}

export type PlaylistIdKind = 'regular' | 'mix' | 'unsupported' | 'invalid';

export type PlaylistErrorCode =
    | 'invalid'
    | 'mix'
    | 'unsupported'
    | 'unavailable'
    | 'invalid-response'
    | 'http'
    | 'timeout'
    | 'limit'
    | 'repeated-continuation'
    | 'cancelled';

export class PlaylistError extends Error {
    readonly code: PlaylistErrorCode;

    constructor(code: PlaylistErrorCode, message: string) {
        super(message);
        this.name = 'PlaylistError';
        this.code = code;
    }
}

export function classifyPlaylistId(id: string): PlaylistIdKind {
    if (!PLAYLIST_ID_REGEX.test(id)) {
        return 'invalid';
    }
    if (id === 'WL' || id.startsWith('LL')) {
        return 'unsupported';
    }
    if (id.startsWith('RD')) {
        return 'mix';
    }
    return 'regular';
}

interface ParsedItems {
    entries: PlaylistEntry[];
    continuation: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asArray(value: unknown): unknown[] | null {
    return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function isValidVideoId(value: string | null): value is string {
    return value !== null && YOUTUBE_VIDEO_ID_REGEX.test(value);
}

function textOf(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    const rec = asRecord(value);
    if (!rec) {
        return '';
    }
    const simple = asString(rec.simpleText);
    if (simple !== null) {
        return simple;
    }
    const runs = asArray(rec.runs);
    if (!runs) {
        return '';
    }
    let out = '';
    for (const run of runs.slice(0, 64)) {
        const text = asString(asRecord(run)?.text);
        if (text) {
            out += text;
        }
    }
    return out;
}

function throwOnErrorAlerts(root: Record<string, unknown>): void {
    const alerts = asArray(root.alerts);
    if (!alerts) {
        return;
    }
    for (const alert of alerts.slice(0, 16)) {
        const rec = asRecord(alert);
        if (!rec) {
            continue;
        }
        const renderer = asRecord(rec.alertWithButtonRenderer) ?? asRecord(rec.alertRenderer);
        if (!renderer) {
            continue;
        }
        if (asString(renderer.type) === 'ERROR') {
            const text = textOf(renderer.text);
            throw new PlaylistError('unavailable', text || 'The playlist is unavailable.');
        }
    }
}

export function isTrustedThumbnailUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') {
        return false;
    }
    if (parsed.username !== '' || parsed.password !== '') {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'i.ytimg.com'
        || host === 'img.youtube.com'
        || host.endsWith('.ytimg.com');
}

function pickThumbnail(sources: unknown, youtubeId: string | null): string | undefined {
    const list = asArray(sources);
    if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
            const url = asString(asRecord(list[i])?.url);
            if (url && isTrustedThumbnailUrl(url)) {
                return url;
            }
        }
    }
    if (youtubeId) {
        return `https://img.youtube.com/vi/${youtubeId}/default.jpg`;
    }
    return undefined;
}

function makeEntry(
    index: number,
    youtubeId: string | null,
    title: string,
    available: boolean,
    thumbnail?: string,
    durationSec?: number,
): PlaylistEntry {
    const entry: PlaylistEntry = {
        key: `i${index}`,
        youtubeId,
        title,
        available,
    };
    if (thumbnail !== undefined) {
        entry.thumbnail = thumbnail;
    }
    if (durationSec !== undefined) {
        entry.durationSec = durationSec;
    }
    return entry;
}

function malformedItem(): PlaylistError {
    return new PlaylistError('invalid-response', 'Unexpected playlist response.');
}

function parseLockupEntry(viewModel: Record<string, unknown>, index: number): PlaylistEntry | null {
    const contentType = asString(viewModel.contentType);
    if (contentType !== null && contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') {
        return null;
    }

    const contentId = asString(viewModel.contentId);
    const onTap = asRecord(asRecord(asRecord(viewModel.rendererContext)?.commandContext)?.onTap);
    const watchEndpoint = asRecord(asRecord(onTap?.innertubeCommand)?.watchEndpoint);
    const endpointId = asString(watchEndpoint?.videoId);
    const youtubeId = isValidVideoId(contentId)
        ? contentId
        : isValidVideoId(endpointId)
            ? endpointId
            : null;

    const metadata = asRecord(asRecord(viewModel.metadata)?.lockupMetadataViewModel);
    const titleRec = asRecord(metadata?.title);
    const title = asString(titleRec?.content) ?? textOf(metadata?.title);

    if (!title && !youtubeId) {
        throw malformedItem();
    }

    const sources = asRecord(asRecord(asRecord(viewModel.contentImage)?.thumbnailViewModel)?.image)?.sources;
    return makeEntry(index, youtubeId, title, youtubeId !== null, pickThumbnail(sources, youtubeId));
}

function parseLegacyVideoEntry(renderer: Record<string, unknown>, index: number): PlaylistEntry {
    const rawVideoId = asString(renderer.videoId);
    const youtubeId = isValidVideoId(rawVideoId) ? rawVideoId : null;
    const title = textOf(renderer.title);
    if (!title && !youtubeId) {
        throw malformedItem();
    }
    const available = youtubeId !== null && renderer.isPlayable !== false;
    const lengthSeconds = asString(renderer.lengthSeconds);
    const durationSec = lengthSeconds !== null && /^\d+$/.test(lengthSeconds)
        ? Number.parseInt(lengthSeconds, 10)
        : undefined;
    const thumbnails = asRecord(renderer.thumbnail)?.thumbnails;
    return makeEntry(
        index,
        youtubeId,
        title,
        available,
        pickThumbnail(thumbnails, youtubeId),
        durationSec,
    );
}

function addContinuationToken(acc: ParsedItems, token: string): void {
    if (acc.continuation !== null && acc.continuation !== token) {
        throw malformedItem();
    }
    acc.continuation = token;
}

function continuationTokenFromItem(item: Record<string, unknown>): string | null {
    const modern = asRecord(item.continuationItemViewModel);
    if (modern) {
        const command = asRecord(asRecord(asRecord(modern.continuationCommand)?.innertubeCommand)?.continuationCommand);
        const token = asString(command?.token);
        if (token === null || token.trim() === '') {
            throw malformedItem();
        }
        return token;
    }
    const legacy = asRecord(item.continuationItemRenderer);
    if (legacy) {
        const command = asRecord(asRecord(legacy.continuationEndpoint)?.continuationCommand);
        const token = asString(command?.token);
        if (token === null || token.trim() === '') {
            throw malformedItem();
        }
        return token;
    }
    return null;
}

function nextContinuationToken(renderer: Record<string, unknown>): string | null {
    const continuations = asArray(renderer.continuations);
    if (!continuations) {
        return null;
    }
    let token: string | null = null;
    for (const continuation of continuations.slice(0, 8)) {
        const next = asRecord(asRecord(continuation)?.nextContinuationData);
        if (!next) {
            continue;
        }
        const endpointCommand = asRecord(asRecord(next.continuationEndpoint)?.continuationCommand);
        const candidate = asString(next.continuation) ?? asString(endpointCommand?.token);
        if (candidate === null || candidate.trim() === '') {
            throw malformedItem();
        }
        if (token !== null && token !== candidate) {
            throw malformedItem();
        }
        token = candidate;
    }
    return token;
}

const BENIGN_ROW_KEYS = new Set([
    'messageRenderer',
    'infoMessageRenderer',
    'infoMessageViewModel',
    'emptyStateRenderer',
    'emptyStateViewModel',
    'sectionHeaderViewModel',
    'feedNudgeRenderer',
    'promotedSparklesWebRenderer',
]);

function collectItems(items: unknown[], baseIndex: number, acc: ParsedItems, depth: number): void {
    if (depth > 3) {
        throw malformedItem();
    }
    for (const item of items) {
        const rec = asRecord(item);
        if (!rec) {
            throw malformedItem();
        }
        const lockup = asRecord(rec.lockupViewModel);
        if (lockup) {
            const entry = parseLockupEntry(lockup, baseIndex + acc.entries.length);
            if (entry) {
                acc.entries.push(entry);
            }
            continue;
        }
        const legacyVideo = asRecord(rec.playlistVideoRenderer);
        if (legacyVideo) {
            acc.entries.push(parseLegacyVideoEntry(legacyVideo, baseIndex + acc.entries.length));
            continue;
        }
        const legacyList = asRecord(rec.playlistVideoListRenderer);
        if (legacyList) {
            const contents = asArray(legacyList.contents);
            if (!contents) {
                throw malformedItem();
            }
            collectItems(contents, baseIndex, acc, depth + 1);
            const token = nextContinuationToken(legacyList);
            if (token) {
                addContinuationToken(acc, token);
            }
            continue;
        }
        const token = continuationTokenFromItem(rec);
        if (token !== null) {
            addContinuationToken(acc, token);
            continue;
        }
        if (Object.keys(rec).some(key => BENIGN_ROW_KEYS.has(key))) {
            continue;
        }
        throw malformedItem();
    }
}

function parseItemSection(section: Record<string, unknown>, baseIndex: number): ParsedItems {
    const acc: ParsedItems = { entries: [], continuation: null };
    const contents = asArray(section.contents);
    if (!contents) {
        throw malformedItem();
    }
    collectItems(contents, baseIndex, acc, 0);
    return acc;
}

function acceptedTargetId(targetId: string | null, playlistId: string): boolean {
    return targetId === playlistId || targetId === `VL${playlistId}`;
}

export interface InitialPlaylistPage {
    title: string;
    entries: PlaylistEntry[];
    continuation: string | null;
}

export function parseInitialPlaylistResponse(json: unknown, playlistId: string): InitialPlaylistPage {
    const root = asRecord(json);
    if (!root) {
        throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
    }
    throwOnErrorAlerts(root);

    const title = textOf(asRecord(asRecord(root.metadata)?.playlistMetadataRenderer)?.title);

    const contents = asRecord(root.contents);
    const browse = asRecord(contents?.twoColumnBrowseResultsRenderer)
        ?? asRecord(contents?.singleColumnBrowseResultsRenderer);
    const tabs = asArray(browse?.tabs);
    if (!tabs) {
        throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
    }

    let tabContent: Record<string, unknown> | null = null;
    for (const tab of tabs.slice(0, 8)) {
        const tabRenderer = asRecord(asRecord(tab)?.tabRenderer);
        const content = asRecord(tabRenderer?.content);
        if (!content) {
            continue;
        }
        if (tabRenderer?.selected === true) {
            tabContent = content;
            break;
        }
        if (!tabContent) {
            tabContent = content;
        }
    }

    const sectionList = asRecord(tabContent?.sectionListRenderer);
    if (!sectionList) {
        throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
    }
    const sectionListTargetId = asString(sectionList.targetId);
    if (sectionListTargetId !== null && !acceptedTargetId(sectionListTargetId, playlistId)) {
        throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
    }

    const sections = asArray(sectionList.contents);
    if (!sections) {
        throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
    }

    let section: Record<string, unknown> | null = null;
    for (const candidate of sections.slice(0, 16)) {
        const itemSection = asRecord(asRecord(candidate)?.itemSectionRenderer);
        if (!itemSection) {
            continue;
        }
        const targetId = asString(itemSection.targetId);
        if (targetId === playlistId) {
            section = itemSection;
            break;
        }
        if (!section && (targetId === null || acceptedTargetId(targetId, playlistId))) {
            section = itemSection;
        }
    }
    if (!section) {
        throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
    }

    const page = parseItemSection(section, 0);
    return { title, entries: page.entries, continuation: page.continuation };
}

export interface ContinuationPlaylistPage {
    entries: PlaylistEntry[];
    continuation: string | null;
}

export function parseContinuationResponse(
    json: unknown,
    playlistId: string,
    startIndex: number,
): ContinuationPlaylistPage {
    const root = asRecord(json);
    if (!root) {
        throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
    }
    throwOnErrorAlerts(root);

    const acc: ParsedItems = { entries: [], continuation: null };
    let matched = false;

    const actions = asArray(root.onResponseReceivedActions)
        ?? asArray(root.onResponseReceivedEndpoints);
    if (actions) {
        for (const action of actions.slice(0, 16)) {
            const append = asRecord(asRecord(action)?.appendContinuationItemsAction);
            if (!append) {
                continue;
            }
            if (!acceptedTargetId(asString(append.targetId), playlistId)) {
                continue;
            }
            const items = asArray(append.continuationItems);
            if (!items) {
                throw malformedItem();
            }
            matched = true;
            collectItems(items, startIndex, acc, 0);
        }
    }

    const legacy = asRecord(asRecord(root.continuationContents)?.playlistVideoListContinuation);
    if (!matched && legacy) {
        const legacyTargetId = asString(legacy.targetId);
        if (legacyTargetId === null || acceptedTargetId(legacyTargetId, playlistId)) {
            matched = true;
            const contents = asArray(legacy.contents);
            if (!contents) {
                throw malformedItem();
            }
            collectItems(contents, startIndex, acc, 0);
            const token = nextContinuationToken(legacy);
            if (token) {
                addContinuationToken(acc, token);
            }
        }
    }

    if (!matched) {
        throw new PlaylistError('invalid-response', 'Unexpected playlist response.');
    }
    return acc;
}
