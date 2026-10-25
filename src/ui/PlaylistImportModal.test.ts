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
        checked: boolean;
        disabled: boolean;
        focused: boolean;
        empty(): void;
        addClass(cls: string): void;
        createDiv(options?: { cls?: string; text?: string }): FakeEl;
        createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeEl;
        createSpan(options?: { text?: string; cls?: string }): FakeEl;
        appendChild(child: FakeEl): FakeEl;
        setText(text: string): void;
        addEventListener(type: string, handler: () => void): void;
        focus(): void;
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
            checked: false,
            disabled: false,
            focused: false,
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
        sortableCreates: [] as { el: unknown; options: { onEnd?: (e: { oldIndex?: number; newIndex?: number }) => void } }[],
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
        create(el: unknown, options: { onEnd?: (e: { oldIndex?: number; newIndex?: number }) => void }) {
            sortableCreates.push({ el, options });
            return { destroy: sortableDestroy };
        },
    },
}));

vi.mock('../playlistFetch', () => ({
    fetchPlaylist: vi.fn(),
}));

const { fetchPlaylist } = await import('../playlistFetch');
const mockedFetch = vi.mocked(fetchPlaylist);
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

function listRows(modal: InstanceType<typeof PlaylistImportModal>): FakeEl[] {
    const lists = contentOf(modal).findAllByCls('youtnote-plugin__playlist-list');
    expect(lists).toHaveLength(1);
    return lists[0].children.filter(row => row.cls.includes('youtnote-plugin__playlist-entry'));
}

function rowCheckbox(row: FakeEl): FakeEl {
    const checkbox = row.findByTag('input');
    expect(checkbox).not.toBeNull();
    return checkbox!;
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

    it('checks eligible entries and disables unavailable, existing and repeated ones', async () => {
        const modal = await openLoadedModal(entriesList, makeOptions({ existing: ['aaaaaaaaaa4'] }));
        const rows = listRows(modal);
        expect(rows).toHaveLength(5);
        expect(rows.map(r => r.dataset.youtnoteEntryKey)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
        expect(rows[2].dataset.youtnoteEntryStatus).toBe('unavailable');
        expect(rows[3].dataset.youtnoteEntryStatus).toBe('repeated');
        expect(rows[4].dataset.youtnoteEntryStatus).toBe('existing');
        expect(rowCheckbox(rows[0]).checked).toBe(true);
        expect(rowCheckbox(rows[1]).checked).toBe(true);
        expect(rowCheckbox(rows[2]).disabled).toBe(true);
        expect(rowCheckbox(rows[3]).disabled).toBe(true);
        expect(rowCheckbox(rows[4]).disabled).toBe(true);
        expect(importButton(modal).disabled).toBe(false);
        expect(importButton(modal).dataset.youtnoteCount).toBe('2');
        modal.close();
        await expect(modal.result).resolves.toBeNull();
    });

    it('check-all and check-none update selection and the count', async () => {
        const modal = await openLoadedModal(entriesList);
        contentOf(modal).findByAction('check-none')!.click();
        expect(importButton(modal).dataset.youtnoteCount).toBe('0');
        expect(importButton(modal).disabled).toBe(true);
        const rows = listRows(modal);
        expect(rowCheckbox(rows[0]).checked).toBe(false);
        expect(rowCheckbox(rows[1]).checked).toBe(false);
        contentOf(modal).findByAction('check-all')!.click();
        expect(importButton(modal).dataset.youtnoteCount).toBe('3');
        expect(importButton(modal).disabled).toBe(false);
        expect(rowCheckbox(rows[0]).checked).toBe(true);
        expect(rowCheckbox(rows[3]).disabled).toBe(true);
        modal.close();
    });

    it('toggling a checkbox updates the count', async () => {
        const modal = await openLoadedModal(entriesList);
        const rows = listRows(modal);
        const checkbox = rowCheckbox(rows[0]);
        checkbox.checked = false;
        checkbox.listeners.change?.();
        expect(importButton(modal).dataset.youtnoteCount).toBe('2');
        checkbox.checked = true;
        checkbox.listeners.change?.();
        expect(importButton(modal).dataset.youtnoteCount).toBe('3');
        modal.close();
    });

    it('returns selected entries in displayed order on import', async () => {
        const modal = await openLoadedModal(entriesList);
        const rows = listRows(modal);
        const checkbox = rowCheckbox(rows[1]);
        checkbox.checked = false;
        checkbox.listeners.change?.();
        contentOf(modal).findByAction('import')!.click();
        await expect(modal.result).resolves.toEqual([
            entriesList[0],
            entriesList[4],
        ]);
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
        existing.add('aaaaaaaaaa1');
        contentOf(modal).findByAction('import')!.click();
        await expect(modal.result).resolves.toEqual([
            entriesList[1],
            entriesList[4],
        ]);
    });
});

describe('PlaylistImportModal reordering', () => {
    const entriesList = [
        entry({ key: 'i0', youtubeId: 'aaaaaaaaaa1' }),
        entry({ key: 'i1', youtubeId: 'aaaaaaaaaa2' }),
        entry({ key: 'i2', youtubeId: 'aaaaaaaaaa3' }),
    ];

    it('creates a sortable list and destroys it on close', async () => {
        const modal = await openLoadedModal(entriesList);
        expect(sortableCreates).toHaveLength(1);
        modal.close();
        expect(sortableDestroy).toHaveBeenCalled();
    });

    it('keeps checked state and returns reordered entries after a drag', async () => {
        const modal = await openLoadedModal(entriesList);
        const rows = listRows(modal);
        const checkbox = rowCheckbox(rows[0]);
        checkbox.checked = false;
        checkbox.listeners.change?.();
        sortableCreates[0].options.onEnd?.({ oldIndex: 2, newIndex: 0 });
        const reorderedRows = listRows(modal);
        expect(reorderedRows.map(r => r.dataset.youtnoteEntryKey)).toEqual(['i2', 'i0', 'i1']);
        expect(rowCheckbox(reorderedRows[1]).checked).toBe(false);
        contentOf(modal).findByAction('import')!.click();
        await expect(modal.result).resolves.toEqual([
            entriesList[2],
            entriesList[1],
        ]);
    });

    it('renders every row with a drag handle and no button elements', async () => {
        const modal = await openLoadedModal(entriesList);
        const rows = listRows(modal);
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            const handle = row.findByAction('drag-handle');
            expect(handle).not.toBeNull();
            expect(mockedSetIcon).toHaveBeenCalledWith(handle, 'grip-vertical');
            expect(handle!.text).toBe('');
            expect(row.findByTag('button')).toBeNull();
        }
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
