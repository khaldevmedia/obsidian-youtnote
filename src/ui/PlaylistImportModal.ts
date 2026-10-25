import { App, Modal, setIcon } from 'obsidian';
import Sortable from 'sortablejs';
import type { SortableEvent } from 'sortablejs';
import { fetchPlaylist } from '../playlistFetch';
import { classifyPlaylistId, PlaylistError } from '../playlist';
import type { PlaylistEntry, PlaylistIdKind } from '../playlist';

export type PlaylistImportResult = 'video' | PlaylistEntry[] | null;

export interface PlaylistImportModalOptions {
    videoId?: string | undefined;
    getExistingVideoIds: () => Set<string>;
    isValid: () => boolean;
}

type PlaylistImportPhase = 'choice' | 'unsupported' | 'loading' | 'error' | 'select';
type EntryDisabledReason = 'unavailable' | 'existing' | 'repeated';

function disabledReasonText(reason: EntryDisabledReason): string {
    switch (reason) {
        case 'existing':
            return 'Already in the list';
        case 'repeated':
            return 'Repeated in this playlist';
        default:
            return 'Unavailable';
    }
}

function describeFetchError(error: unknown): { code: string; message: string } {
    if (error instanceof PlaylistError) {
        switch (error.code) {
            case 'unavailable':
                return { code: error.code, message: 'The playlist is unavailable or does not exist.' };
            case 'timeout':
                return { code: error.code, message: 'The playlist request timed out.' };
            case 'limit':
                return { code: error.code, message: 'This playlist exceeds the import safety limit (1000 videos or 20 pages). Nothing was imported.' };
            case 'invalid-response':
                return { code: error.code, message: 'YouTube returned an unexpected response.' };
            case 'http':
                return { code: error.code, message: 'Could not reach YouTube.' };
            case 'cancelled':
                return { code: error.code, message: 'The import was cancelled.' };
            default:
                return { code: error.code, message: 'The playlist could not be loaded.' };
        }
    }
    return { code: 'unknown', message: 'The playlist could not be loaded.' };
}

export class PlaylistImportModal extends Modal {
    readonly result: Promise<PlaylistImportResult>;

    private resolveResult: ((result: PlaylistImportResult) => void) | null = null;
    private readonly playlistId: string;
    private readonly playlistKind: PlaylistIdKind;
    private readonly options: PlaylistImportModalOptions;
    private phase: PlaylistImportPhase;
    private closed = false;
    private fetchStarted = false;
    private abortController: AbortController | null = null;
    private sortable: Sortable | null = null;
    private playlistTitle = '';
    private entries: PlaylistEntry[] = [];
    private entriesByKey = new Map<string, PlaylistEntry>();
    private orderedKeys: string[] = [];
    private readonly selected = new Set<string>();
    private readonly disabledReasons = new Map<string, EntryDisabledReason>();
    private errorCode = '';
    private errorMessage = '';
    private progressCount = 0;
    private progressEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private importButtonEl: HTMLButtonElement | null = null;
    private readonly rowEls = new Map<string, HTMLElement>();
    private readonly checkboxEls = new Map<string, HTMLInputElement>();

    constructor(app: App, playlistId: string, options: PlaylistImportModalOptions) {
        super(app);
        this.playlistId = playlistId;
        this.options = options;
        this.playlistKind = classifyPlaylistId(playlistId);
        if (this.playlistKind === 'invalid') {
            this.phase = 'error';
            this.errorCode = 'invalid';
            this.errorMessage = 'This is not a supported playlist link.';
        } else if (this.playlistKind === 'mix' || this.playlistKind === 'unsupported') {
            this.phase = 'unsupported';
        } else if (options.videoId) {
            this.phase = 'choice';
        } else {
            this.phase = 'loading';
        }
        this.result = new Promise<PlaylistImportResult>(resolve => {
            this.resolveResult = resolve;
        });
    }

    onOpen(): void {
        this.modalEl.addClass('youtnote-plugin__playlist-dialog');
        this.contentEl.empty();
        this.contentEl.addClass('youtnote-plugin__playlist-modal');
        if (this.phase === 'loading') {
            this.startFetch();
        }
        this.render();
    }

    onClose(): void {
        this.closed = true;
        this.abortController?.abort();
        this.abortController = null;
        this.sortable?.destroy();
        this.sortable = null;
        this.settle(null);
        this.progressEl = null;
        this.listEl = null;
        this.countEl = null;
        this.importButtonEl = null;
        this.rowEls.clear();
        this.checkboxEls.clear();
        this.contentEl.empty();
    }

    private settle(result: PlaylistImportResult): void {
        if (this.resolveResult === null) {
            return;
        }
        const resolve = this.resolveResult;
        this.resolveResult = null;
        resolve(result);
    }

    private settleAndClose(result: PlaylistImportResult): void {
        this.settle(result);
        this.close();
    }

    private startFetch(): void {
        if (this.fetchStarted) {
            return;
        }
        if (this.closed || !this.options.isValid()) {
            this.settleAndClose(null);
            return;
        }
        this.fetchStarted = true;
        this.phase = 'loading';
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        void fetchPlaylist(this.playlistId, {
            signal,
            onProgress: loaded => {
                if (this.closed || signal.aborted || !this.options.isValid()) {
                    return;
                }
                this.progressCount = loaded;
                this.updateProgressText();
            },
        }).then(result => {
            if (this.closed || signal.aborted) {
                return;
            }
            if (!this.options.isValid()) {
                this.settleAndClose(null);
                return;
            }
            this.playlistTitle = result.title;
            this.entries = result.entries;
            this.prepareSelection();
            this.phase = 'select';
            this.render();
        }).catch((error: unknown) => {
            if (this.closed || signal.aborted) {
                return;
            }
            if (!this.options.isValid()) {
                this.settleAndClose(null);
                return;
            }
            const described = describeFetchError(error);
            this.errorCode = described.code;
            this.errorMessage = described.message;
            this.phase = 'error';
            this.render();
        });
    }

    private prepareSelection(): void {
        const existing = this.options.getExistingVideoIds();
        const seen = new Set<string>();
        this.entriesByKey.clear();
        this.orderedKeys = [];
        this.selected.clear();
        this.disabledReasons.clear();
        for (const entry of this.entries) {
            this.entriesByKey.set(entry.key, entry);
            this.orderedKeys.push(entry.key);
            if (!entry.available || entry.youtubeId === null) {
                this.disabledReasons.set(entry.key, 'unavailable');
            } else if (existing.has(entry.youtubeId)) {
                this.disabledReasons.set(entry.key, 'existing');
            } else if (seen.has(entry.youtubeId)) {
                this.disabledReasons.set(entry.key, 'repeated');
            } else {
                seen.add(entry.youtubeId);
                this.selected.add(entry.key);
            }
        }
    }

    private titleText(): string {
        switch (this.phase) {
            case 'unsupported':
                return 'Playlist not supported';
            case 'error':
                return 'Unable to load playlist';
            default:
                return 'Import playlist';
        }
    }

    private render(): void {
        if (this.closed) {
            return;
        }
        const { contentEl } = this;
        contentEl.empty();
        this.progressEl = null;
        this.listEl = null;
        this.countEl = null;
        this.importButtonEl = null;
        this.rowEls.clear();
        this.checkboxEls.clear();
        this.sortable?.destroy();
        this.sortable = null;

        const titleEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-title' });
        titleEl.setText(this.titleText());

        switch (this.phase) {
            case 'choice':
                this.renderChoice(contentEl);
                break;
            case 'unsupported':
                this.renderUnsupported(contentEl);
                break;
            case 'loading':
                this.renderLoading(contentEl);
                break;
            case 'error':
                this.renderError(contentEl);
                break;
            case 'select':
                this.renderSelect(contentEl);
                break;
        }
    }

    private addButton(
        parent: HTMLElement,
        text: string,
        variant: 'primary' | 'secondary',
        action: string,
        onClick?: () => void,
    ): HTMLButtonElement {
        const button = parent.createEl('button', {
            text,
            cls: `youtnote-plugin__modal-button youtnote-plugin__modal-button--${variant}`,
            attr: { type: 'button' },
        });
        button.dataset.youtnoteAction = action;
        button.addEventListener('click', () => {
            if (onClick) {
                onClick();
            }
        });
        return button;
    }

    private resolveVideoChoice(): void {
        if (this.options.isValid()) {
            this.settleAndClose('video');
        } else {
            this.settleAndClose(null);
        }
    }

    private renderChoice(contentEl: HTMLElement): void {
        const messageEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-message' });
        messageEl.setText('This link points to a video inside a playlist. Add only the video, or import videos from the playlist.');
        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons' });
        this.addButton(buttonsEl, 'Import playlist', 'primary', 'choose-playlist', () => {
            this.startFetch();
            this.render();
        });
        this.addButton(buttonsEl, 'Add video only', 'secondary', 'choose-video', () => this.resolveVideoChoice());
        this.addButton(buttonsEl, 'Cancel', 'secondary', 'cancel', () => this.close());
    }

    private renderUnsupported(contentEl: HTMLElement): void {
        const messageEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-message' });
        messageEl.setText(this.playlistKind === 'mix'
            ? 'YouTube Mix playlists are generated automatically and cannot be imported.'
            : 'This playlist is tied to a YouTube account and cannot be imported without signing in.');
        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons' });
        this.addButton(buttonsEl, 'Cancel', 'secondary', 'cancel', () => this.close());
        if (this.options.videoId) {
            this.addButton(buttonsEl, 'Add video only', 'primary', 'choose-video', () => this.resolveVideoChoice());
        }
    }

    private renderLoading(contentEl: HTMLElement): void {
        const progressWrap = contentEl.createDiv({ cls: 'youtnote-plugin__playlist-progress' });
        this.progressEl = progressWrap.createDiv({ cls: 'youtnote-plugin__playlist-progress-text' });
        this.updateProgressText();
        const indicatorEl = progressWrap.createDiv({
            cls: 'youtnote-plugin__playlist-progress-indicator',
            attr: { 'aria-hidden': 'true' },
        });
        indicatorEl.createDiv({ cls: 'youtnote-plugin__dot-pulse' });
        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons' });
        this.addButton(buttonsEl, 'Cancel', 'secondary', 'cancel', () => this.close());
    }

    private updateProgressText(): void {
        this.progressEl?.setText(`Loading playlist videos (${this.progressCount})`);
    }

    private renderError(contentEl: HTMLElement): void {
        const messageEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-message youtnote-plugin__playlist-error' });
        messageEl.dataset.youtnoteErrorCode = this.errorCode;
        messageEl.setText(this.errorMessage);
        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons' });
        this.addButton(buttonsEl, 'Cancel', 'secondary', 'cancel', () => this.close());
        if (this.options.videoId) {
            this.addButton(buttonsEl, 'Add video only', 'primary', 'choose-video', () => this.resolveVideoChoice());
        }
    }

    private renderSelect(contentEl: HTMLElement): void {
        const infoEl = contentEl.createDiv({ cls: 'youtnote-plugin__playlist-info' });
        infoEl.setText(this.playlistTitle || 'Playlist');

        const noteEl = contentEl.createDiv({ cls: 'youtnote-plugin__playlist-note' });
        noteEl.setText('YouTube may hide unavailable videos, so only the entries it returned are listed.');

        const toolbarEl = contentEl.createDiv({ cls: 'youtnote-plugin__playlist-toolbar' });
        this.addButton(toolbarEl, 'Check all', 'secondary', 'check-all', () => this.checkAll());
        this.addButton(toolbarEl, 'Check none', 'secondary', 'check-none', () => this.checkNone());
        this.countEl = toolbarEl.createDiv({ cls: 'youtnote-plugin__playlist-count' });
        this.updateCountText();

        const listEl = contentEl.createDiv({ cls: 'youtnote-plugin__playlist-list' });
        this.listEl = listEl;
        this.orderedKeys.forEach(key => {
            const entry = this.entriesByKey.get(key);
            if (entry) {
                this.renderRow(listEl, entry);
            }
        });
        this.sortable = Sortable.create(this.listEl, {
            handle: '.youtnote-plugin__playlist-entry-drag',
            animation: 150,
            forceFallback: true,
            fallbackOnBody: true,
            onEnd: (evt: SortableEvent) => {
                const oldIndex = evt.oldIndex;
                const newIndex = evt.newIndex;
                if (typeof oldIndex === 'number' && typeof newIndex === 'number' && oldIndex !== newIndex) {
                    this.reorderKeys(oldIndex, newIndex);
                    this.applyDomOrder();
                }
            },
        });

        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons' });
        this.addButton(buttonsEl, 'Cancel', 'secondary', 'cancel', () => this.close());
        this.importButtonEl = this.addButton(
            buttonsEl,
            'Add selected',
            'primary',
            'import',
            () => this.commitImport(),
        );
        this.updateImportButton();
    }

    private renderRow(listEl: HTMLElement, entry: PlaylistEntry): void {
        const reason = this.disabledReasons.get(entry.key) ?? null;
        const row = listEl.createDiv({ cls: 'youtnote-plugin__playlist-entry' });
        row.dataset.youtnoteEntryKey = entry.key;
        if (reason !== null) {
            row.dataset.youtnoteEntryStatus = reason;
        }

        const drag = row.createSpan({ cls: 'youtnote-plugin__playlist-entry-drag' });
        drag.dataset.youtnoteAction = 'drag-handle';
        setIcon(drag, 'grip-vertical');

        const label = row.createEl('label', { cls: 'youtnote-plugin__playlist-entry-label' });
        const checkbox = label.createEl('input', {
            attr: {
                type: 'checkbox',
                'aria-label': entry.title || 'Untitled video',
            },
        });
        checkbox.dataset.youtnoteAction = 'toggle';
        checkbox.checked = this.selected.has(entry.key);
        checkbox.disabled = reason !== null;
        checkbox.addEventListener('change', () => {
            this.setEntryChecked(entry.key, checkbox.checked);
        });
        this.checkboxEls.set(entry.key, checkbox);

        if (entry.thumbnail) {
            label.createEl('img', {
                cls: 'youtnote-plugin__playlist-entry-thumb',
                attr: { src: entry.thumbnail, alt: '' },
            });
        }

        const textEl = label.createDiv({ cls: 'youtnote-plugin__playlist-entry-text' });
        const titleEl = textEl.createDiv({ cls: 'youtnote-plugin__playlist-entry-title' });
        titleEl.setText(entry.title || 'Untitled video');
        if (reason !== null) {
            const statusEl = textEl.createDiv({ cls: 'youtnote-plugin__playlist-entry-status' });
            statusEl.setText(disabledReasonText(reason));
        }

        this.rowEls.set(entry.key, row);
    }

    private reorderKeys(from: number, to: number): void {
        if (from < 0 || from >= this.orderedKeys.length || to < 0 || to >= this.orderedKeys.length) {
            return;
        }
        const [moved] = this.orderedKeys.splice(from, 1);
        this.orderedKeys.splice(to, 0, moved);
    }

    private applyDomOrder(): void {
        const listEl = this.listEl;
        if (!listEl) {
            return;
        }
        for (const key of this.orderedKeys) {
            const row = this.rowEls.get(key);
            if (row) {
                listEl.appendChild(row);
            }
        }
    }

    private setEntryChecked(key: string, checked: boolean): void {
        if (this.disabledReasons.has(key)) {
            return;
        }
        if (checked) {
            this.selected.add(key);
        } else {
            this.selected.delete(key);
        }
        this.updateImportButton();
        this.updateCountText();
    }

    private checkAll(): void {
        for (const key of this.orderedKeys) {
            if (!this.disabledReasons.has(key)) {
                this.selected.add(key);
            }
        }
        this.syncCheckboxes();
    }

    private checkNone(): void {
        this.selected.clear();
        this.syncCheckboxes();
    }

    private syncCheckboxes(): void {
        for (const [key, checkbox] of this.checkboxEls) {
            if (!checkbox.disabled) {
                checkbox.checked = this.selected.has(key);
            }
        }
        this.updateImportButton();
        this.updateCountText();
    }

    private updateCountText(): void {
        this.countEl?.setText(`${this.selected.size} selected`);
    }

    private updateImportButton(): void {
        if (this.importButtonEl) {
            const count = this.selected.size;
            this.importButtonEl.disabled = count === 0;
            this.importButtonEl.setText(`Add selected (${count})`);
            this.importButtonEl.dataset.youtnoteCount = String(count);
        }
    }

    private commitImport(): void {
        if (!this.options.isValid() || this.selected.size === 0) {
            this.settleAndClose(null);
            return;
        }
        const existing = this.options.getExistingVideoIds();
        const result: PlaylistEntry[] = [];
        for (const key of this.orderedKeys) {
            if (!this.selected.has(key)) {
                continue;
            }
            const entry = this.entriesByKey.get(key);
            if (!entry) {
                continue;
            }
            if (entry.youtubeId && existing.has(entry.youtubeId)) {
                continue;
            }
            result.push(entry);
        }
        this.settleAndClose(result);
    }
}
