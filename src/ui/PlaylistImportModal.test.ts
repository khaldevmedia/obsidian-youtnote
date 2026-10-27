import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { PlaylistEntry, PlaylistResult } from '../playlist';
import { PlaylistError } from '../playlist';

const { fakeEl, sortableCreates, sortableDestroy } = vi.hoisted(() => {
    interface FakeEl {
        tag: string;
        cls: string;
        text: string;
        children: FakeEl[];
        listeners: Record<string, () => void>;
        dataset: Record<string, string>;
        attr: Record<string, string>;
        disabled: boolean;
        focused: boolean;
        scrollTop: number;
        value: string;
        selectionStart: number;
        selectionEnd: number;
        empty(): void;
        addClass(cls: string): void;
        createDiv(options?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl;
        createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeEl;
        createSpan(options?: { text?: string; cls?: string }): FakeEl;
        appendChild(child: FakeEl): FakeEl;
        setText(text: string): void;
        setAttribute(name: string, value: string): void;
        setSelectionRange(start: number, end: number): void;
        addEventListener(type: string, handler: () => void): void;
        focus(options?: { preventScroll?: boolean }): void;
        click(): void;
        findByAction(action: string): FakeEl | null;
        findAllByCls(cls: string, found?: FakeEl[]): FakeEl[];
        findByTag(tag: string): FakeEl | null;
    }
    function fakeEl(): FakeEl {
        const el: FakeEl = {
            tag: 'div',
            cls: '',
            text: '',
            children: [],
            dataset: {},
            attr: {},
            disabled: false,
            focused: false,
            scrollTop: 0,
            value: '',
            selectionStart: -1,
            selectionEnd: -1,
            listeners: {},
            empty() {
                el.children = [];
            },
            addClass(cls) {
                el.cls = el.cls ? `${el.cls} ${cls}` : cls;
            },
            createDiv(options) {
                const child = fakeEl();
                child.cls = options?.cls ?? '';
                if (options?.text !== undefined) child.text = options.text;
                if (options?.attr !== undefined) child.attr = options.attr;
                el.children.push(child);
                return child;
            },
            createEl(tag, options) {
                const child = fakeEl();
                child.tag = tag;
                child.text = options?.text ?? '';
                child.cls = options?.cls ?? '';
                child.attr = options?.attr ?? {};
                el.children.push(child);
                return child;
            },
            createSpan(options) {
                const child = fakeEl();
                child.tag = 'span';
                child.text = options?.text ?? '';
                child.cls = options?.cls ?? '';
                el.children.push(child);
                return child;
            },
            appendChild(child) {
                const index = el.children.indexOf(child);
                if (index !== -1) {
                    el.children.splice(index, 1);
                }
                el.children.push(child);
                return child;
            },
            setText(text) {
                el.text = text;
            },
            setAttribute(name, value) {
                el.attr[name] = value;
            },
            setSelectionRange(start, end) {
                el.selectionStart = start;
                el.selectionEnd = end;
            },
            addEventListener(type, handler) {
                el.listeners[type] = handler;
            },
            focus() {
                el.focused = true;
            },
            click() {
                el.listeners.click?.();
            },
            findByAction(action) {
                for (const child of el.children) {
                    if (child.dataset.youtnoteAction === action) return child;
                    const nested = child.findByAction(action);
                    if (nested) return nested;
                }
                return null;
            },
            findAllByCls(cls, found = []) {
                for (const child of el.children) {
                    if (child.cls.includes(cls)) found.push(child);
                    child.findAllByCls(cls, found);
                }
                return found;
            },
            findByTag(tag) {
                for (const child of el.children) {
                    if (child.tag === tag) return child;
                    const nested = child.findByTag(tag);
                    if (nested) return nested;
                }
                return null;
            },
        };
        return el;
    }
    return {
        fakeEl,
        sortableCreates: [] as {
            el: unknown;
            options: {
                draggable?: string;
                handle?: string;
                group?: unknown;
                onEnd?: (e: { oldIndex?: number; newIndex?: number }) => void;
            };
        }[],
        sortableDestroy: vi.fn(),
    };
});

vi.mock('obsidian', () => {
    class FakeModal {
        contentEl = fakeEl();
        containerEl = fakeEl();
        modalEl = fakeEl();
        scope = { register: vi.fn() };
        isOpen = false;
        constructor(public app: unknown) {}
        open(): void {
            this.isOpen = true;
            this.onOpen();
        }
        close(): void {
            if (!this.isOpen) return;
            this.isOpen = false;
            this.onClose();
        }
        onOpen(): void {}
        onClose(): void {}
    }
    return { Modal: FakeModal, setIcon: vi.fn() };
});

vi.mock('sortablejs', () => ({
    default: {
        create(el: unknown, options: {
            draggable?: string;
            handle?: string;
            group?: unknown;
            onEnd?: (e: { oldIndex?: number; newIndex?: number }) => void;
        }) {
            sortableCreates.push({ el, options });
            return { destroy: sortableDestroy };
        },
    },
}));

vi.mock('../playlistFetch', () => ({
    fetchPlaylist: vi.fn(),
}));

vi.mock('../videoUrlListFetch', () => ({
    fetchProvidedVideos: vi.fn(),
}));

const { fetchPlaylist } = await import('../playlistFetch');
const mockedFetch = vi.mocked(fetchPlaylist);
const { fetchProvidedVideos } = await import('../videoUrlListFetch');
const mockedProvidedFetch = vi.mocked(fetchProvidedVideos);
const { setIcon } = await import('obsidian');
const mockedSetIcon = vi.mocked(setIcon);
const { PlaylistImportModal } = await import('./PlaylistImportModal');

type FakeEl = ReturnType<typeof fakeEl>;

const app = {} as App;
const PLAYLIST_ID = 'PLVbEymL-83SyVXXqT7fYX5sEvELvyGjL7';

function entry(partial: {
    key: string;
    youtubeId: string | null;
    title?: string;
    thumbnail?: string;
    durationSec?: number;
    available?: boolean;
}): PlaylistEntry {
    const { key, youtubeId, title = `title-${key}`, thumbnail, durationSec, available = true } = partial;
    const result: PlaylistEntry = { key, youtubeId, title, available };
    if (thumbnail !== undefined) result.thumbnail = thumbnail;
    if (durationSec !== undefined) result.durationSec = durationSec;
    return result;
}

function makeOptions(overrides: {
    videoId?: string;
    existing?: string[];
    isValid?: () => boolean;
} = {}) {
    return {
        videoId: overrides.videoId,
        getExistingVideoIds: () => new Set(overrides.existing ?? []),
        isValid: overrides.isValid ?? (() => true),
    };
}

function contentOf(modal: InstanceType<typeof PlaylistImportModal>): FakeEl {
    return modal.contentEl as unknown as FakeEl;
}

function shellOf(modal: InstanceType<typeof PlaylistImportModal>): FakeEl {
    return modal.modalEl as unknown as FakeEl;
}

function paneList(modal: InstanceType<typeof PlaylistImportModal>, pane: 'source' | 'pending'): FakeEl {
    const lists = contentOf(modal).findAllByCls(`youtnote-plugin__playlist-list--${pane}`);
    expect(lists).toHaveLength(1);
    return lists[0];
}

function rowsIn(listEl: FakeEl): FakeEl[] {
    return listEl.children.filter(child => child.cls.split(' ').includes('youtnote-plugin__playlist-entry'));
}

function sourceRows(modal: InstanceType<typeof PlaylistImportModal>): FakeEl[] {
    return rowsIn(paneList(modal, 'source'));
}

function pendingRows(modal: InstanceType<typeof PlaylistImportModal>): FakeEl[] {
    return rowsIn(paneList(modal, 'pending'));
}

function rowKeys(rows: FakeEl[]): string[] {
    return rows.map(row => row.dataset.youtnoteEntryKey);
}

function emptyStateOf(listEl: FakeEl): FakeEl | null {
    return listEl.children.find(child => child.cls.split(' ').includes('youtnote-plugin__playlist-empty')) ?? null;
}

function countOf(modal: InstanceType<typeof PlaylistImportModal>, pane: 'source' | 'pending'): FakeEl {
    const counts = contentOf(modal).findAllByCls('youtnote-plugin__playlist-pane-count')
        .filter(el => el.dataset.youtnotePane === pane);
    expect(counts).toHaveLength(1);
    return counts[0];
}

function addRow(modal: InstanceType<typeof PlaylistImportModal>, key: string): void {
    const row = sourceRows(modal).find(r => r.dataset.youtnoteEntryKey === key);
    expect(row).toBeDefined();
    row!.findByAction('add-entry')!.click();
}

function removeRow(modal: InstanceType<typeof PlaylistImportModal>, key: string): void {
    const row = pendingRows(modal).find(r => r.dataset.youtnoteEntryKey === key);
    expect(row).toBeDefined();
    row!.findByAction('remove-entry')!.click();
}

function importButton(modal: InstanceType<typeof PlaylistImportModal>): FakeEl {
    const button = contentOf(modal).findByAction('import');
    expect(button).not.toBeNull();
    return button!;
}

async function openLoadedModal(entriesList: PlaylistEntry[], options = makeOptions()) {
    mockedFetch.mockResolvedValue({ title: 'Fetched', entries: entriesList });
    const modal = new PlaylistImportModal(app, PLAYLIST_ID, options);
    modal.open();
    await Promise.resolve();
    await Promise.resolve();
    return modal;
}

beforeEach(() => {
    mockedFetch.mockReset();
    mockedProvidedFetch.mockReset();
    mockedSetIcon.mockReset();
    sortableCreates.length = 0;
    sortableDestroy.mockReset();
});

describe('PlaylistImportModal source choice', () => {
    it('shows a choice for combined video+playlist urls and does not fetch until chosen', async () => {
        const modal = new PlaylistImportModal(app, PLAYLIST_ID, makeOptions({ videoId: 'aircAruvnKk' }));
        modal.open();
        expect(mockedFetch).not.toHaveBeenCalled();
        expect(contentOf(modal).findByAction('choose-playlist')).not.toBeNull();
        expect(contentOf(modal).findByAction('choose-video')).not.toBeNull();
        expect(contentOf(modal).findByAction('import')).toBeNull();
        const buttonsEl = contentOf(modal).findAllByCls('youtnote-plugin__base-modal-buttons')[0];
        expect(buttonsEl.children.map(c => c.dataset.youtnoteAction)).toEqual(['choose-playlist', 'choose-video', 'cancel']);

        mockedFetch.mockResolvedValue({ title: 'Fetched', entries: [] });
        contentOf(modal).findByAction('choose-playlist')!.click();
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(mockedFetch.mock.calls[0][0]).toBe(PLAYLIST_ID);
        await Promise.resolve();
        await Promise.resolve();
        expect(contentOf(modal).findByAction('import')).not.toBeNull();
        modal.close();
        await expect(modal.result).resolves.toBeNull();
    });

    it('resolves video without fetching when the video-only action is picked', async () => {
        const modal = new PlaylistImportModal(app, PLAYLIST_ID, makeOptions({ videoId: 'aircAruvnKk' }));
        modal.open();
        contentOf(modal).findByAction('choose-video')!.click();
        await expect(modal.result).resolves.toBe('video');
        expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('resolves null instead of video when the target is invalid at choice time', async () => {
        const modal = new PlaylistImportModal(app, PLAYLIST_ID, makeOptions({ videoId: 'aircAruvnKk', isValid: () => false }));
        modal.open();
        contentOf(modal).findByAction('choose-video')!.click();
        await expect(modal.result).resolves.toBeNull();
        expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('offers only the video for a mix id without fetching', async () => {
        const modal = new PlaylistImportModal(app, 'RDMMabc', makeOptions({ videoId: 'aircAruvnKk' }));
        modal.open();
        expect(mockedFetch).not.toHaveBeenCalled();
        expect(contentOf(modal).findByAction('choose-playlist')).toBeNull();
        contentOf(modal).findByAction('choose-video')!.click();
        await expect(modal.result).resolves.toBe('video');
    });

    it('shows an unsupported state for account-only ids and keeps cancel available', async () => {
        const modal = new PlaylistImportModal(app, 'WL', makeOptions());
        modal.open();
        expect(mockedFetch).not.toHaveBeenCalled();
        expect(shellOf(modal).cls).toContain('youtnote-plugin__playlist-dialog');
        expect(contentOf(modal).cls).toContain('youtnote-plugin__playlist-modal');
        expect(contentOf(modal).findByAction('choose-video')).toBeNull();
        expect(contentOf(modal).findByAction('import')).toBeNull();
        contentOf(modal).findByAction('cancel')!.click();
        await expect(modal.result).resolves.toBeNull();
    });

    it('keeps the dialog and content classes through choice, loading and select phases', async () => {
        const deferred: { resolve?: (result: PlaylistResult) => void } = {};
        mockedFetch.mockImplementation(() => new Promise<PlaylistResult>(resolve => { deferred.resolve = resolve; }));
        const modal = new PlaylistImportModal(app, PLAYLIST_ID, makeOptions({ videoId: 'aircAruvnKk' }));
        modal.open();
        expect(shellOf(modal).cls).toContain('youtnote-plugin__playlist-dialog');
        expect(contentOf(modal).cls).toContain('youtnote-plugin__playlist-modal');
        expect(contentOf(modal).findByAction('choose-playlist')).not.toBeNull();

        contentOf(modal).findByAction('choose-playlist')!.click();
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(shellOf(modal).cls).toContain('youtnote-plugin__playlist-dialog');
        expect(contentOf(modal).cls).toContain('youtnote-plugin__playlist-modal');
        expect(contentOf(modal).findByAction('cancel')).not.toBeNull();
        expect(contentOf(modal).findByAction('import')).toBeNull();

        deferred.resolve?.({ title: 'Fetched', entries: [entry({ key: 'i0', youtubeId: 'aaaaaaaaaa1' })] });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(shellOf(modal).cls).toContain('youtnote-plugin__playlist-dialog');
        expect(contentOf(modal).cls).toContain('youtnote-plugin__playlist-modal');
        expect(contentOf(modal).findByAction('import')).not.toBeNull();
        modal.close();
        await expect(modal.result).resolves.toBeNull();
    });
});

describe('PlaylistImportModal selection phase', () => {
    const entriesList = [
        entry({ key: 'i0', youtubeId: 'aaaaaaaaaa1' }),
        entry({ key: 'i1', youtubeId: 'aaaaaaaaaa2' }),
        entry({ key: 'i2', youtubeId: 'aaaaaaaaaa3', available: false, title: '' }),
        entry({ key: 'i3', youtubeId: 'aaaaaaaaaa1' }),
        entry({ key: 'i4', youtubeId: 'aaaaaaaaaa4' }),
    ];

    it('starts with an empty queue and lists every entry in the source pane', async () => {
        const modal = await openLoadedModal(entriesList, makeOptions({ existing: ['aaaaaaaaaa4'] }));
        expect(shellOf(modal).dataset.youtnotePlaylistPhase).toBe('select');
        expect(rowKeys(sourceRows(modal))).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
        expect(pendingRows(modal)).toHaveLength(0);
        const rows = sourceRows(modal);
        expect(rows[2].dataset.youtnoteEntryStatus).toBe('unavailable');
        expect(rows[3].dataset.youtnoteEntryStatus).toBe('repeated');
        expect(rows[4].dataset.youtnoteEntryStatus).toBe('existing');
        expect(contentOf(modal).findAllByCls('youtnote-plugin__playlist-existing-note')).toHaveLength(1);
        expect(contentOf(modal).findByTag('input')).toBeNull();
        expect(emptyStateOf(paneList(modal, 'pending'))).not.toBeNull();
        expect(emptyStateOf(paneList(modal, 'pending'))!.cls.split(' ')).not.toContain('youtnote-plugin__playlist-entry');
        expect(rows[0].findByAction('add-entry')!.disabled).toBe(false);
        expect(rows[2].findByAction('add-entry')!.disabled).toBe(true);
        expect(rows[3].findByAction('add-entry')!.disabled).toBe(true);
        expect(rows[4].findByAction('add-entry')!.disabled).toBe(true);
        expect(importButton(modal).disabled).toBe(true);
        expect(importButton(modal).dataset.youtnoteCount).toBe('0');
        expect(contentOf(modal).findByAction('add-all')!.disabled).toBe(false);
        expect(contentOf(modal).findByAction('clear')!.disabled).toBe(true);
        modal.close();
        await expect(modal.result).resolves.toBeNull();
    });

    it('hides the existing-file notice when no fetched entry is already in the file', async () => {
        const modal = await openLoadedModal(entriesList, makeOptions({ existing: ['zzzzzzzzzzz'] }));
        expect(contentOf(modal).findAllByCls('youtnote-plugin__playlist-existing-note')).toHaveLength(0);
        modal.close();
    });

    it('labels each pane list with its own heading', async () => {
        const modal = await openLoadedModal(entriesList);
        const panes = contentOf(modal).findAllByCls('youtnote-plugin__playlist-pane')
            .filter(el => el.cls.split(' ').includes('youtnote-plugin__playlist-pane'));
        expect(panes).toHaveLength(2);
        expect(contentOf(modal).findAllByCls('youtnote-plugin__playlist-pane-toolbar')).toHaveLength(0);
        const headingIds = new Set<string>();
        for (const pane of panes) {
            const headers = pane.findAllByCls('youtnote-plugin__playlist-pane-header');
            const lists = pane.findAllByCls('youtnote-plugin__playlist-list')
                .filter(el => el.cls.split(' ').includes('youtnote-plugin__playlist-list'));
            expect(headers).toHaveLength(1);
            expect(lists).toHaveLength(1);
            const header = headers[0];
            expect(header.children).toHaveLength(3);
            expect(header.children[0].cls.split(' ')).toContain('youtnote-plugin__playlist-pane-title');
            expect(header.children[1].cls.split(' ')).toContain('youtnote-plugin__playlist-pane-count');
            expect(header.children[2].dataset.youtnoteAction).toBe(pane.dataset.youtnotePane === 'source' ? 'add-all' : 'clear');
            const headingId = header.children[0].attr.id;
            expect(headingId).toBeTruthy();
            headingIds.add(headingId);
            expect(lists[0].attr.role).toBe('region');
            expect(lists[0].attr['aria-labelledby']).toBe(headingId);
            expect(lists[0].attr['aria-label']).toBeUndefined();
            expect(lists[0].attr.title).toBeUndefined();
        }
        expect(headingIds.size).toBe(2);
        modal.close();
    });

    it('moves rows between panes and restores the original source order on remove', async () => {
        const modal = await openLoadedModal(entriesList);
        addRow(modal, 'i0');
        addRow(modal, 'i4');
        addRow(modal, 'i1');
        expect(rowKeys(pendingRows(modal))).toEqual(['i0', 'i4', 'i1']);
        expect(rowKeys(sourceRows(modal))).toEqual(['i2', 'i3']);
        sortableCreates[0].options.onEnd?.({ oldIndex: 0, newIndex: 2 });
        expect(rowKeys(pendingRows(modal))).toEqual(['i4', 'i1', 'i0']);
        removeRow(modal, 'i0');
        expect(rowKeys(pendingRows(modal))).toEqual(['i4', 'i1']);
        expect(rowKeys(sourceRows(modal))).toEqual(['i0', 'i2', 'i3']);
        addRow(modal, 'i0');
        expect(rowKeys(pendingRows(modal))).toEqual(['i4', 'i1', 'i0']);
        modal.close();
    });

    it('ignores repeated adds and clicks on disabled rows', async () => {
        const modal = await openLoadedModal(entriesList);
        const staleAdd = sourceRows(modal)[0].findByAction('add-entry')!;
        addRow(modal, 'i0');
        staleAdd.click();
        expect(rowKeys(pendingRows(modal))).toEqual(['i0']);
        sourceRows(modal).find(r => r.dataset.youtnoteEntryKey === 'i2')!.findByAction('add-entry')!.click();
        sourceRows(modal).find(r => r.dataset.youtnoteEntryKey === 'i3')!.findByAction('add-entry')!.click();
        expect(rowKeys(pendingRows(modal))).toEqual(['i0']);
        expect(importButton(modal).dataset.youtnoteCount).toBe('1');
        modal.close();
    });

    it('add-all appends remaining eligible entries in source order', async () => {
        const modal = await openLoadedModal(entriesList);
        addRow(modal, 'i4');
        contentOf(modal).findByAction('add-all')!.click();
        expect(rowKeys(pendingRows(modal))).toEqual(['i4', 'i0', 'i1']);
        expect(rowKeys(sourceRows(modal))).toEqual(['i2', 'i3']);
        expect(contentOf(modal).findByAction('add-all')!.disabled).toBe(true);
        expect(importButton(modal).dataset.youtnoteCount).toBe('3');
        expect(countOf(modal, 'source').dataset.youtnoteCount).toBe('2');
        expect(countOf(modal, 'pending').dataset.youtnoteCount).toBe('3');
        modal.close();
    });

    it('clear returns every entry to the source in its original order', async () => {
        const modal = await openLoadedModal(entriesList);
        addRow(modal, 'i4');
        addRow(modal, 'i0');
        contentOf(modal).findByAction('clear')!.click();
        expect(rowKeys(pendingRows(modal))).toEqual([]);
        expect(rowKeys(sourceRows(modal))).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
        expect(emptyStateOf(paneList(modal, 'pending'))).not.toBeNull();
        expect(contentOf(modal).findByAction('clear')!.disabled).toBe(true);
        expect(importButton(modal).disabled).toBe(true);
        modal.close();
    });

    it('disables bulk actions and import when no entry can be added', async () => {
        const locked = [
            entry({ key: 'i0', youtubeId: null, available: false }),
            entry({ key: 'i1', youtubeId: 'aaaaaaaaaa9' }),
        ];
        const modal = await openLoadedModal(locked, makeOptions({ existing: ['aaaaaaaaaa9'] }));
        expect(rowKeys(sourceRows(modal))).toEqual(['i0', 'i1']);
        expect(pendingRows(modal)).toHaveLength(0);
        expect(contentOf(modal).findByAction('add-all')!.disabled).toBe(true);
        expect(contentOf(modal).findByAction('clear')!.disabled).toBe(true);
        expect(importButton(modal).disabled).toBe(true);
        expect(importButton(modal).dataset.youtnoteCount).toBe('0');
        modal.close();
    });

    it('shows an empty source state once every eligible entry is queued', async () => {
        const modal = await openLoadedModal([
            entry({ key: 'i0', youtubeId: 'aaaaaaaaaa1' }),
            entry({ key: 'i1', youtubeId: 'aaaaaaaaaa2' }),
        ]);
        contentOf(modal).findByAction('add-all')!.click();
        expect(sourceRows(modal)).toHaveLength(0);
        expect(emptyStateOf(paneList(modal, 'source'))).not.toBeNull();
        expect(rowKeys(pendingRows(modal))).toEqual(['i0', 'i1']);
        modal.close();
    });

    it('binds a single sortable to the pending list only', async () => {
        const modal = await openLoadedModal(entriesList);
        expect(sortableCreates).toHaveLength(1);
        expect(sortableCreates[0].el).toBe(paneList(modal, 'pending'));
        expect(sortableCreates[0].options.draggable).toBe('.youtnote-plugin__playlist-entry');
        expect(sortableCreates[0].options.handle).toBe('.youtnote-plugin__playlist-entry-drag');
        expect(sortableCreates[0].options.group).toBeUndefined();
        for (const row of sourceRows(modal)) {
            expect(row.findByAction('drag-handle')).toBeNull();
            expect(row.findByAction('remove-entry')).toBeNull();
            expect(row.findByAction('add-entry')).not.toBeNull();
        }
        addRow(modal, 'i0');
        const pendingRow = pendingRows(modal)[0];
        const handle = pendingRow.findByAction('drag-handle');
        expect(handle).not.toBeNull();
        expect(mockedSetIcon).toHaveBeenCalledWith(handle, 'grip-vertical');
        expect(handle!.text).toBe('');
        expect(pendingRow.findByAction('remove-entry')).not.toBeNull();
        expect(pendingRow.findByAction('add-entry')).toBeNull();
        expect(sortableCreates).toHaveLength(1);
        modal.close();
    });

    it('orders only the pending queue by drag and returns the pending order on import', async () => {
        const three = [
            entry({ key: 'i0', youtubeId: 'aaaaaaaaaa1' }),
            entry({ key: 'i1', youtubeId: 'aaaaaaaaaa2' }),
            entry({ key: 'i2', youtubeId: 'aaaaaaaaaa3' }),
        ];
        const modal = await openLoadedModal(three);
        addRow(modal, 'i1');
        addRow(modal, 'i0');
        addRow(modal, 'i2');
        expect(rowKeys(pendingRows(modal))).toEqual(['i1', 'i0', 'i2']);
        sortableCreates[0].options.onEnd?.({ oldIndex: 2, newIndex: 0 });
        expect(rowKeys(pendingRows(modal))).toEqual(['i2', 'i1', 'i0']);
        contentOf(modal).findByAction('import')!.click();
        await expect(modal.result).resolves.toEqual([three[2], three[1], three[0]]);
    });

    it('ignores out-of-range drag indices', async () => {
        const modal = await openLoadedModal(entriesList);
        addRow(modal, 'i0');
        addRow(modal, 'i1');
        sortableCreates[0].options.onEnd?.({ oldIndex: 5, newIndex: 0 });
        sortableCreates[0].options.onEnd?.({ oldIndex: 0, newIndex: -1 });
        sortableCreates[0].options.onEnd?.({});
        expect(rowKeys(pendingRows(modal))).toEqual(['i0', 'i1']);
        modal.close();
    });

    it('returns the pending entries in queue order on import', async () => {
        const modal = await openLoadedModal(entriesList);
        addRow(modal, 'i4');
        addRow(modal, 'i1');
        contentOf(modal).findByAction('import')!.click();
        await expect(modal.result).resolves.toEqual([entriesList[4], entriesList[1]]);
    });

    it('resolves null when the import is cancelled by closing', async () => {
        const modal = await openLoadedModal(entriesList);
        modal.close();
        await expect(modal.result).resolves.toBeNull();
        expect(sortableDestroy).toHaveBeenCalled();
    });

    it('resolves null and mutates nothing when isValid fails at commit', async () => {
        let valid = true;
        const modal = await openLoadedModal(entriesList, makeOptions({ isValid: () => valid }));
        addRow(modal, 'i0');
        valid = false;
        contentOf(modal).findByAction('import')!.click();
        await expect(modal.result).resolves.toBeNull();
    });

    it('excludes entries that became duplicates after loading when committing', async () => {
        const existing = new Set<string>();
        const modal = await openLoadedModal(entriesList, {
            videoId: undefined,
            getExistingVideoIds: () => existing,
            isValid: () => true,
        });
        addRow(modal, 'i0');
        addRow(modal, 'i1');
        existing.add('aaaaaaaaaa1');
        contentOf(modal).findByAction('import')!.click();
        await expect(modal.result).resolves.toEqual([entriesList[1]]);
    });

    it('keeps scroll positions and moves focus to a usable control after transfers', async () => {
        const modal = await openLoadedModal(entriesList);
        const sourceListEl = paneList(modal, 'source');
        const pendingListEl = paneList(modal, 'pending');
        sourceListEl.scrollTop = 40;
        pendingListEl.scrollTop = 15;
        addRow(modal, 'i0');
        expect(sourceListEl.scrollTop).toBe(40);
        expect(pendingListEl.scrollTop).toBe(15);
        const nextAdd = sourceRows(modal).find(r => r.dataset.youtnoteEntryKey === 'i1')!.findByAction('add-entry')!;
        expect(nextAdd.focused).toBe(true);

        addRow(modal, 'i4');
        removeRow(modal, 'i0');
        const remainingRemove = pendingRows(modal).find(r => r.dataset.youtnoteEntryKey === 'i4')!.findByAction('remove-entry')!;
        expect(remainingRemove.focused).toBe(true);

        removeRow(modal, 'i4');
        const restoredAdd = sourceRows(modal).find(r => r.dataset.youtnoteEntryKey === 'i4')!.findByAction('add-entry')!;
        expect(restoredAdd.focused).toBe(true);

        contentOf(modal).findByAction('add-all')!.click();
        expect(contentOf(modal).findByAction('clear')!.focused).toBe(true);
        contentOf(modal).findByAction('clear')!.click();
        expect(contentOf(modal).findByAction('add-all')!.focused).toBe(true);
        modal.close();
    });
});

describe('PlaylistImportModal loading and error phases', () => {
    it('shows a loading phase with cancel while the fetch is pending', async () => {
        const deferred: { resolve?: (result: PlaylistResult) => void } = {};
        mockedFetch.mockImplementation(() => new Promise<PlaylistResult>(resolve => { deferred.resolve = resolve; }));
        const modal = new PlaylistImportModal(app, PLAYLIST_ID, makeOptions());
        modal.open();
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(contentOf(modal).findByAction('cancel')).not.toBeNull();
        expect(contentOf(modal).findByAction('import')).toBeNull();
        const progressWrap = contentOf(modal).findAllByCls('youtnote-plugin__playlist-progress')[0];
        expect(progressWrap.children.map(c => c.cls)).toEqual([
            'youtnote-plugin__playlist-progress-text',
            'youtnote-plugin__playlist-progress-indicator',
        ]);
        const indicator = progressWrap.children[1];
        expect(indicator.children).toHaveLength(1);
        expect(indicator.children[0].cls).toBe('youtnote-plugin__dot-pulse');
        expect(progressWrap.findAllByCls('youtnote-plugin__dot-pulse')).toHaveLength(1);
        contentOf(modal).findByAction('cancel')!.click();
        await expect(modal.result).resolves.toBeNull();
        deferred.resolve?.({ title: 'late', entries: [] });
        await Promise.resolve();
        await Promise.resolve();
        expect(contentOf(modal).findByAction('import')).toBeNull();
    });

    it('resolves null and renders no entries when the target becomes invalid while loading', async () => {
        let valid = true;
        const deferred: { resolve?: (result: PlaylistResult) => void } = {};
        mockedFetch.mockImplementation(() => new Promise<PlaylistResult>(resolve => { deferred.resolve = resolve; }));
        const modal = new PlaylistImportModal(app, PLAYLIST_ID, makeOptions({ isValid: () => valid }));
        modal.open();
        await Promise.resolve();
        valid = false;
        deferred.resolve?.({ title: 'late', entries: [entry({ key: 'i0', youtubeId: 'aaaaaaaaaa1' })] });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(contentOf(modal).findAllByCls('youtnote-plugin__playlist-list')).toHaveLength(0);
        expect(contentOf(modal).findByAction('import')).toBeNull();
        await expect(modal.result).resolves.toBeNull();
    });

    it('shows an error phase with a stable error code and offers video fallback', async () => {
        mockedFetch.mockRejectedValue(new PlaylistError('timeout', 'slow'));
        const modal = new PlaylistImportModal(app, PLAYLIST_ID, makeOptions({ videoId: 'aircAruvnKk' }));
        modal.open();
        contentOf(modal).findByAction('choose-playlist')!.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(shellOf(modal).cls).toContain('youtnote-plugin__playlist-dialog');
        expect(contentOf(modal).cls).toContain('youtnote-plugin__playlist-modal');
        const errorEl = contentOf(modal).findAllByCls('youtnote-plugin__playlist-error');
        expect(errorEl).toHaveLength(1);
        expect(errorEl[0].dataset.youtnoteErrorCode).toBe('timeout');
        expect(contentOf(modal).findByAction('import')).toBeNull();
        contentOf(modal).findByAction('choose-video')!.click();
        await expect(modal.result).resolves.toBe('video');
    });

    it('closing during loading aborts the fetch signal and resolves null', async () => {
        let signal: AbortSignal | undefined;
        mockedFetch.mockImplementation((_id: string, options?: { signal?: AbortSignal; onProgress?: (loaded: number) => void }) => {
            signal = options?.signal;
            return new Promise<PlaylistResult>(() => {});
        });
        const modal = new PlaylistImportModal(app, PLAYLIST_ID, makeOptions());
        modal.open();
        expect(signal).toBeDefined();
        expect(signal!.aborted).toBe(false);
        modal.close();
        expect(signal!.aborted).toBe(true);
        await expect(modal.result).resolves.toBeNull();
    });
});

describe('PlaylistImportModal provided links', () => {
    const PASTED = `1. https://youtu.be/aaaaaaaaaa1\n2. https://www.youtube.com/watch?v=aaaaaaaaaa2`;

    const providedEntries = [
        entry({ key: 'p0', youtubeId: 'aaaaaaaaaa1' }),
        entry({ key: 'p1', youtubeId: 'aaaaaaaaaa2', available: false }),
        entry({ key: 'p2', youtubeId: 'aaaaaaaaaa3' }),
    ];

    function openProvidedModal(options = makeOptions()) {
        const modal = new PlaylistImportModal(app, { kind: 'provided' }, options);
        modal.open();
        return modal;
    }

    function inputOf(modal: InstanceType<typeof PlaylistImportModal>): FakeEl {
        const input = contentOf(modal).findByAction('url-input');
        expect(input).not.toBeNull();
        return input!;
    }

    function typeProvidedText(modal: InstanceType<typeof PlaylistImportModal>, text: string): void {
        const input = inputOf(modal);
        input.value = text;
        input.listeners.input?.();
    }

    function loadProvidedText(modal: InstanceType<typeof PlaylistImportModal>, text: string): void {
        typeProvidedText(modal, text);
        contentOf(modal).findByAction('load-videos')!.click();
    }

    function selectButtons(modal: InstanceType<typeof PlaylistImportModal>): FakeEl[] {
        const found: FakeEl[] = [];
        const walk = (el: FakeEl): void => {
            for (const child of el.children) {
                if (child.dataset.youtnoteAction === 'select-invalid-entry') {
                    found.push(child);
                }
                walk(child);
            }
        };
        walk(contentOf(modal));
        return found;
    }

    function invalidTextEls(modal: InstanceType<typeof PlaylistImportModal>): FakeEl[] {
        return contentOf(modal).findAllByCls('youtnote-plugin__playlist-invalid-text');
    }

    function feedbackErrors(modal: InstanceType<typeof PlaylistImportModal>): FakeEl[] {
        return contentOf(modal).findAllByCls('youtnote-plugin__playlist-input-error');
    }

    it('opens the paste input without fetching and enables load only with text', async () => {
        const modal = openProvidedModal();
        expect(mockedFetch).not.toHaveBeenCalled();
        expect(mockedProvidedFetch).not.toHaveBeenCalled();
        expect(contentOf(modal).findByAction('import')).toBeNull();
        expect(contentOf(modal).findByAction('choose-playlist')).toBeNull();
        const input = inputOf(modal);
        expect(input.value).toBe('');
        const messages = contentOf(modal).findAllByCls('youtnote-plugin__base-modal-message');
        expect(messages).toHaveLength(1);
        const instructionId = messages[0].attr.id;
        expect(instructionId).toBeTruthy();
        expect(input.attr['aria-labelledby']).toBe(instructionId);
        expect(input.attr['aria-label']).toBeUndefined();
        expect(input.attr.title).toBeUndefined();
        expect(contentOf(modal).findByAction('load-videos')!.disabled).toBe(true);
        typeProvidedText(modal, `https://youtu.be/aaaaaaaaaa1`);
        expect(contentOf(modal).findByAction('load-videos')!.disabled).toBe(false);
        contentOf(modal).findByAction('cancel')!.click();
        await expect(modal.result).resolves.toBeNull();
    });

    it('ignores the video fallback option for a provided source', async () => {
        const modal = openProvidedModal(makeOptions({ videoId: 'aircAruvnKk' }));
        expect(inputOf(modal)).toBeDefined();
        expect(contentOf(modal).findByAction('choose-video')).toBeNull();
        expect(contentOf(modal).findByAction('choose-playlist')).toBeNull();
        expect(mockedFetch).not.toHaveBeenCalled();
        expect(mockedProvidedFetch).not.toHaveBeenCalled();
        modal.close();
    });

    it('lists raw invalid entries with select buttons and no fetch, keeping the text', async () => {
        const modal = openProvidedModal();
        const bad = 'bad line';
        const playlistOnly = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
        const pasted = `https://youtu.be/aaaaaaaaaa1\n${bad}\n${playlistOnly}`;
        const inputBefore = inputOf(modal);
        loadProvidedText(modal, pasted);
        expect(mockedProvidedFetch).not.toHaveBeenCalled();
        expect(feedbackErrors(modal)).toHaveLength(1);
        expect(feedbackErrors(modal)[0].dataset.youtnoteErrorCode).toBe('invalid');
        expect(feedbackErrors(modal)[0].dataset.youtnoteInvalidLines).toBe('2 3');
        expect(feedbackErrors(modal)[0].attr.role).toBeUndefined();
        const summaries = contentOf(modal).findAllByCls('youtnote-plugin__playlist-invalid-summary');
        expect(summaries).toHaveLength(1);
        expect(summaries[0].attr.role).toBe('status');
        expect(summaries[0].attr['aria-live']).toBe('polite');
        expect(invalidTextEls(modal).map(el => el.text)).toEqual([bad, playlistOnly]);
        const buttons = selectButtons(modal);
        expect(buttons).toHaveLength(2);
        expect(buttons[0].dataset.youtnoteStart).toBe(String(pasted.indexOf(bad)));
        expect(buttons[0].dataset.youtnoteEnd).toBe(String(pasted.indexOf(bad) + bad.length));
        const input = inputOf(modal);
        expect(input).toBe(inputBefore);
        expect(input.value).toBe(pasted);
        expect(input.focused).toBe(true);
        expect(input.selectionStart).toBe(pasted.indexOf(bad));
        expect(input.selectionEnd).toBe(pasted.indexOf(bad) + bad.length);
        modal.close();
        await expect(modal.result).resolves.toBeNull();
    });

    it('selects the clicked invalid entry range, including a later duplicate', async () => {
        const modal = openProvidedModal();
        const bad = 'not a link';
        const pasted = `https://youtu.be/aaaaaaaaaa1\n${bad}\n${bad}`;
        loadProvidedText(modal, pasted);
        const input = inputOf(modal);
        expect(input.selectionStart).toBe(pasted.indexOf(bad));
        const buttons = selectButtons(modal);
        expect(buttons).toHaveLength(2);
        buttons[1].click();
        const secondStart = pasted.lastIndexOf(bad);
        expect(input.selectionStart).toBe(secondStart);
        expect(input.selectionEnd).toBe(secondStart + bad.length);
        expect(input.value).toBe(pasted);
        modal.close();
    });

    it('targets the right entry range across blank lines and unordered numbering', async () => {
        const modal = openProvidedModal();
        const bad = '7. broken entry';
        const pasted = `1. https://youtu.be/aaaaaaaaaa1\n\n\n3. https://youtu.be/aaaaaaaaaa2\n${bad}\n2. https://youtu.be/aaaaaaaaaa3`;
        loadProvidedText(modal, pasted);
        const buttons = selectButtons(modal);
        expect(buttons).toHaveLength(1);
        buttons[0].click();
        const input = inputOf(modal);
        const start = pasted.indexOf(bad);
        expect(input.selectionStart).toBe(start);
        expect(input.selectionEnd).toBe(start + bad.length);
        modal.close();
    });

    it('refreshes entries and ranges on edits without touching caret, focus or scroll', async () => {
        const modal = openProvidedModal();
        const pasted = `https://youtu.be/aaaaaaaaaa1\nbad one`;
        loadProvidedText(modal, pasted);
        expect(selectButtons(modal)).toHaveLength(1);
        const input = inputOf(modal);
        input.selectionStart = 999;
        input.selectionEnd = 999;
        input.scrollTop = 12;
        input.focused = false;
        const edited = `https://youtu.be/aaaaaaaaaa1\nhttps://youtu.be/aaaaaaaaaa2\nworse entry here`;
        input.value = edited;
        input.listeners.input?.();
        expect(invalidTextEls(modal).map(el => el.text)).toEqual(['worse entry here']);
        const buttons = selectButtons(modal);
        expect(buttons).toHaveLength(1);
        expect(input.selectionStart).toBe(999);
        expect(input.selectionEnd).toBe(999);
        expect(input.scrollTop).toBe(12);
        expect(input.focused).toBe(false);
        buttons[0].click();
        const start = edited.indexOf('worse entry here');
        expect(input.selectionStart).toBe(start);
        expect(input.selectionEnd).toBe(start + 'worse entry here'.length);
        expect(input.focused).toBe(true);
        expect(mockedProvidedFetch).not.toHaveBeenCalled();
        modal.close();
    });

    it('clears fixed issues without fetching and shows new ones on later edits', async () => {
        const modal = openProvidedModal();
        loadProvidedText(modal, `https://youtu.be/aaaaaaaaaa1\nbroken entry`);
        expect(selectButtons(modal)).toHaveLength(1);
        const input = inputOf(modal);
        input.value = `https://youtu.be/aaaaaaaaaa1\nhttps://youtu.be/aaaaaaaaaa2`;
        input.listeners.input?.();
        expect(feedbackErrors(modal)).toHaveLength(0);
        expect(mockedProvidedFetch).not.toHaveBeenCalled();
        input.value = `${input.value}\nagain bad`;
        input.listeners.input?.();
        expect(invalidTextEls(modal).map(el => el.text)).toEqual(['again bad']);
        expect(mockedProvidedFetch).not.toHaveBeenCalled();
        modal.close();
    });

    it('ignores a stale select button after the text changed', async () => {
        const modal = openProvidedModal();
        loadProvidedText(modal, `https://youtu.be/aaaaaaaaaa1\nbad entry`);
        const staleButton = selectButtons(modal)[0];
        const input = inputOf(modal);
        input.value = `https://youtu.be/aaaaaaaaaa1\nworse entry`;
        input.listeners.input?.();
        input.selectionStart = 5;
        input.selectionEnd = 5;
        staleButton.click();
        expect(input.selectionStart).toBe(5);
        expect(input.selectionEnd).toBe(5);
        modal.close();
    });

    it('does not select entries when the modal is closed or no longer valid', async () => {
        let valid = true;
        const modal = openProvidedModal(makeOptions({ isValid: () => valid }));
        loadProvidedText(modal, `https://youtu.be/aaaaaaaaaa1\nbad entry`);
        const input = inputOf(modal);
        const button = selectButtons(modal)[0];
        input.selectionStart = -1;
        input.selectionEnd = -1;
        valid = false;
        button.click();
        expect(input.selectionStart).toBe(-1);
        valid = true;
        modal.close();
        button.click();
        expect(input.selectionStart).toBe(-1);
    });

    it('shows global errors without per-entry select buttons', async () => {
        const modal = openProvidedModal();
        const line = `https://youtu.be/aaaaaaaaaa1`;
        loadProvidedText(modal, Array.from({ length: 1001 }, () => line).join('\n'));
        const errors = feedbackErrors(modal);
        expect(errors).toHaveLength(1);
        expect(errors[0].dataset.youtnoteErrorCode).toBe('limit');
        expect(errors[0].attr.role).toBe('alert');
        expect(selectButtons(modal)).toHaveLength(0);
        expect(inputOf(modal).focused).toBe(true);
        expect(mockedProvidedFetch).not.toHaveBeenCalled();
        modal.close();
    });

    it('loads parsed canonical links through the provided loader only', async () => {
        mockedProvidedFetch.mockResolvedValue({ title: 'Provided videos', entries: providedEntries });
        const modal = openProvidedModal();
        loadProvidedText(modal, PASTED);
        expect(mockedProvidedFetch).toHaveBeenCalledTimes(1);
        expect(mockedFetch).not.toHaveBeenCalled();
        const [videosArg] = mockedProvidedFetch.mock.calls[0];
        expect(videosArg.map(v => v.youtubeId)).toEqual(['aaaaaaaaaa1', 'aaaaaaaaaa2']);
        expect(videosArg.map(v => v.url)).toEqual([
            'https://www.youtube.com/watch?v=aaaaaaaaaa1',
            'https://www.youtube.com/watch?v=aaaaaaaaaa2',
        ]);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(rowKeys(sourceRows(modal))).toEqual(['p0', 'p1', 'p2']);
        modal.close();
    });

    it('marks failed, repeated and existing provided rows with stable statuses', async () => {
        const entries = [
            entry({ key: 'p0', youtubeId: 'aaaaaaaaaa1' }),
            entry({ key: 'p1', youtubeId: 'aaaaaaaaaa2', available: false }),
            entry({ key: 'p2', youtubeId: 'aaaaaaaaaa3', available: false }),
            entry({ key: 'p3', youtubeId: 'aaaaaaaaaa1' }),
        ];
        mockedProvidedFetch.mockResolvedValue({ title: 'Provided videos', entries });
        const modal = openProvidedModal(makeOptions({ existing: ['aaaaaaaaaa3'] }));
        loadProvidedText(modal, `https://youtu.be/aaaaaaaaaa1`);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        const rows = sourceRows(modal);
        expect(rows[1].dataset.youtnoteEntryStatus).toBe('load-failed');
        expect(rows[2].dataset.youtnoteEntryStatus).toBe('existing');
        expect(rows[3].dataset.youtnoteEntryStatus).toBe('repeated');
        expect(rows[1].findByAction('add-entry')!.disabled).toBe(true);
        expect(rows[2].findByAction('add-entry')!.disabled).toBe(true);
        expect(rows[3].findByAction('add-entry')!.disabled).toBe(true);
        expect(contentOf(modal).findAllByCls('youtnote-plugin__playlist-existing-note')).toHaveLength(1);
        contentOf(modal).findByAction('add-all')!.click();
        expect(rowKeys(pendingRows(modal))).toEqual(['p0']);
        modal.close();
    });

    it('treats a single pasted watch url with a playlist param as a provided video', async () => {
        mockedProvidedFetch.mockResolvedValue({ title: 'Provided videos', entries: providedEntries });
        const modal = openProvidedModal();
        loadProvidedText(modal, `https://www.youtube.com/watch?v=aaaaaaaaaa1&list=RDMix12345`);
        expect(mockedProvidedFetch).toHaveBeenCalledTimes(1);
        expect(mockedFetch).not.toHaveBeenCalled();
        const [videosArg] = mockedProvidedFetch.mock.calls[0];
        expect(videosArg).toHaveLength(1);
        expect(videosArg[0].url).toBe('https://www.youtube.com/watch?v=aaaaaaaaaa1');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(rowKeys(sourceRows(modal))).toEqual(['p0', 'p1', 'p2']);
        expect(contentOf(modal).findByAction('choose-video')).toBeNull();
        expect(contentOf(modal).findByAction('choose-playlist')).toBeNull();
        modal.close();
    });

    it('returns to the input with text intact from loading and select, aborting the fetch', async () => {
        let signal: AbortSignal | undefined;
        const deferreds: { resolve: (result: PlaylistResult) => void }[] = [];
        mockedProvidedFetch.mockImplementation((_videos: unknown, options?: { signal?: AbortSignal }) => {
            signal = options?.signal;
            return new Promise<PlaylistResult>(resolve => { deferreds.push({ resolve }); });
        });
        const modal = openProvidedModal();
        loadProvidedText(modal, PASTED);
        expect(mockedProvidedFetch).toHaveBeenCalledTimes(1);
        contentOf(modal).findByAction('back')!.click();
        expect(signal!.aborted).toBe(true);
        expect(inputOf(modal).value).toBe(PASTED);

        loadProvidedText(modal, PASTED);
        expect(mockedProvidedFetch).toHaveBeenCalledTimes(2);
        deferreds[1].resolve({ title: 'Provided videos', entries: providedEntries });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(rowKeys(sourceRows(modal))).toEqual(['p0', 'p1', 'p2']);
        contentOf(modal).findByAction('back')!.click();
        expect(inputOf(modal).value).toBe(PASTED);
        modal.close();
        await expect(modal.result).resolves.toBeNull();
    });

    it('ignores a stale result after going back and reloading', async () => {
        const deferreds: { resolve: (result: PlaylistResult) => void }[] = [];
        mockedProvidedFetch.mockImplementation(() => new Promise<PlaylistResult>(resolve => { deferreds.push({ resolve }); }));
        const modal = openProvidedModal();
        loadProvidedText(modal, PASTED);
        contentOf(modal).findByAction('back')!.click();
        loadProvidedText(modal, PASTED);
        expect(mockedProvidedFetch).toHaveBeenCalledTimes(2);
        deferreds[0].resolve({ title: 'Stale', entries: providedEntries });
        await Promise.resolve();
        await Promise.resolve();
        expect(contentOf(modal).findAllByCls('youtnote-plugin__playlist-columns')).toHaveLength(0);
        deferreds[1].resolve({ title: 'Provided videos', entries: providedEntries });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(rowKeys(sourceRows(modal))).toEqual(['p0', 'p1', 'p2']);
        modal.close();
    });

    it('offers back, retry and cancel on a fatal failure and retries the same links', async () => {
        mockedProvidedFetch.mockRejectedValueOnce(new PlaylistError('timeout', 'slow'));
        const modal = openProvidedModal();
        loadProvidedText(modal, PASTED);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(contentOf(modal).findAllByCls('youtnote-plugin__playlist-error')[0].dataset.youtnoteErrorCode).toBe('timeout');
        expect(contentOf(modal).findByAction('back')).not.toBeNull();
        expect(contentOf(modal).findByAction('retry')).not.toBeNull();
        expect(contentOf(modal).findByAction('cancel')).not.toBeNull();
        expect(contentOf(modal).findByAction('import')).toBeNull();

        mockedProvidedFetch.mockResolvedValueOnce({ title: 'Provided videos', entries: providedEntries });
        contentOf(modal).findByAction('retry')!.click();
        expect(mockedProvidedFetch).toHaveBeenCalledTimes(2);
        const [videosArg] = mockedProvidedFetch.mock.calls[1];
        expect(videosArg.map(v => v.youtubeId)).toEqual(['aaaaaaaaaa1', 'aaaaaaaaaa2']);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(rowKeys(sourceRows(modal))).toEqual(['p0', 'p1', 'p2']);
        modal.close();
    });

    it('returns queued provided entries in display order and keeps the provided footer order', async () => {
        const entries = [
            entry({ key: 'p0', youtubeId: 'aaaaaaaaaa1' }),
            entry({ key: 'p1', youtubeId: 'aaaaaaaaaa2' }),
            entry({ key: 'p2', youtubeId: 'aaaaaaaaaa3' }),
        ];
        mockedProvidedFetch.mockResolvedValue({ title: 'Provided videos', entries });
        const modal = openProvidedModal();
        loadProvidedText(modal, PASTED);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        const buttonsEl = contentOf(modal).findAllByCls('youtnote-plugin__base-modal-buttons')
            .find(el => el.findByAction('import') !== null);
        expect(buttonsEl!.children.map(c => c.dataset.youtnoteAction)).toEqual(['import', 'back', 'cancel']);
        addRow(modal, 'p1');
        addRow(modal, 'p0');
        sortableCreates[0].options.onEnd?.({ oldIndex: 1, newIndex: 0 });
        expect(rowKeys(pendingRows(modal))).toEqual(['p0', 'p1']);
        contentOf(modal).findByAction('import')!.click();
        await expect(modal.result).resolves.toEqual([entries[0], entries[1]]);
    });
});
