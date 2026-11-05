import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { App } from 'obsidian';
import type { Note, NoteListItemProps, Video, YoutnoteViewContext } from '../types';
import { showYoutnoteNotice } from '../notices';

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    const hooks = { values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 };
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
        useRef: <T,>(init: T) => {
            const index = hooks.refCursor++;
            if (!(index in hooks.refs)) hooks.refs[index] = { current: init };
            return hooks.refs[index] as { current: T };
        },
        useCallback: <T,>(fn: T) => fn,
    };
});

interface RecordedMenuItem {
    title: string;
    icon: string;
    warning: boolean;
    click(): void;
}

interface RecordedMenu {
    items: RecordedMenuItem[];
    separators: number;
    shownAtMouseEvent: boolean;
}

const menuInstances = vi.hoisted(() => [] as RecordedMenu[]);

vi.mock('obsidian', () => {
    class FakeMenuItem {
        title = '';
        icon = '';
        warning = false;
        clickHandler: (() => void) | null = null;

        setTitle(title: string) {
            this.title = title;
            return this;
        }
        setIcon(icon: string) {
            this.icon = icon;
            return this;
        }
        setWarning(warning: boolean) {
            this.warning = warning;
            return this;
        }
        onClick(cb: () => void) {
            this.clickHandler = cb;
            return this;
        }
        click() {
            this.clickHandler?.();
        }
    }

    class FakeMenu {
        items: FakeMenuItem[] = [];
        separators = 0;
        shownAtMouseEvent = false;

        constructor() {
            menuInstances.push(this);
        }

        addItem(cb: (item: FakeMenuItem) => void) {
            const item = new FakeMenuItem();
            cb(item);
            this.items.push(item);
            return this;
        }

        addSeparator() {
            this.separators++;
            return this;
        }

        showAtMouseEvent() {
            this.shownAtMouseEvent = true;
        }
    }

    return {
        MarkdownRenderer: { render: vi.fn(() => Promise.resolve()) },
        Component: class {},
        App: class {},
        TFile: class {},
        Notice: class {},
        Platform: { isMobile: false, isPhone: false, isTablet: false, isDesktop: true },
        setIcon: vi.fn(),
        Menu: FakeMenu,
    };
});

vi.mock('../notices', () => ({ showYoutnoteNotice: vi.fn() }));
vi.mock('./ObsidianEditor', () => ({ ObsidianEditor: () => null }));
vi.mock('./MessageBoxes', () => ({
    AlertModal: class {
        open() {}
    },
    ConfirmModal: class {
        open() {}
    },
    AIGenerationModal: class {},
    MISSING_AI_API_KEY_MESSAGE: '',
    showAISetupModal: vi.fn(),
}));

const { NoteListItem } = await import('./NoteListItem');
const { __youtnoteTestHooks } = await import('react') as unknown as { __youtnoteTestHooks: TestHooks };

interface TestHooks {
    values: unknown[];
    cursor: number;
    refs: { current: unknown }[];
    refCursor: number;
}

interface VNodeLike {
    type?: unknown;
    props?: Record<string, unknown> & { children?: unknown };
}

const writeText = vi.fn();
const flushPromises = () => new Promise(resolve => window.setTimeout(resolve, 0));

const TEST_VIDEO: Video = {
    id: 'video-1' as Video['id'],
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Test Video',
};

function makeNote(overrides: Partial<Note> = {}): Note {
    return {
        id: 'note-1' as Note['id'],
        videoId: 'video-1' as Note['videoId'],
        timestampSec: 125,
        bodyMarkdown: '# Heading\n\nSome **markdown** body',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeProps(overrides: Partial<NoteListItemProps> = {}): NoteListItemProps {
    return {
        app: {} as App,
        view: { getMutationGuard: () => () => true } as unknown as YoutnoteViewContext,
        note: makeNote(),
        video: TEST_VIDEO,
        isExpanded: true,
        isActive: false,
        isEditing: false,
        editingTimestampId: null,
        editTimestampValue: '',
        timestampError: null,
        editNoteBody: '',
        maxDuration: 600,
        newLineTrigger: 'enter',
        isGeneral: false,
        readOnly: false,
        onToggleExpand: vi.fn(),
        onSelect: vi.fn(),
        onStartEdit: vi.fn(),
        onSaveEdit: vi.fn(),
        onBodyChange: vi.fn(),
        onStartTimestampEdit: vi.fn(),
        onSaveTimestampEdit: vi.fn(),
        onCancelTimestampEdit: vi.fn(),
        onTimestampChange: vi.fn(),
        onDelete: vi.fn(),
        ...overrides,
    };
}

function renderNoteItem(overrides: Partial<NoteListItemProps> = {}) {
    __youtnoteTestHooks.cursor = 0;
    __youtnoteTestHooks.refCursor = 0;
    const props = makeProps(overrides);
    const render = (NoteListItem as unknown as { type: (p: NoteListItemProps) => unknown }).type;
    return { tree: render(props) as VNodeLike, props };
}

function walkVNodes(node: unknown, visit: (vnode: VNodeLike) => void): void {
    if (Array.isArray(node)) {
        node.forEach(child => walkVNodes(child, visit));
        return;
    }
    if (!node || typeof node !== 'object') return;
    const vnode = node as VNodeLike;
    visit(vnode);
    walkVNodes(vnode.props?.children, visit);
}

function childVNodes(node: VNodeLike): VNodeLike[] {
    const children = node.props?.children;
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
    return list.filter((child): child is VNodeLike => !!child && typeof child === 'object');
}

function actionContainers(tree: VNodeLike): VNodeLike[] {
    const found: VNodeLike[] = [];
    walkVNodes(tree, vnode => {
        const className = vnode.props?.className;
        if (typeof className === 'string' && className.split(/\s+/).includes('youtnote-plugin__note-actions')) {
            found.push(vnode);
        }
    });
    return found;
}

function actionButtons(tree: VNodeLike): VNodeLike[] {
    const containers = actionContainers(tree);
    expect(containers).toHaveLength(1);
    return childVNodes(containers[0]);
}

function clickHandlerName(vnode: VNodeLike): string | undefined {
    const onClick = vnode.props?.onClick;
    return typeof onClick === 'function' ? onClick.name : undefined;
}

function invokeClick(vnode: VNodeLike) {
    const onClick = vnode.props?.onClick;
    if (typeof onClick !== 'function') throw new Error('vnode has no onClick handler');
    const stopPropagation = vi.fn();
    (onClick as (e: unknown) => void)({ stopPropagation });
    return stopPropagation;
}

function openContextMenu(tree: VNodeLike) {
    const onContextMenu = tree.props?.onContextMenu;
    if (typeof onContextMenu !== 'function') throw new Error('root vnode has no onContextMenu handler');
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    (onContextMenu as (e: unknown) => void)({ preventDefault, stopPropagation, nativeEvent: {} });
    return { preventDefault, stopPropagation };
}

function lastMenu(): RecordedMenu {
    const menu = menuInstances.at(-1);
    if (!menu) throw new Error('no context menu was opened');
    return menu;
}

function copyMenuItem(menu: RecordedMenu): RecordedMenuItem {
    const item = menu.items.find(entry => entry.icon === 'copy');
    if (!item) throw new Error('context menu has no copy item');
    return item;
}

function copyActionButton(tree: VNodeLike): VNodeLike {
    const button = actionButtons(tree).find(entry => clickHandlerName(entry) === 'handleCopyClick');
    if (!button) throw new Error('note actions have no copy button');
    return button;
}

beforeEach(() => {
    writeText.mockReset();
    menuInstances.length = 0;
    vi.mocked(showYoutnoteNotice).mockClear();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('NoteListItem copy action', () => {
    it('orders the action buttons as edit, copy, delete for expanded writable notes', () => {
        const { tree } = renderNoteItem();
        const names = actionButtons(tree).map(clickHandlerName);
        expect(names).toEqual(['handleEditClick', 'handleCopyClick', 'handleDelete']);
    });

    it('renders no action buttons when the note is collapsed', () => {
        const { tree } = renderNoteItem({ isExpanded: false });
        expect(actionContainers(tree)).toHaveLength(0);
    });

    it('copies the note with a timestamp link to the clipboard from the action button', async () => {
        writeText.mockResolvedValue(undefined);
        const body = '# Heading\n\nSome **markdown** body';
        const { tree } = renderNoteItem({ note: makeNote({ bodyMarkdown: body }) });

        invokeClick(copyActionButton(tree));
        await flushPromises();

        expect(writeText).toHaveBeenCalledWith(`[2:05](https://youtu.be/dQw4w9WgXcQ?t=125)\n${body}`);
        expect(showYoutnoteNotice).toHaveBeenCalledTimes(1);
    });

    it('copies general notes with a video title link', async () => {
        writeText.mockResolvedValue(undefined);
        const body = 'General **markdown** note';
        const { tree } = renderNoteItem({ isGeneral: true, note: makeNote({ bodyMarkdown: body, timestampSec: -1 }) });

        invokeClick(copyActionButton(tree));
        await flushPromises();

        expect(writeText).toHaveBeenCalledWith(`[Test Video](${TEST_VIDEO.url})\n\n${body}`);
    });

    it('copies only the body when no video is available', async () => {
        writeText.mockResolvedValue(undefined);
        const body = 'Note without video context';
        const { tree } = renderNoteItem({ video: null, note: makeNote({ bodyMarkdown: body }) });

        invokeClick(copyActionButton(tree));
        await flushPromises();

        expect(writeText).toHaveBeenCalledWith(body);
    });

    it('shows an error notice when copying fails', async () => {
        writeText.mockRejectedValue(new Error('clipboard denied'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { tree } = renderNoteItem();

        invokeClick(copyActionButton(tree));
        await flushPromises();

        expect(vi.mocked(showYoutnoteNotice).mock.calls[0]?.[1]).toMatchObject({ severity: 'error' });
        consoleSpy.mockRestore();
    });

    it('disables the copy button while the note is being edited', () => {
        const { tree } = renderNoteItem({ isEditing: true });
        expect(copyActionButton(tree).props?.disabled).toBe(true);
    });

    it('orders context menu items as edit, edit timestamp, copy, delete for timestamped notes', () => {
        const { tree, props } = renderNoteItem();
        const { preventDefault, stopPropagation } = openContextMenu(tree);

        expect(preventDefault).toHaveBeenCalled();
        expect(stopPropagation).toHaveBeenCalled();
        expect(props.onSelect).toHaveBeenCalledWith(props.note.id, props.note.timestampSec);

        const menu = lastMenu();
        expect(menu.shownAtMouseEvent).toBe(true);
        expect(menu.items.map(item => item.icon)).toEqual(['pencil', 'clock', 'copy', 'trash']);
        expect(menu.separators).toBe(1);
    });

    it('omits the edit timestamp item for general notes but keeps copy', () => {
        const { tree } = renderNoteItem({ isGeneral: true });
        openContextMenu(tree);

        const menu = lastMenu();
        expect(menu.items.map(item => item.icon)).toEqual(['pencil', 'copy', 'trash']);
    });

    it('copies the note with a video title link from the context menu copy item', async () => {
        writeText.mockResolvedValue(undefined);
        const body = 'General **markdown** note';
        const { tree } = renderNoteItem({ isGeneral: true, note: makeNote({ bodyMarkdown: body, timestampSec: -1 }) });
        openContextMenu(tree);

        copyMenuItem(lastMenu()).click();
        await flushPromises();

        expect(writeText).toHaveBeenCalledWith(`[Test Video](${TEST_VIDEO.url})\n\n${body}`);
        expect(showYoutnoteNotice).toHaveBeenCalledTimes(1);
    });

    it('shows only the copy action for expanded read-only notes', () => {
        const { tree } = renderNoteItem({ readOnly: true });
        const names = actionButtons(tree).map(clickHandlerName);
        expect(names).toEqual(['handleCopyClick']);
    });

    it('copies from the action button in read-only mode', async () => {
        writeText.mockResolvedValue(undefined);
        const body = 'Read-only **markdown**';
        const { tree } = renderNoteItem({ readOnly: true, note: makeNote({ bodyMarkdown: body }) });

        invokeClick(copyActionButton(tree));
        await flushPromises();

        expect(writeText).toHaveBeenCalledWith(`[2:05](https://youtu.be/dQw4w9WgXcQ?t=125)\n${body}`);
        expect(showYoutnoteNotice).toHaveBeenCalledTimes(1);
    });

    it('offers only the copy item in the context menu in read-only mode', async () => {
        writeText.mockResolvedValue(undefined);
        const body = 'Read-only context menu copy';
        const { tree } = renderNoteItem({ readOnly: true, note: makeNote({ bodyMarkdown: body }) });
        openContextMenu(tree);

        const menu = lastMenu();
        expect(menu.items).toHaveLength(1);
        expect(menu.items[0]?.icon).toBe('copy');
        expect(menu.separators).toBe(0);

        menu.items[0]?.click();
        await flushPromises();

        expect(writeText).toHaveBeenCalledWith(`[2:05](https://youtu.be/dQw4w9WgXcQ?t=125)\n${body}`);
        expect(showYoutnoteNotice).toHaveBeenCalledTimes(1);
    });

    it('does not open the context menu while editing a timestamp', () => {
        const note = makeNote();
        const { tree } = renderNoteItem({ editingTimestampId: note.id });
        const { preventDefault } = openContextMenu(tree);

        expect(preventDefault).not.toHaveBeenCalled();
        expect(menuInstances).toHaveLength(0);
    });
});
