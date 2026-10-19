import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Platform } from 'obsidian';
import type { Note, Video } from '../types';
import { calculateTotalWords, calculateTotalCharacters } from '../utils';

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    const hooks = { values: [] as unknown[], cursor: 0 };
    return {
        ...actual,
        __youtnoteTestHooks: hooks,
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
        useEffect: vi.fn(),
        useLayoutEffect: vi.fn(),
        useRef: <T,>(init: T) => ({ current: init }),
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

vi.mock('../playback', () => ({ seekToSelection: vi.fn() }));
vi.mock('./VideoListItem', () => ({ VideoListItem: () => null }));
vi.mock('./NoteListItem', () => ({ NoteListItem: () => null }));
vi.mock('./TranscriptListItem', () => ({ TranscriptListItem: () => null }));
vi.mock('../ai/registry', () => ({ getAINoteGenerationSetupError: () => null }));
vi.mock('../notices', () => ({ showYoutnoteNotice: vi.fn() }));

const alertOpens: unknown[][] = [];
const confirmInstances: { onConfirm: () => void }[] = [];

vi.mock('./MessageBoxes', () => ({
    AlertModal: class {
        constructor(...args: unknown[]) {
            alertOpens.push(args);
        }
        open() {}
    },
    ConfirmModal: class {
        constructor(_app: unknown, _title: unknown, _message: unknown, onConfirm: () => void) {
            confirmInstances.push({ onConfirm });
        }
        open() {}
    },
    AIGenerationModal: class {},
    MISSING_AI_API_KEY_MESSAGE: 'missing-key',
    showAISetupModal: vi.fn(),
}));

const { YoutubePluginView } = await import('./YoutnoteView');
const { __youtnoteTestHooks } = await import('react') as unknown as { __youtnoteTestHooks: TestHooks };

const VIDEO_ID = 'v1' as Video['id'];
const OTHER_VIDEO_ID = 'v2' as Video['id'];

function makeVideo(id: Video['id'] = VIDEO_ID): Video {
    return { id, url: `https://youtu.be/${id}`, durationSec: 600 };
}

let noteSeq = 0;
function makeNote(partial: Partial<Note> & { videoId?: Video['id'] }): Note {
    noteSeq += 1;
    return {
        id: `n${noteSeq}` as Note['id'],
        videoId: VIDEO_ID,
        timestampSec: 60,
        bodyMarkdown: `body-${noteSeq}`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        ...partial,
    };
}

interface TestHooks {
    values: unknown[];
    cursor: number;
}

function testHooks(): TestHooks {
    return __youtnoteTestHooks;
}

function makeProps(overrides: {
    notes?: Note[];
    videos?: Video[];
    activeVideoId?: Video['id'] | null;
    readOnly?: boolean;
    showNoteStats?: boolean;
} = {}) {
    const onUpdateNotes = vi.fn();
    const props = {
        app: {},
        view: { getMutationGuard: () => () => true },
        settings: { showNoteStats: overrides.showNoteStats ?? false },
        videos: overrides.videos ?? [makeVideo()],
        notes: overrides.notes ?? [],
        activeVideoId: overrides.activeVideoId === undefined ? VIDEO_ID : overrides.activeVideoId,
        videoTaskState: {},
        setActiveVideoId: vi.fn(),
        onUpdateVideos: vi.fn(),
        onUpdateNotes,
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
    return { props, onUpdateNotes };
}

interface VNodeLike {
    type?: unknown;
    props?: Record<string, unknown> & { children?: unknown };
}

function collectMergeButtons(node: unknown, found: VNodeLike[] = []): VNodeLike[] {
    if (Array.isArray(node)) {
        node.forEach(child => collectMergeButtons(child, found));
        return found;
    }
    if (!node || typeof node !== 'object') return found;
    const vnode = node as VNodeLike;
    const onClick = vnode.props?.onClick;
    if (typeof onClick === 'function' && onClick.name === 'handleMergeDuplicateNotes') {
        found.push(vnode);
    }
    const children = vnode.props?.children;
    if (children !== undefined) collectMergeButtons(children, found);
    return found;
}

function renderView(props: ReturnType<typeof makeProps>['props']) {
    testHooks().cursor = 0;
    return (YoutubePluginView as unknown as (p: unknown) => unknown)(props);
}

function renderMergeButtons(props: ReturnType<typeof makeProps>['props']) {
    return collectMergeButtons(renderView(props));
}

function collectByClass(node: unknown, cls: string, found: VNodeLike[] = []): VNodeLike[] {
    if (Array.isArray(node)) {
        node.forEach(child => collectByClass(child, cls, found));
        return found;
    }
    if (!node || typeof node !== 'object') return found;
    const vnode = node as VNodeLike;
    const className = vnode.props?.className;
    if (typeof className === 'string' && className.split(/\s+/).includes(cls)) {
        found.push(vnode);
    }
    const children = vnode.props?.children;
    if (children !== undefined) collectByClass(children, cls, found);
    return found;
}

function directChildrenWithClass(node: VNodeLike, cls: string): VNodeLike[] {
    const children = node.props?.children;
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
    return list.filter(
        (child): child is VNodeLike =>
            !!child && typeof child === 'object' &&
            typeof (child as VNodeLike).props?.className === 'string' &&
            ((child as VNodeLike).props!.className as string).split(/\s+/).includes(cls)
    );
}

function resetTestState() {
    alertOpens.length = 0;
    confirmInstances.length = 0;
    noteSeq = 0;
    const hooks = testHooks();
    hooks.values.length = 0;
    hooks.cursor = 0;
    Platform.isMobile = false;
}

describe('merge duplicate notes button visibility', () => {
    beforeEach(resetTestState);

    it('is hidden with no notes', () => {
        const { props } = makeProps({ notes: [] });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });

    it('is hidden when the only note is general via isGeneral flag', () => {
        const { props } = makeProps({ notes: [makeNote({ isGeneral: true })] });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });

    it('is hidden when the only note is general via timestampSec -1', () => {
        const { props } = makeProps({ notes: [makeNote({ timestampSec: -1 })] });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });

    it('is hidden when the only note is general via both markers', () => {
        const { props } = makeProps({ notes: [makeNote({ isGeneral: true, timestampSec: -1 })] });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });

    it('is hidden with a single timestamped note at zero', () => {
        const { props } = makeProps({ notes: [makeNote({ timestampSec: 0 })] });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });

    it('is hidden with a single timestamped note at a positive timestamp', () => {
        const { props } = makeProps({ notes: [makeNote({ timestampSec: 120 })] });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });

    it('is visible with two timestamped notes at distinct timestamps', () => {
        const { props } = makeProps({
            notes: [
                makeNote({ timestampSec: 30 }),
                makeNote({ timestampSec: 90 }),
            ],
        });
        expect(renderMergeButtons(props)).toHaveLength(1);
    });

    it('is visible with two timestamped notes at a duplicate timestamp', () => {
        const { props } = makeProps({
            notes: [
                makeNote({ timestampSec: 45 }),
                makeNote({ timestampSec: 45 }),
            ],
        });
        expect(renderMergeButtons(props)).toHaveLength(1);
    });

    it('is visible with a general note plus two timestamped notes', () => {
        const { props } = makeProps({
            notes: [
                makeNote({ isGeneral: true, timestampSec: -1 }),
                makeNote({ timestampSec: 30 }),
                makeNote({ timestampSec: 90 }),
            ],
        });
        expect(renderMergeButtons(props)).toHaveLength(1);
    });

    it('is hidden with a mix of general and a single timestamped note', () => {
        const { props } = makeProps({
            notes: [
                makeNote({ isGeneral: true, timestampSec: -1 }),
                makeNote({ timestampSec: 30 }),
            ],
        });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });

    it('is hidden when only one timestamped note is local and the other belongs to another video', () => {
        const { props } = makeProps({
            videos: [makeVideo(), makeVideo(OTHER_VIDEO_ID)],
            notes: [
                makeNote({ isGeneral: true, timestampSec: -1 }),
                makeNote({ timestampSec: 30 }),
                makeNote({ videoId: OTHER_VIDEO_ID, timestampSec: 30 }),
            ],
        });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });

    it('is hidden in read-only mode', () => {
        const { props } = makeProps({
            notes: [
                makeNote({ timestampSec: 30 }),
                makeNote({ timestampSec: 90 }),
            ],
            readOnly: true,
        });
        expect(renderMergeButtons(props)).toHaveLength(0);
    });
});

describe('merge duplicate notes handler', () => {
    beforeEach(resetTestState);

    it('merges only the timestamped duplicate pair and leaves general/other-video notes untouched', () => {
        const dupA = makeNote({ timestampSec: 45, bodyMarkdown: 'dup-a' });
        const dupB = makeNote({ timestampSec: 45, bodyMarkdown: 'dup-b' });
        const generalFlagged = makeNote({ isGeneral: true, timestampSec: 45, bodyMarkdown: 'general-flagged' });
        const generalSentinel = makeNote({ timestampSec: -1, bodyMarkdown: 'general-sentinel' });
        const otherVideoNote = makeNote({ videoId: OTHER_VIDEO_ID, timestampSec: 45, bodyMarkdown: 'other-video' });
        const notes = [dupA, dupB, generalFlagged, generalSentinel, otherVideoNote];
        const { props, onUpdateNotes } = makeProps({
            videos: [makeVideo(), makeVideo(OTHER_VIDEO_ID)],
            notes,
        });

        const [mergeBtn] = renderMergeButtons(props);
        expect(mergeBtn).toBeDefined();
        (mergeBtn.props!.onClick as () => void)();

        expect(alertOpens).toHaveLength(0);
        expect(confirmInstances).toHaveLength(1);
        confirmInstances[0].onConfirm();

        expect(onUpdateNotes).toHaveBeenCalledTimes(1);
        const result = onUpdateNotes.mock.calls[0][0] as Note[];

        const merged = result.find(n => n.id === dupA.id || n.id === dupB.id);
        expect(merged).toBeDefined();
        expect(merged!.bodyMarkdown).toBe('dup-a\n\ndup-b');
        expect(result.filter(n => n.id === dupA.id || n.id === dupB.id)).toHaveLength(1);

        const generalA = result.find(n => n.id === generalFlagged.id);
        expect(generalA).toBeDefined();
        expect(generalA).toEqual(generalFlagged);
        const generalB = result.find(n => n.id === generalSentinel.id);
        expect(generalB).toBeDefined();
        expect(generalB).toEqual(generalSentinel);

        const other = result.find(n => n.id === otherVideoNote.id);
        expect(other).toBeDefined();
        expect(other).toEqual(otherVideoNote);
    });

    it('alerts instead of confirming when no true timestamped duplicate exists', () => {
        const generalFlagged = makeNote({ isGeneral: true, timestampSec: 45, bodyMarkdown: 'general-flagged' });
        const timestampedA = makeNote({ timestampSec: 45, bodyMarkdown: 'timestamped-a' });
        const timestampedB = makeNote({ timestampSec: 60, bodyMarkdown: 'timestamped-b' });
        const { props, onUpdateNotes } = makeProps({ notes: [generalFlagged, timestampedA, timestampedB] });

        const [mergeBtn] = renderMergeButtons(props);
        expect(mergeBtn).toBeDefined();
        (mergeBtn.props!.onClick as () => void)();

        expect(alertOpens).toHaveLength(1);
        expect(confirmInstances).toHaveLength(0);
        expect(onUpdateNotes).not.toHaveBeenCalled();
    });
});

describe('note statistics layout', () => {
    beforeEach(resetTestState);

    const HEADER = 'youtnote-plugin__note-list-header';
    const HEADER_ROW = 'youtnote-plugin__note-list-header-row';
    const HEADER_CONTENT = 'youtnote-plugin__note-list-header-content';
    const ACTIONS = 'youtnote-plugin__note-list-action-btns-container';
    const STATS = 'youtnote-plugin__note-stats';
    const STATS_WORDS = 'youtnote-plugin__note-stats-words';
    const STATS_CHARS = 'youtnote-plugin__note-stats-characters';
    const NOTE_COUNT = 'youtnote-plugin__note-count';
    const SEARCH = 'youtnote-plugin__note-search-container';

    function headerOf(tree: unknown): VNodeLike {
        const [header] = collectByClass(tree, HEADER);
        expect(header).toBeDefined();
        return header;
    }

    function statValues(statsEl: VNodeLike): { words: unknown; chars: unknown } {
        const [w] = collectByClass(statsEl, STATS_WORDS);
        const [c] = collectByClass(statsEl, STATS_CHARS);
        return { words: w?.props?.children, chars: c?.props?.children };
    }

    it('mobile: stats sit on their own line below the count/buttons row with supplied numbers', () => {
        Platform.isMobile = true;
        const notes = [
            makeNote({ isGeneral: true, timestampSec: -1, bodyMarkdown: 'one two' }),
            makeNote({ timestampSec: 30, bodyMarkdown: 'three' }),
        ];
        const { props } = makeProps({ notes, showNoteStats: true });
        const tree = renderView(props);
        const header = headerOf(tree);

        const directStats = directChildrenWithClass(header, STATS);
        expect(directStats).toHaveLength(1);
        const [row] = directChildrenWithClass(header, HEADER_ROW);
        const [search] = directChildrenWithClass(header, SEARCH);
        expect(row).toBeDefined();
        expect(search).toBeDefined();
        const order = (Array.isArray(header.props!.children) ? header.props!.children : [header.props!.children]) as unknown[];
        const flat = order.filter(c => c && typeof c === 'object' && (c as VNodeLike).props?.className);
        const cls = (el: unknown) => (el as VNodeLike).props!.className as string;
        expect(flat.findIndex(c => cls(c).includes(HEADER_ROW))).toBeLessThan(flat.findIndex(c => cls(c).includes(STATS)));
        expect(flat.findIndex(c => cls(c).includes(STATS))).toBeLessThan(flat.findIndex(c => cls(c).includes(SEARCH)));

        expect(collectByClass(row, STATS)).toHaveLength(0);
        expect(collectByClass(row, NOTE_COUNT)).toHaveLength(1);
        expect(collectByClass(row, ACTIONS)).toHaveLength(1);

        const { words, chars } = statValues(directStats[0]);
        const bodies = notes.map(n => n.bodyMarkdown);
        expect(words).toBe(calculateTotalWords(bodies));
        expect(chars).toBe(calculateTotalCharacters(bodies));
    });

    it('desktop: stats stay inline inside the header content', () => {
        const notes = [makeNote({ timestampSec: 30, bodyMarkdown: 'alpha beta' })];
        const { props } = makeProps({ notes, showNoteStats: true });
        const tree = renderView(props);
        const header = headerOf(tree);

        expect(directChildrenWithClass(header, STATS)).toHaveLength(0);
        const [content] = collectByClass(header, HEADER_CONTENT);
        expect(collectByClass(content, STATS)).toHaveLength(1);
        expect(collectByClass(tree, STATS)).toHaveLength(1);
    });

    it('mobile: setting off renders no stats but keeps the count', () => {
        Platform.isMobile = true;
        const { props } = makeProps({ notes: [makeNote({ timestampSec: 5 })], showNoteStats: false });
        const tree = renderView(props);
        expect(collectByClass(tree, STATS)).toHaveLength(0);
        const [count] = collectByClass(tree, NOTE_COUNT);
        expect(count).toBeDefined();
        expect(count.props!.children).toBe(1);
    });

    it('desktop: setting off renders no stats but keeps the count', () => {
        const { props } = makeProps({ notes: [makeNote({ timestampSec: 5 })], showNoteStats: false });
        const tree = renderView(props);
        expect(collectByClass(tree, STATS)).toHaveLength(0);
        expect(collectByClass(tree, NOTE_COUNT)).toHaveLength(1);
    });

    it('no notes: no stats, count still renders zero', () => {
        const { props } = makeProps({ notes: [], showNoteStats: true });
        const tree = renderView(props);
        expect(collectByClass(tree, STATS)).toHaveLength(0);
        const [count] = collectByClass(tree, NOTE_COUNT);
        expect(count.props!.children).toBe(0);
    });

    it('stats exclude notes from other videos', () => {
        const notes = [
            makeNote({ timestampSec: 10, bodyMarkdown: 'aa bb cc' }),
            makeNote({ videoId: OTHER_VIDEO_ID, timestampSec: 10, bodyMarkdown: 'x'.repeat(100) }),
        ];
        const { props } = makeProps({ videos: [makeVideo(), makeVideo(OTHER_VIDEO_ID)], notes, showNoteStats: true });
        const tree = renderView(props);
        const [stats] = collectByClass(tree, STATS);
        const { words, chars } = statValues(stats);
        expect(words).toBe(calculateTotalWords(['aa bb cc']));
        expect(chars).toBe(calculateTotalCharacters(['aa bb cc']));
    });

    it('transcript view hides stats', () => {
        const notes = [makeNote({ timestampSec: 30, bodyMarkdown: 'aa' })];
        const videos = [{ ...makeVideo(), transcript: [{ startMs: 0, text: 'cap' }] }];
        const { props } = makeProps({ notes, videos, showNoteStats: true });

        let tree = renderView(props);
        const [actions] = collectByClass(tree, ACTIONS);
        const buttons: VNodeLike[] = [];
        const walkButtons = (n: unknown) => {
            if (Array.isArray(n)) return n.forEach(walkButtons);
            if (!n || typeof n !== 'object') return;
            const v = n as VNodeLike;
            if (v.type === 'button') buttons.push(v);
            if (v.props?.children !== undefined) walkButtons(v.props.children);
        };
        walkButtons(actions.props!.children);
        expect(buttons.length).toBeGreaterThan(0);
        (buttons[0].props!.onClick as () => void)();

        tree = renderView(props);
        expect(collectByClass(tree, STATS)).toHaveLength(0);
        expect(collectByClass(tree, NOTE_COUNT)).toHaveLength(0);
    });
});
