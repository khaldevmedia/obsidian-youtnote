import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Note, PluginSettings, Video, VideoId } from '../types';
import type { PlaylistEntry } from '../playlist';

interface EffectSlot {
    cb: () => void | (() => void);
    deps: unknown[] | undefined;
    prevDeps: unknown[] | undefined;
    hasRun: boolean;
    cleanup?: () => void;
}

interface TestHooks {
    values: unknown[];
    cursor: number;
    refs: { current: unknown }[];
    refCursor: number;
    effects: EffectSlot[];
    effectCursor: number;
}

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    const hooks: TestHooks = {
        values: [], cursor: 0,
        refs: [], refCursor: 0,
        effects: [], effectCursor: 0,
    };
    const depsChanged = (slot: EffectSlot) => {
        if (!slot.hasRun) return true;
        const prev = slot.prevDeps;
        const next = slot.deps;
        if (!prev || !next) return true;
        return prev.length !== next.length || next.some((d, i) => !Object.is(d, prev[i]));
    };
    return {
        ...actual,
        __youtnoteTestHooks: hooks,
        __youtnoteDepsChanged: depsChanged,
        useState: <T,>(init: T | (() => T)) => {
            const index = hooks.cursor++;
            if (!(index in hooks.values)) {
                hooks.values[index] = typeof init === 'function' ? (init as () => T)() : init;
            }
            const setValue = (v: T | ((prev: T) => T)) => {
                hooks.values[index] = typeof v === 'function' ? (v as (p: T) => T)(hooks.values[index] as T) : v;
            };
            return [hooks.values[index] as T, setValue];
        },
        useMemo: <T,>(fn: () => T) => fn(),
        useEffect: (cb: () => void | (() => void), deps: unknown[] | undefined) => {
            const index = hooks.effectCursor++;
            const existing = hooks.effects[index];
            if (existing) {
                existing.prevDeps = existing.deps;
                existing.cb = cb;
                existing.deps = deps;
            } else {
                hooks.effects[index] = { cb, deps, prevDeps: undefined, hasRun: false };
            }
        },
        useLayoutEffect: vi.fn(),
        useRef: <T,>(init: T) => {
            const index = hooks.refCursor++;
            if (!(index in hooks.refs)) hooks.refs[index] = { current: init };
            return hooks.refs[index] as { current: T };
        },
        useCallback: <T,>(fn: T) => fn,
    };
});

vi.mock('obsidian', () => ({
    requestUrl: vi.fn(),
    setIcon: vi.fn(),
    Platform: { isMobile: false, isPhone: false, isTablet: false, isDesktop: true },
}));

vi.mock('sortablejs', () => ({
    default: class {
        static create() { return { destroy: vi.fn() }; }
    },
    SortableEvent: class {},
}));

vi.mock('../PlayerAdapter', () => ({
    YouTubeIframeAdapter: class {},
}));

vi.mock('../playback', () => ({
    seekToSelection: vi.fn(),
    PlaybackPositionMemory: class {
        get version() { return 0; }
        isEnabled() { return false; }
        setEnabled() {}
        get() { return undefined; }
        startTracking() {}
        stopTracking() {}
    },
}));

vi.mock('./VideoListItem', () => ({ VideoListItem: () => null }));
vi.mock('./NoteListItem', () => ({ NoteListItem: () => null }));
vi.mock('./TranscriptListItem', () => ({ TranscriptListItem: () => null }));
vi.mock('../ai/registry', () => ({ getAINoteGenerationSetupError: () => null }));
vi.mock('../notices', () => ({ showYoutnoteNotice: vi.fn() }));

const { FakePlaylistImportModal, FakeAlertModal } = vi.hoisted(() => {
    interface ModalOptions {
        videoId?: string | undefined;
        getExistingVideoIds: () => Set<string>;
        isValid: () => boolean;
    }
    class FakePlaylistImportModal {
        static instances: FakePlaylistImportModal[] = [];
        readonly playlistId: string;
        readonly options: ModalOptions;
        opened = false;
        closed = false;
        private settled = false;
        private resolveResult!: (value: unknown) => void;
        readonly result: Promise<unknown>;
        constructor(_app: unknown, playlistId: string, options: ModalOptions) {
            this.playlistId = playlistId;
            this.options = options;
            this.result = new Promise(resolve => { this.resolveResult = resolve; });
            FakePlaylistImportModal.instances.push(this);
        }
        open(): void { this.opened = true; }
        close(): void {
            this.closed = true;
            this.settle(null);
        }
        settle(value: unknown): void {
            if (this.settled) return;
            this.settled = true;
            this.resolveResult(value);
        }
    }
    class FakeAlertModal {
        static opens = 0;
        open() { FakeAlertModal.opens++; }
    }
    return { FakePlaylistImportModal, FakeAlertModal };
});

vi.mock('./PlaylistImportModal', () => ({
    PlaylistImportModal: FakePlaylistImportModal,
}));

vi.mock('./MessageBoxes', () => ({
    AlertModal: FakeAlertModal,
    ConfirmModal: class { open() {} },
    AIGenerationModal: class {},
    MISSING_AI_API_KEY_MESSAGE: 'missing-key',
    showAISetupModal: vi.fn(),
}));

const { YoutubePluginView } = await import('./YoutnoteView');
const { requestUrl } = await import('obsidian');
const mockedRequestUrl = vi.mocked(requestUrl);
const { __youtnoteTestHooks, __youtnoteDepsChanged } = await import('react') as unknown as {
    __youtnoteTestHooks: TestHooks;
    __youtnoteDepsChanged: (slot: EffectSlot) => boolean;
};

const YT_A = 'ytExist1234';
const YT_B = 'ytExist5678';
const YT_NEW = 'ytNewVid901';
const YT_NEW2 = 'ytNewVid902';
const YT_NEW3 = 'ytNewVid903';
const PLAYLIST_ID = 'PLVbEymL-83SyVXXqT7fYX5sEvELvyGjL7';

const VID_A = 'video-a' as VideoId;
const VID_B = 'video-b' as VideoId;

function makeVideo(id: VideoId, ytId: string): Video {
    return { id, url: `https://www.youtube.com/watch?v=${ytId}`, durationSec: 600 };
}

function playlistEntry(key: string, youtubeId: string | null, partial: {
    title?: string;
    thumbnail?: string;
    durationSec?: number;
    available?: boolean;
} = {}): PlaylistEntry {
    const { title = `title-${key}`, thumbnail, durationSec, available = true } = partial;
    const result: PlaylistEntry = { key, youtubeId, title, available };
    if (thumbnail !== undefined) result.thumbnail = thumbnail;
    if (durationSec !== undefined) result.durationSec = durationSec;
    return result;
}

function makeSettings(): PluginSettings {
    return {
        pinOnPhone: false,
        followMobileFullscreen: false,
        autoplayOnNoteSelect: false,
        autoplayOnVideoSelect: false,
        autoplayOnCaptionSelect: false,
        singleExpandMode: true,
        persistExpandedState: false,
        newLineTrigger: 'shift+enter',
        openExportedFile: true,
        showNoteStats: true,
        switchToNotesAfterTranscriptNote: false,
        autoScrollTranscript: true,
        rememberPlaybackPosition: true,
        exportIncludeNotes: true,
        exportIncludeTranscripts: true,
        uriSchemeEnabled: false,
        ai: {
            enabled: false,
            provider: 'none',
            secretNames: { openai: '', anthropic: '', google: '', custom: '' },
            models: { openai: '', anthropic: '', google: '', custom: '' },
            availableModels: { openai: [], anthropic: [], google: [], custom: [] },
            customBaseUrl: '',
            hostedTimeoutSeconds: 120,
            customTimeoutSeconds: 300,
        },
    };
}

interface ViewProps {
    videos: Video[];
    notes: Note[];
    activeVideoId: VideoId | null;
    settings: PluginSettings;
    app: { loadLocalStorage: () => null };
    view: { getMutationGuard: () => () => boolean; videos: Video[]; notes: Note[] };
    readOnly: boolean;
    setActiveVideoId: ReturnType<typeof vi.fn>;
    onUpdateVideos: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
}

let guardValid = true;

function makeProps(overrides: {
    videos?: Video[];
    readOnly?: boolean;
} = {}): ViewProps {
    const videos = overrides.videos ?? [makeVideo(VID_A, YT_A), makeVideo(VID_B, YT_B)];
    return {
        videos,
        notes: [],
        activeVideoId: VID_A,
        settings: makeSettings(),
        app: { loadLocalStorage: () => null },
        view: { getMutationGuard: () => () => guardValid, videos, notes: [] },
        videoTaskState: { transcriptPhase: null, aiPhase: null },
        videoSelectionRequest: null,
        setActiveVideoId: vi.fn(),
        onUpdateVideos: vi.fn(),
        onUpdateNotes: vi.fn(),
        onExportSingleVideo: vi.fn(),
        onExportAllVideos: vi.fn(),
        onFetchTranscript: vi.fn(),
        onGenerateAINotes: vi.fn(),
        onCancelVideoTasks: vi.fn(),
        onOpenAISettings: vi.fn(),
        readOnly: overrides.readOnly ?? false,
        canConvert: false,
        conversionPending: false,
        onRequestConversion: vi.fn(),
    };
}

interface VNodeLike {
    type?: unknown;
    props?: Record<string, unknown> & { children?: unknown };
}

function findByClass(node: unknown, cls: string): VNodeLike | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findByClass(child, cls);
            if (found) return found;
        }
        return null;
    }
    if (!node || typeof node !== 'object') return null;
    const vnode = node as VNodeLike;
    const className = vnode.props?.className;
    if (typeof className === 'string' && className.split(/\s+/).includes(cls)) {
        return vnode;
    }
    const children = vnode.props?.children;
    if (children !== undefined) return findByClass(children, cls);
    return null;
}

function fireHandler(vnode: VNodeLike | null, name: string, arg?: unknown): void {
    expect(vnode).not.toBeNull();
    const handler = vnode!.props?.[name];
    expect(typeof handler).toBe('function');
    (handler as (a: unknown) => void)(arg);
}

function fireOptional(vnode: VNodeLike | null, name: string, arg?: unknown): void {
    const handler = vnode?.props?.[name];
    if (typeof handler === 'function') {
        (handler as (a: unknown) => void)(arg);
    }
}

function hooks(): TestHooks {
    return __youtnoteTestHooks;
}

function resetCursors() {
    hooks().cursor = 0;
    hooks().refCursor = 0;
    hooks().effectCursor = 0;
}

function runEffects() {
    for (const slot of hooks().effects) {
        if (!slot) continue;
        if (!__youtnoteDepsChanged(slot)) continue;
        slot.cleanup?.();
        slot.hasRun = true;
        slot.prevDeps = slot.deps;
        const cleanup = slot.cb();
        if (typeof cleanup === 'function') {
            slot.cleanup = cleanup;
        } else {
            delete slot.cleanup;
        }
    }
}

interface Mounted {
    props: ViewProps;
    rerender(overrides?: Partial<ViewProps>): void;
    unmount(): void;
}

let lastTree: unknown = null;

function mount(props: ViewProps): Mounted {
    resetCursors();
    lastTree = (YoutubePluginView as unknown as (p: unknown) => unknown)(props);
    runEffects();
    return {
        props,
        rerender(overrides = {}) {
            Object.assign(props, overrides);
            props.view.videos = props.videos;
            resetCursors();
            lastTree = (YoutubePluginView as unknown as (p: unknown) => unknown)(props);
            runEffects();
        },
        unmount() {
            for (const slot of hooks().effects) {
                if (slot?.hasRun) slot.cleanup?.();
            }
        },
    };
}

async function tick(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
    }
}

function lastModal(): InstanceType<typeof FakePlaylistImportModal> {
    const modal = FakePlaylistImportModal.instances[FakePlaylistImportModal.instances.length - 1];
    expect(modal).toBeDefined();
    return modal;
}

function submitUrl(mounted: Mounted, url: string): void {
    const input = findByClass(lastTree, 'youtnote-plugin__add-video-input');
    const event = { target: { value: url } };
    fireOptional(input, 'oninput', event);
    fireOptional(input, 'onInput', event);
    fireOptional(input, 'onChange', event);
    mounted.rerender({});
    const form = findByClass(lastTree, 'youtnote-plugin__add-video-form');
    fireHandler(form, 'onSubmit', { preventDefault: () => {} });
}

function inputValue(): unknown {
    return findByClass(lastTree, 'youtnote-plugin__add-video-input')?.props?.value;
}

beforeEach(() => {
    FakePlaylistImportModal.instances.length = 0;
    FakeAlertModal.opens = 0;
    guardValid = true;
    mockedRequestUrl.mockReset();
    hooks().values.length = 0;
    hooks().refs.length = 0;
    hooks().effects.length = 0;
    lastTree = null;
    vi.stubGlobal('window', {
        setTimeout: vi.fn(() => 0),
        clearTimeout: vi.fn(),
    });
    vi.stubGlobal('activeDocument', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });
});

describe('playlist import integration', () => {
    it('opens the import modal for a playlist-only url and appends selected entries in order', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        expect(FakePlaylistImportModal.instances).toHaveLength(1);
        const modal = lastModal();
        expect(modal.playlistId).toBe(PLAYLIST_ID);
        expect(modal.options.videoId).toBeUndefined();
        expect(modal.opened).toBe(true);
        expect(FakeAlertModal.opens).toBe(0);

        modal.settle([
            playlistEntry('i0', YT_NEW, { title: 'first', durationSec: 61 }),
            playlistEntry('i1', YT_NEW2, { title: 'second' }),
            playlistEntry('i2', null, { available: false, title: 'gone' }),
            playlistEntry('i3', YT_A, { title: 'existing' }),
        ]);
        await tick();
        const updates = mounted.props.onUpdateVideos.mock.calls;
        expect(updates).toHaveLength(1);
        const next = updates[0][0] as Video[];
        expect(next).toHaveLength(4);
        expect(next[0].id).toBe(VID_A);
        expect(next[1].id).toBe(VID_B);
        const added = next.slice(2);
        expect(added.map(v => v.url)).toEqual([
            `https://www.youtube.com/watch?v=${YT_NEW}`,
            `https://www.youtube.com/watch?v=${YT_NEW2}`,
        ]);
        expect(added[0].title).toBe('first');
        expect(added[0].durationSec).toBe(61);
        expect(added[1].thumbnail).toBe(`https://img.youtube.com/vi/${YT_NEW2}/default.jpg`);
        const selectCalls = mounted.props.setActiveVideoId.mock.calls;
        expect(selectCalls.length).toBeGreaterThan(0);
        expect(selectCalls[selectCalls.length - 1]).toEqual([added[0].id]);
        mounted.rerender({});
        expect(inputValue()).toBe('');
        expect(mockedRequestUrl).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('offers the choice before duplicate handling for a combined watch+list url', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/watch?v=${YT_A}&list=${PLAYLIST_ID}`);
        await tick();
        const modal = lastModal();
        expect(modal.options.videoId).toBe(YT_A);
        expect(FakeAlertModal.opens).toBe(0);
        expect(mockedRequestUrl).not.toHaveBeenCalled();

        modal.settle('video');
        await tick();
        expect(FakeAlertModal.opens).toBe(1);
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        expect(mockedRequestUrl).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('keeps the single-video flow for the video choice of a combined url', async () => {
        mockedRequestUrl.mockResolvedValue({ status: 200, json: { title: 'meta', thumbnail_url: 'https://img.example/t.jpg' } } as never);
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://youtu.be/${YT_NEW}?list=${PLAYLIST_ID}`);
        await tick();
        lastModal().settle('video');
        await tick(30);
        expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
        const requested = mockedRequestUrl.mock.calls[0][0] as { url: string };
        expect(requested.url).toContain('oembed');
        const updates = mounted.props.onUpdateVideos.mock.calls;
        expect(updates).toHaveLength(1);
        const next = updates[0][0] as Video[];
        const added = next[next.length - 1];
        expect(added.url).toBe(`https://www.youtube.com/watch?v=${YT_NEW}`);
        expect(added.title).toBe('meta');
        mounted.unmount();
    });

    it('does not mutate anything when the modal is cancelled', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        lastModal().close();
        await tick();
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        expect(mockedRequestUrl).not.toHaveBeenCalled();
        mounted.rerender({});
        expect(inputValue()).toBe(`https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        mounted.unmount();
    });

    it('blocks the commit when the mutation guard is stale', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        guardValid = false;
        lastModal().settle([playlistEntry('i0', YT_NEW)]);
        await tick();
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('closes the modal when the view becomes read-only', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        const modal = lastModal();
        mounted.rerender({ readOnly: true });
        await tick();
        expect(modal.closed).toBe(true);
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('closes the modal on unmount and ignores the late result', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        const modal = lastModal();
        mounted.unmount();
        expect(modal.closed).toBe(true);
        modal.settle([playlistEntry('i0', YT_NEW)]);
        await tick();
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
    });

    it('dedupes against the latest view videos that arrived while the modal was open', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        mounted.props.view.videos.push(makeVideo('video-c' as VideoId, YT_NEW));
        lastModal().settle([
            playlistEntry('i0', YT_NEW),
            playlistEntry('i1', YT_NEW2),
        ]);
        await tick();
        const next = mounted.props.onUpdateVideos.mock.calls[0][0] as Video[];
        expect(next).toHaveLength(4);
        expect(next.map(v => v.url)).toContain(`https://www.youtube.com/watch?v=${YT_NEW2}`);
        expect(next.filter(v => v.url === `https://www.youtube.com/watch?v=${YT_NEW}`)).toHaveLength(1);
        mounted.unmount();
    });

    it('dedupes repeated source entries inside the playlist', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        lastModal().settle([
            playlistEntry('i0', YT_NEW),
            playlistEntry('i1', YT_NEW2),
            playlistEntry('i2', YT_NEW3),
            playlistEntry('i3', YT_NEW),
        ]);
        await tick();
        const next = mounted.props.onUpdateVideos.mock.calls[0][0] as Video[];
        expect(next).toHaveLength(5);
        expect(next.filter(v => v.url === `https://www.youtube.com/watch?v=${YT_NEW}`)).toHaveLength(1);
        mounted.unmount();
    });

    it('ignores a rapid second submit while the first modal is open', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        const form = findByClass(lastTree, 'youtnote-plugin__add-video-form');
        fireHandler(form, 'onSubmit', { preventDefault: () => {} });
        await tick();
        expect(FakePlaylistImportModal.instances).toHaveLength(1);
        lastModal().close();
        await tick();
        mounted.unmount();
    });

    it('keeps existing video objects untouched when appending', async () => {
        const original = makeVideo(VID_A, YT_A);
        original.title = 'Kept';
        const mounted = mount(makeProps({ videos: [original, makeVideo(VID_B, YT_B)] }));
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        lastModal().settle([playlistEntry('i0', YT_NEW)]);
        await tick();
        const next = mounted.props.onUpdateVideos.mock.calls[0][0] as Video[];
        expect(next[0]).toBe(original);
        expect(next[0].title).toBe('Kept');
        mounted.unmount();
    });

    it('does not select the duplicate video when the guard is stale by the deferred callback', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/watch?v=${YT_A}`);
        await tick();
        expect(FakeAlertModal.opens).toBe(1);
        const timerCalls = (window.setTimeout as unknown as ReturnType<typeof vi.fn>).mock.calls;
        const selectTimer = timerCalls.find(call => call[1] === 100);
        expect(selectTimer).toBeDefined();
        guardValid = false;
        (selectTimer![0] as () => void)();
        expect(mounted.props.setActiveVideoId).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('suppresses the failure alert when a single-video request rejects after guard invalidation', async () => {
        const deferred: { reject?: (reason: unknown) => void } = {};
        mockedRequestUrl.mockImplementation((() => new Promise<never>((_resolve, reject) => {
            deferred.reject = reject;
        })) as never);
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/watch?v=${YT_NEW}`);
        await tick();
        guardValid = false;
        deferred.reject?.(new Error('network down'));
        await tick(20);
        expect(FakeAlertModal.opens).toBe(0);
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('skips selected entries whose youtube id is not a valid video id', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        lastModal().settle([
            playlistEntry('i0', 'bad-id'),
            playlistEntry('i1', YT_NEW),
        ]);
        await tick();
        const next = mounted.props.onUpdateVideos.mock.calls[0][0] as Video[];
        expect(next).toHaveLength(3);
        expect(next[2].url).toBe(`https://www.youtube.com/watch?v=${YT_NEW}`);
        mounted.unmount();
    });

    it('does not start any request when the guard is already stale at submit', async () => {
        const mounted = mount(makeProps());
        const input = findByClass(lastTree, 'youtnote-plugin__add-video-input');
        const event = { target: { value: `https://www.youtube.com/playlist?list=${PLAYLIST_ID}` } };
        fireOptional(input, 'oninput', event);
        fireOptional(input, 'onInput', event);
        fireOptional(input, 'onChange', event);
        mounted.rerender({});
        guardValid = false;
        const form = findByClass(lastTree, 'youtnote-plugin__add-video-form');
        fireHandler(form, 'onSubmit', { preventDefault: () => {} });
        await tick();
        expect(FakePlaylistImportModal.instances).toHaveLength(0);
        expect(mockedRequestUrl).not.toHaveBeenCalled();
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('re-enables the form on the same mounted instance after a stale modal completes', async () => {
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        const modal = lastModal();
        guardValid = false;
        modal.close();
        await tick();
        guardValid = true;
        mounted.rerender({});
        const input = findByClass(lastTree, 'youtnote-plugin__add-video-input');
        expect(input?.props?.disabled).toBe(false);
        submitUrl(mounted, `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
        await tick();
        expect(FakePlaylistImportModal.instances).toHaveLength(2);
        lastModal().close();
        await tick();
        mounted.unmount();
    });

    it('does nothing when a single-video request rejects after unmount', async () => {
        const deferred: { reject?: (reason: unknown) => void } = {};
        mockedRequestUrl.mockImplementation((() => new Promise<never>((_resolve, reject) => {
            deferred.reject = reject;
        })) as never);
        const mounted = mount(makeProps());
        submitUrl(mounted, `https://www.youtube.com/watch?v=${YT_NEW}`);
        await tick();
        mounted.unmount();
        deferred.reject?.(new Error('network down'));
        await tick(20);
        expect(FakeAlertModal.opens).toBe(0);
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        expect(mounted.props.setActiveVideoId).not.toHaveBeenCalled();
    });
});
