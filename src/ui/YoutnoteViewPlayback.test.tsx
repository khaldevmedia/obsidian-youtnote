import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlaybackPositionMemory } from '../playback';
import type { Note, PluginSettings, Video, VideoId, VideoSelectionRequest, VideoSelectionSource } from '../types';

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

vi.mock('./VideoListItem', () => ({ VideoListItem: () => null }));
vi.mock('./NoteListItem', () => ({ NoteListItem: () => null }));
vi.mock('./TranscriptListItem', () => ({ TranscriptListItem: () => null }));
vi.mock('../ai/registry', () => ({ getAINoteGenerationSetupError: () => null }));
vi.mock('../notices', () => ({ showYoutnoteNotice: vi.fn() }));

vi.mock('./MessageBoxes', () => {
    class FakeAlertModal {
        static opens = 0;
        open() { FakeAlertModal.opens++; }
    }
    return {
        AlertModal: FakeAlertModal,
        ConfirmModal: class { open() {} },
        AIGenerationModal: class {},
        MISSING_AI_API_KEY_MESSAGE: 'missing-key',
        showAISetupModal: vi.fn(),
    };
});

const { AlertModal: MockAlertModal } = await import('./MessageBoxes') as unknown as {
    AlertModal: { opens: number };
};

class FakeAdapter {
    static instances: FakeAdapter[] = [];

    iframe: unknown;
    videoId: string;
    ready = false;
    destroyed = false;
    currentTime = 0;
    duration = 0;
    playerState = 2;
    listeners = new Set<(t: number) => void>();
    pendingLoads: { videoId: string; resolve: () => void; reject: (e: unknown) => void }[] = [];
    private onReady: () => void;
    private onError: ((code: number) => void) | undefined;

    loadVideo = vi.fn((videoId: string) => {
        this.videoId = videoId;
        this.ready = false;
        this.currentTime = 0;
        this.emitTime(0);
        return new Promise<void>((resolve, reject) => {
            this.pendingLoads.push({ videoId, resolve, reject });
        });
    });
    seek = vi.fn(async (time: number) => { this.currentTime = time; });
    seekAndPause = vi.fn(async (time: number, _isValid?: () => boolean) => { this.currentTime = time; this.playerState = 2; });
    play = vi.fn(async () => {});
    pause = vi.fn(async () => {});
    getCurrentTime = vi.fn(async () => this.currentTime);
    getDuration = vi.fn(async () => this.duration);
    getPlayerState = vi.fn(async () => this.playerState);

    constructor(iframe: unknown, videoId: string, onReady: () => void, onError?: (code: number) => void) {
        this.iframe = iframe;
        this.videoId = videoId;
        this.onReady = onReady;
        this.onError = onError;
        FakeAdapter.instances.push(this);
    }

    isReady() { return this.ready && !this.destroyed; }
    destroy() { this.destroyed = true; this.listeners.clear(); }
    subscribeToTimeUpdates(listener: (t: number) => void) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    simulateReady() {
        this.ready = true;
        this.onReady();
    }
    simulateError(code: number) { this.onError?.(code); }
    emitTime(time: number) {
        this.currentTime = time;
        this.listeners.forEach(l => l(time));
    }
    resolveLoad(videoId: string) {
        const idx = this.pendingLoads.findIndex(l => l.videoId === videoId);
        if (idx === -1) throw new Error(`no pending load for ${videoId}`);
        const [load] = this.pendingLoads.splice(idx, 1);
        this.ready = true;
        load.resolve();
    }
    rejectLoad(videoId: string, error: unknown) {
        const idx = this.pendingLoads.findIndex(l => l.videoId === videoId);
        if (idx === -1) throw new Error(`no pending load for ${videoId}`);
        const [load] = this.pendingLoads.splice(idx, 1);
        this.ready = true;
        load.reject(error);
    }
}

vi.mock('../PlayerAdapter', () => ({ YouTubeIframeAdapter: FakeAdapter }));

const { YoutubePluginView } = await import('./YoutnoteView');
const { __youtnoteTestHooks, __youtnoteDepsChanged } = await import('react') as unknown as {
    __youtnoteTestHooks: TestHooks;
    __youtnoteDepsChanged: (slot: EffectSlot) => boolean;
};

const YT_A = 'ytA12345678';
const YT_B = 'ytB12345678';
const YT_C = 'ytC12345678';

const VID_A = 'video-a' as VideoId;
const VID_A2 = 'video-a-reparsed' as VideoId;
const VID_B = 'video-b' as VideoId;
const VID_C = 'video-c' as VideoId;

function makeVideo(id: VideoId, ytId: string): Video {
    return { id, url: `https://www.youtube.com/watch?v=${ytId}`, durationSec: 600 };
}

function makeSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
    return {
        pinOnPhone: false,
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
        ...overrides,
    };
}

interface ViewProps {
    videos: Video[];
    notes: Note[];
    activeVideoId: VideoId | null;
    settings: PluginSettings;
    app: { loadLocalStorage: () => null };
    view: { getMutationGuard: () => () => boolean; videos: Video[]; notes: Note[] };
    [key: string]: unknown;
}

function makeProps(overrides: {
    videos?: Video[];
    activeVideoId?: VideoId | null;
    settings?: PluginSettings;
    readOnly?: boolean;
} = {}): ViewProps {
    const videos = overrides.videos ?? [makeVideo(VID_A, YT_A), makeVideo(VID_B, YT_B)];
    return {
        videos,
        notes: [],
        activeVideoId: overrides.activeVideoId === undefined ? VID_A : overrides.activeVideoId,
        settings: overrides.settings ?? makeSettings(),
        app: { loadLocalStorage: () => null },
        view: { getMutationGuard: () => () => true, videos, notes: [] },
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
    ref?: { current: unknown } | null;
    props?: Record<string, unknown> & { children?: unknown; ref?: { current: unknown } | null };
}

function findIframeRef(node: unknown): { current: unknown } | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findIframeRef(child);
            if (found) return found;
        }
        return null;
    }
    if (!node || typeof node !== 'object') return null;
    const vnode = node as VNodeLike;
    if (vnode.type === 'iframe') {
        const ref = vnode.ref ?? vnode.props?.ref ?? null;
        if (ref) return ref;
    }
    const children = vnode.props?.children;
    if (children !== undefined) return findIframeRef(children);
    return null;
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
    memory(): PlaybackPositionMemory;
}

let lastTree: unknown = null;

function walkVNodes(node: unknown, visit: (vnode: VNodeLike) => void) {
    if (Array.isArray(node)) {
        for (const child of node) walkVNodes(child, visit);
        return;
    }
    if (!node || typeof node !== 'object') return;
    const vnode = node as VNodeLike;
    visit(vnode);
    const children = vnode.props?.children;
    if (children !== undefined) walkVNodes(children, visit);
}

function mount(props: ViewProps): Mounted {
    resetCursors();
    lastTree = (YoutubePluginView as unknown as (p: unknown) => unknown)(props);
    const iframeRef = findIframeRef(lastTree);
    if (iframeRef) iframeRef.current = { fakeIframe: true };
    runEffects();
    const mounted: Mounted = {
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
        memory() {
            for (const ref of hooks().refs) {
                if (ref.current instanceof PlaybackPositionMemory) return ref.current;
            }
            throw new Error('playback memory ref not found');
        },
    };
    return mounted;
}

async function tick(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
    }
}

async function switchTo(mounted: Mounted, videoId: VideoId): Promise<void> {
    mounted.rerender({ activeVideoId: videoId });
    await tick();
}

function lastAdapter(): FakeAdapter {
    const adapter = FakeAdapter.instances[FakeAdapter.instances.length - 1];
    expect(adapter).toBeDefined();
    return adapter;
}

beforeEach(() => {
    FakeAdapter.instances.length = 0;
    hooks().values.length = 0;
    hooks().refs.length = 0;
    hooks().effects.length = 0;
    MockAlertModal.opens = 0;
    vi.stubGlobal('window', {
        setTimeout: vi.fn(() => 0),
        clearTimeout: vi.fn(),
    });
    vi.stubGlobal('activeDocument', {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });
});

async function mountWithAdapterLoaded(
    settings = makeSettings(),
    videos = [makeVideo(VID_A, YT_A), makeVideo(VID_B, YT_B)],
    activeVideoId: VideoId | null = VID_A,
) {
    const mounted = mount(makeProps({ settings, videos, activeVideoId }));
    const adapter = lastAdapter();
    adapter.simulateReady();
    await tick();
    adapter.resolveLoad(adapter.videoId);
    await tick();
    return { mounted, adapter };
}

describe('remember playback position - disabled', () => {
    it('does not save or restore positions when the setting is off', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(makeSettings({ rememberPlaybackPosition: false }));
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        adapter.emitTime(45);
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).not.toHaveBeenCalled();
        expect(mounted.memory().get(YT_A)).toBeUndefined();
        mounted.unmount();
    });
});

describe('remember playback position - enabled', () => {
    it.each([1, 2])('restores the exact latest position paused when returning to a video (playerState=%i)', async (state) => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.playerState = state;
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        adapter.emitTime(45);
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).toHaveBeenCalledWith(120, expect.any(Function));
        expect(mounted.memory().get(YT_B)).toBe(45);
        mounted.unmount();
    });

    it('backward seeks replace the older saved time', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(200);
        adapter.emitTime(50);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        expect(mounted.memory().get(YT_A)).toBe(50);
        mounted.unmount();
    });

    it('a genuine zero reached while tracked replaces the remembered position', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).toHaveBeenCalledWith(120, expect.any(Function));
        adapter.emitTime(0);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        expect(mounted.memory().get(YT_A)).toBe(0);
        adapter.seekAndPause.mockClear();
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('the load-time reset emission cannot erase a remembered position', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        expect(adapter.loadVideo).toHaveBeenCalledWith(YT_B);
        adapter.resolveLoad(YT_B);
        await tick();
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(mounted.memory().get(YT_A)).toBe(120);
        mounted.unmount();
    });

    it('keeps a completed video at its duration even when the last delivery fell short', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.duration = 600;
        adapter.playerState = 0;
        adapter.emitTime(595);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).toHaveBeenCalledWith(600, expect.any(Function));
        mounted.unmount();
    });

    it('clamps the remembered position to the duration the adapter reports at restore', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(550);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        adapter.duration = 100;
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).toHaveBeenCalledWith(100, expect.any(Function));
        mounted.unmount();
    });

    it('starts a never-watched video at zero', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.seekAndPause).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('applies to videos added later through the same effect path', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(75);
        const videos = [...mounted.props.videos, makeVideo(VID_C, YT_C)];
        mounted.rerender({ videos, activeVideoId: VID_C });
        await tick();
        adapter.resolveLoad(YT_C);
        await tick();
        expect(adapter.loadVideo).toHaveBeenCalledWith(YT_C);
        expect(mounted.memory().get(YT_A)).toBe(75);
        mounted.unmount();
    });

    it('survives the video id changing when the youtube id stays the same', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(120);
        const reparseVideos = [makeVideo(VID_A2, YT_A), makeVideo(VID_B, YT_B)];
        mounted.rerender({ videos: reparseVideos, activeVideoId: VID_B });
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        mounted.rerender({ activeVideoId: VID_A2 });
        await tick();
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).toHaveBeenCalledWith(120, expect.any(Function));
        mounted.unmount();
    });

    it('a failed load retains the remembered position of that video', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(90);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        adapter.emitTime(30);
        await switchTo(mounted, VID_A);
        adapter.rejectLoad(YT_A, new Error('5'));
        await tick();
        expect(mounted.memory().get(YT_A)).toBe(90);
        expect(mounted.memory().get(YT_B)).toBe(30);
        mounted.unmount();
    });

    it('rapid A-B-C switching destroys the stale adapter and only restores the final selection', async () => {
        const { mounted } = await mountWithAdapterLoaded(undefined, [
            makeVideo(VID_A, YT_A),
            makeVideo(VID_B, YT_B),
            makeVideo(VID_C, YT_C),
        ]);
        const adapter1 = lastAdapter();
        adapter1.emitTime(10);
        mounted.rerender({ activeVideoId: VID_B });
        await tick();
        expect(adapter1.loadVideo).toHaveBeenCalledWith(YT_B);
        mounted.rerender({ activeVideoId: VID_C });
        await tick();
        expect(adapter1.destroyed).toBe(true);
        const adapter2 = lastAdapter();
        expect(adapter2).not.toBe(adapter1);
        adapter2.simulateReady();
        await tick();
        adapter2.resolveLoad(YT_C);
        await tick();
        adapter1.resolveLoad(YT_B);
        await tick();
        expect(adapter1.seekAndPause).not.toHaveBeenCalled();
        expect(adapter1.listeners.size).toBe(0);
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        expect(adapter2.listeners.size).toBe(1);
        await switchTo(mounted, VID_A);
        adapter2.resolveLoad(YT_A);
        await tick();
        expect(adapter2.seekAndPause).toHaveBeenCalledWith(10, expect.any(Function));
        mounted.unmount();
    });
});

describe('remember playback position - setting toggling', () => {
    it('disabling clears positions and tracking without reloading', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(120);
        const loadCalls = adapter.loadVideo.mock.calls.length;
        const settings = { ...mounted.props.settings, rememberPlaybackPosition: false };
        mounted.rerender({ settings });
        await tick();
        expect(adapter.listeners.size).toBe(0);
        expect(mounted.memory().get(YT_A)).toBeUndefined();
        expect(adapter.loadVideo.mock.calls.length).toBe(loadCalls);
        expect(adapter.destroyed).toBe(false);
        expect(adapter.seekAndPause).not.toHaveBeenCalled();

        const reenabled = { ...settings, rememberPlaybackPosition: true };
        mounted.rerender({ settings: reenabled });
        await tick();
        expect(adapter.listeners.size).toBe(1);
        expect(adapter.seekAndPause).not.toHaveBeenCalled();
        adapter.emitTime(55);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).toHaveBeenCalledWith(55, expect.any(Function));
        mounted.unmount();
    });

    it('disabling then re-enabling during a pending restore drops the stale target', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        adapter.emitTime(40);
        adapter.duration = 600;
        adapter.seekAndPause.mockImplementation(async () => new Promise<void>(() => {}));
        mounted.rerender({ activeVideoId: VID_A });
        await tick();
        adapter.resolveLoad(YT_A);
        await tick();
        mounted.rerender({ settings: { ...mounted.props.settings, rememberPlaybackPosition: false } });
        await tick();
        mounted.rerender({ settings: { ...mounted.props.settings, rememberPlaybackPosition: true } });
        await tick();
        expect(mounted.memory().get(YT_A)).not.toBe(120);
        expect(adapter.listeners.size).toBe(1);
        adapter.emitTime(61);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        await switchTo(mounted, VID_A);
        adapter.resolveLoad(YT_A);
        await tick();
        expect(mounted.memory().get(YT_A)).toBe(61);
        mounted.unmount();
    });

    it('enabling during a pending load tracks only once the load confirms', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(makeSettings({ rememberPlaybackPosition: false }));
        mounted.rerender({ activeVideoId: VID_B });
        await tick();
        mounted.rerender({ settings: { ...mounted.props.settings, rememberPlaybackPosition: true } });
        await tick();
        expect(adapter.listeners.size).toBe(0);
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.listeners.size).toBe(1);
        mounted.unmount();
    });

    it('enabling after a failed load does not track the unconfirmed adapter', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(makeSettings({ rememberPlaybackPosition: false }));
        mounted.rerender({ activeVideoId: VID_B });
        await tick();
        adapter.rejectLoad(YT_B, new Error('5'));
        await tick();
        mounted.rerender({ settings: { ...mounted.props.settings, rememberPlaybackPosition: true } });
        await tick();
        expect(adapter.isReady()).toBe(true);
        expect(adapter.listeners.size).toBe(0);
        mounted.unmount();
    });
});

describe('remember playback position - lifecycle', () => {
    it('unmount and remount resets the session memory', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        mounted.unmount();
        expect(adapter.destroyed).toBe(true);

        hooks().values.length = 0;
        hooks().refs.length = 0;
        hooks().effects.length = 0;
        FakeAdapter.instances.length = 0;

        const remounted = mount(makeProps());
        const adapter2 = lastAdapter();
        adapter2.simulateReady();
        await tick();
        adapter2.resolveLoad(adapter2.videoId);
        await tick();
        expect(remounted.memory().get(YT_A)).not.toBe(120);
        expect(adapter2.seekAndPause).not.toHaveBeenCalled();
        adapter2.emitTime(400);
        await switchTo(remounted, VID_B);
        adapter2.resolveLoad(YT_B);
        await tick();
        adapter2.seekAndPause.mockClear();
        await switchTo(remounted, VID_A);
        adapter2.resolveLoad(YT_A);
        await tick();
        expect(adapter2.seekAndPause).toHaveBeenCalledWith(400, expect.any(Function));
        remounted.unmount();
    });

    it('an adapter load resolving after unmount is inert', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded();
        mounted.rerender({ activeVideoId: VID_B });
        await tick();
        mounted.unmount();
        expect(adapter.destroyed).toBe(true);
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.seekAndPause).not.toHaveBeenCalled();
        expect(adapter.listeners.size).toBe(0);
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
    });
});

const { VideoListItem: MockVideoListItem } = await import('./VideoListItem') as unknown as {
    VideoListItem: unknown;
};

let selectionSeq = 0;

function applySelection(mounted: Mounted, id: VideoId | null, source: VideoSelectionSource = 'automatic'): VideoSelectionRequest {
    const request: VideoSelectionRequest = { id, source, sequence: ++selectionSeq };
    mounted.rerender({ activeVideoId: id, videoSelectionRequest: request });
    return request;
}

function videoListItemProps(id: VideoId): Record<string, unknown> | null {
    let found: Record<string, unknown> | null = null;
    walkVNodes(lastTree, vnode => {
        if (found || vnode.type !== MockVideoListItem || !vnode.props) return;
        const video = vnode.props.video as { id: VideoId } | undefined;
        if (video?.id === id) found = vnode.props;
    });
    return found;
}

function selectFromList(mounted: Mounted, id: VideoId) {
    const item = videoListItemProps(id);
    expect(item).not.toBeNull();
    const onSelect = item!.onSelect as (id: VideoId) => void;
    onSelect(id);
    const spy = mounted.props.setActiveVideoId as ReturnType<typeof vi.fn>;
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1] as [VideoId, VideoSelectionSource?] | undefined;
    expect(lastCall).toBeDefined();
    applySelection(mounted, lastCall![0], lastCall![1] ?? 'automatic');
}

describe('autoplay on video select', () => {
    const AUTOPLAY_ON = () => makeSettings({ autoplayOnVideoSelect: true });

    it('does not play on a manual selection when the setting is off', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(makeSettings());
        selectFromList(mounted, VID_B);
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(mounted.props.setActiveVideoId).toHaveBeenCalledWith(VID_B, 'manual');
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('plays after a manual video-list selection when enabled', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        expect(adapter.play).not.toHaveBeenCalled();
        selectFromList(mounted, VID_B);
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).toHaveBeenCalledTimes(1);
        mounted.unmount();
    });

    it('restores the remembered position before playing', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        adapter.emitTime(45);
        let finishRestore: (() => void) | undefined;
        adapter.seekAndPause.mockImplementationOnce(async (time: number) => {
            await new Promise<void>(resolve => { finishRestore = resolve; });
            adapter.currentTime = time;
            adapter.playerState = 2;
        });
        selectFromList(mounted, VID_A);
        await tick();
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).toHaveBeenCalledWith(120, expect.any(Function));
        expect(finishRestore).toBeDefined();
        expect(adapter.play).not.toHaveBeenCalled();
        finishRestore!();
        await tick();
        expect(adapter.play).toHaveBeenCalledTimes(1);
        mounted.unmount();
    });

    it('never plays for automatic selections including added and URI-targeted videos', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        applySelection(mounted, VID_B, 'automatic');
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        const videos = [...mounted.props.videos, makeVideo(VID_C, YT_C)];
        mounted.rerender({ videos });
        applySelection(mounted, VID_C, 'automatic');
        await tick();
        adapter.resolveLoad(YT_C);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('does not play on the initial automatic selection', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('does not play for the automatic fallback after deletion', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        mounted.rerender({ videos: [makeVideo(VID_B, YT_B)] });
        applySelection(mounted, VID_B, 'automatic');
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('re-selecting the already active video does not call the setter or play', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        const item = videoListItemProps(VID_A);
        expect(item).not.toBeNull();
        (item!.onSelect as (id: VideoId) => void)(VID_A);
        await tick();
        expect(mounted.props.setActiveVideoId).not.toHaveBeenCalled();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('a later automatic selection cancels a pending manual autoplay', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON(), [
            makeVideo(VID_A, YT_A),
            makeVideo(VID_B, YT_B),
            makeVideo(VID_C, YT_C),
        ]);
        applySelection(mounted, VID_B, 'manual');
        await tick();
        applySelection(mounted, VID_C, 'automatic');
        await tick();
        expect(adapter.destroyed).toBe(true);
        const adapter2 = lastAdapter();
        expect(adapter2).not.toBe(adapter);
        adapter2.simulateReady();
        await tick();
        adapter2.resolveLoad(YT_C);
        await tick();
        expect(adapter2.play).not.toHaveBeenCalled();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('an automatic request for the same video cancels a pending manual autoplay', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        applySelection(mounted, VID_B, 'manual');
        await tick();
        applySelection(mounted, VID_B, 'automatic');
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('disabling the setting during a pending load cancels autoplay even when re-enabled', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        applySelection(mounted, VID_B, 'manual');
        await tick();
        mounted.rerender({ settings: { ...mounted.props.settings, autoplayOnVideoSelect: false } });
        mounted.rerender({ settings: { ...mounted.props.settings, autoplayOnVideoSelect: true } });
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('enabling the setting after an automatic selection does not autoplay', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(makeSettings());
        applySelection(mounted, VID_B, 'automatic');
        await tick();
        mounted.rerender({ settings: { ...mounted.props.settings, autoplayOnVideoSelect: true } });
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('plays on the fresh not-ready adapter path after ready and load', async () => {
        const mounted = mount(makeProps({ settings: AUTOPLAY_ON() }));
        const adapter1 = lastAdapter();
        applySelection(mounted, VID_B, 'manual');
        await tick();
        expect(adapter1.destroyed).toBe(true);
        const adapter2 = lastAdapter();
        expect(adapter2).not.toBe(adapter1);
        adapter2.simulateReady();
        await tick();
        adapter2.resolveLoad(YT_B);
        await tick();
        expect(adapter2.play).toHaveBeenCalledTimes(1);
        mounted.unmount();
    });

    it('a pending manual selection resolved after unmount does not play', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        applySelection(mounted, VID_B, 'manual');
        await tick();
        mounted.unmount();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
    });
});

function findByClass(node: unknown, marker: string): VNodeLike | null {
    let found: VNodeLike | null = null;
    walkVNodes(node, vnode => {
        if (found) return;
        const cls = vnode.props?.className;
        if (typeof cls === 'string' && cls.includes(marker)) found = vnode;
    });
    return found;
}

function fireHandler(vnode: VNodeLike | null | undefined, name: string, event: unknown = {}) {
    const handler = vnode?.props?.[name] as ((e: unknown) => void) | undefined;
    handler?.(event);
}

describe('autoplay on video select - failure and setting edge cases', () => {
    const AUTOPLAY_ON = () => makeSettings({ autoplayOnVideoSelect: true });

    it('an embedding rejection alerts without duration mutation or autoplay', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        adapter.duration = 900;
        applySelection(mounted, VID_B, 'manual');
        await tick();
        adapter.rejectLoad(YT_B, new Error('150'));
        await tick();
        expect(MockAlertModal.opens).toBe(1);
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('a non-embedding load rejection reaches the error handler', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        const failure = new Error('5');
        applySelection(mounted, VID_B, 'manual');
        await tick();
        adapter.rejectLoad(YT_B, failure);
        await tick();
        expect(MockAlertModal.opens).toBe(0);
        expect(adapter.play).not.toHaveBeenCalled();
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        expect(warn.mock.calls.some(call => call.includes(failure))).toBe(true);
        warn.mockRestore();
        mounted.unmount();
    });

    it('a rejected seekAndPause reaches the error handler instead of an unhandled rejection', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        const failure = new Error('5');
        adapter.seekAndPause.mockImplementationOnce(() => Promise.reject(failure));
        applySelection(mounted, VID_A, 'manual');
        await tick();
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        expect(warn.mock.calls.some(call => call.includes(failure))).toBe(true);
        warn.mockRestore();
        mounted.unmount();
    });

    it('a rejected play reaches the error handler instead of an unhandled rejection', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        const failure = new Error('5');
        adapter.play.mockImplementationOnce(() => Promise.reject(failure));
        applySelection(mounted, VID_B, 'manual');
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls.some(call => call.includes(failure))).toBe(true);
        warn.mockRestore();
        mounted.unmount();
    });

    it('a stale load completion writes no duration to the superseded video', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON(), [
            { id: VID_A, url: `https://www.youtube.com/watch?v=${YT_A}`, durationSec: 600 },
            { id: VID_B, url: `https://www.youtube.com/watch?v=${YT_B}`, durationSec: 600 },
            makeVideo(VID_C, YT_C),
        ]);
        adapter.duration = 900;
        applySelection(mounted, VID_B, 'manual');
        await tick();
        mounted.rerender({ activeVideoId: VID_C });
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(mounted.props.onUpdateVideos).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('manual selection while off then enabling mid-load does not play', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(makeSettings());
        applySelection(mounted, VID_B, 'manual');
        await tick();
        mounted.rerender({ settings: { ...mounted.props.settings, autoplayOnVideoSelect: true } });
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('disable and re-enable during a pending remembered seek cancels autoplay', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(AUTOPLAY_ON());
        adapter.emitTime(120);
        await switchTo(mounted, VID_B);
        adapter.resolveLoad(YT_B);
        await tick();
        let finishRestore: (() => void) | undefined;
        adapter.seekAndPause.mockImplementationOnce(async (time: number) => {
            await new Promise<void>(resolve => { finishRestore = resolve; });
            adapter.currentTime = time;
            adapter.playerState = 2;
        });
        applySelection(mounted, VID_A, 'manual');
        await tick();
        adapter.resolveLoad(YT_A);
        await tick();
        expect(adapter.seekAndPause).toHaveBeenCalledWith(120, expect.any(Function));
        mounted.rerender({ settings: { ...mounted.props.settings, autoplayOnVideoSelect: false } });
        mounted.rerender({ settings: { ...mounted.props.settings, autoplayOnVideoSelect: true } });
        await tick();
        finishRestore!();
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('manual selection autoplays in read-only viewing mode', async () => {
        const mounted = mount(makeProps({ settings: AUTOPLAY_ON(), readOnly: true }));
        expect(mounted.props.readOnly).toBe(true);
        const adapter = lastAdapter();
        adapter.simulateReady();
        await tick();
        adapter.resolveLoad(adapter.videoId);
        await tick();
        selectFromList(mounted, VID_B);
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.play).toHaveBeenCalledTimes(1);
        mounted.unmount();
    });

    it('manual selection with memory disabled plays without any restore seek', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(
            makeSettings({ autoplayOnVideoSelect: true, rememberPlaybackPosition: false }),
        );
        selectFromList(mounted, VID_B);
        await tick();
        adapter.resolveLoad(YT_B);
        await tick();
        expect(adapter.seekAndPause).not.toHaveBeenCalled();
        expect(adapter.play).toHaveBeenCalledTimes(1);
        mounted.unmount();
    });
});

describe('video additions select automatically, never manually', () => {
    it('the add-video form calls the setter with only the id', async () => {
        const { requestUrl } = await import('obsidian');
        vi.mocked(requestUrl).mockResolvedValue({
            status: 200,
            json: { title: 'new vid', thumbnail_url: '' },
        } as never);
        const { mounted, adapter } = await mountWithAdapterLoaded(
            makeSettings({ autoplayOnVideoSelect: true }),
        );
        const input = findByClass(lastTree, 'youtnote-plugin__add-video-input');
        fireHandler(input, 'oninput', { target: { value: `https://www.youtube.com/watch?v=${YT_C}` } });
        fireHandler(input, 'onInput', { target: { value: `https://www.youtube.com/watch?v=${YT_C}` } });
        fireHandler(input, 'onChange', { target: { value: `https://www.youtube.com/watch?v=${YT_C}` } });
        mounted.rerender({});
        const form = findByClass(lastTree, 'youtnote-plugin__add-video-form');
        fireHandler(form, 'onSubmit', { preventDefault: () => {} });
        await tick(20);
        mounted.rerender({});
        const spy = mounted.props.setActiveVideoId as ReturnType<typeof vi.fn>;
        const addCall = spy.mock.calls[spy.mock.calls.length - 1] as [VideoId] | undefined;
        expect(addCall).toBeDefined();
        expect(addCall).toHaveLength(1);
        const updatedVideos = (mounted.props.onUpdateVideos as ReturnType<typeof vi.fn>).mock
            .calls[0][0] as Video[];
        const newVideo = updatedVideos.find(v => v.id === addCall![0]);
        expect(newVideo).toBeDefined();
        const videos = [...mounted.props.videos, newVideo!];
        mounted.rerender({ videos });
        applySelection(mounted, addCall![0], 'automatic');
        await tick();
        adapter.resolveLoad(YT_C);
        await tick();
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('the duplicate-add path schedules an automatic selection', async () => {
        const { mounted, adapter } = await mountWithAdapterLoaded(
            makeSettings({ autoplayOnVideoSelect: true }),
        );
        const input = findByClass(lastTree, 'youtnote-plugin__add-video-input');
        fireHandler(input, 'oninput', { target: { value: `https://www.youtube.com/watch?v=${YT_A}` } });
        fireHandler(input, 'onInput', { target: { value: `https://www.youtube.com/watch?v=${YT_A}` } });
        fireHandler(input, 'onChange', { target: { value: `https://www.youtube.com/watch?v=${YT_A}` } });
        mounted.rerender({});
        const form = findByClass(lastTree, 'youtnote-plugin__add-video-form');
        fireHandler(form, 'onSubmit', { preventDefault: () => {} });
        await tick(20);
        const timerCalls = (window.setTimeout as unknown as ReturnType<typeof vi.fn>).mock.calls;
        const selectTimer = timerCalls.find(call => call[1] === 100);
        expect(selectTimer).toBeDefined();
        (selectTimer![0] as () => void)();
        const spy = mounted.props.setActiveVideoId as ReturnType<typeof vi.fn>;
        const selectCall = spy.mock.calls[spy.mock.calls.length - 1];
        expect(selectCall).toEqual([VID_A]);
        expect(adapter.play).not.toHaveBeenCalled();
        mounted.unmount();
    });
});
