import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Note, Video } from '../types';

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useState: <T,>(init: T | (() => T)) => [
            typeof init === 'function' ? (init as () => T)() : init,
            vi.fn(),
        ],
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

function makeProps(overrides: {
    notes?: Note[];
    videos?: Video[];
    activeVideoId?: Video['id'] | null;
    readOnly?: boolean;
} = {}) {
    const onUpdateNotes = vi.fn();
    const props = {
        app: {},
        view: { getMutationGuard: () => () => true },
        settings: {},
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

function renderMergeButtons(props: ReturnType<typeof makeProps>['props']) {
    const tree = (YoutubePluginView as unknown as (p: unknown) => unknown)(props);
    return collectMergeButtons(tree);
}

describe('merge duplicate notes button visibility', () => {
    beforeEach(() => {
        alertOpens.length = 0;
        confirmInstances.length = 0;
        noteSeq = 0;
    });

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
    beforeEach(() => {
        alertOpens.length = 0;
        confirmInstances.length = 0;
        noteSeq = 0;
    });

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
