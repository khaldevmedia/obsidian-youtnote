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
    private pendingKeys: string[] = [];
    private readonly disabledReasons = new Map<string, EntryDisabledReason>();
    private errorCode = '';
    private errorMessage = '';
    private progressCount = 0;
    private progressEl: HTMLElement | null = null;
    private sourceListEl: HTMLElement | null = null;
    private pendingListEl: HTMLElement | null = null;
    private sourceCountEl: HTMLElement | null = null;
    private pendingCountEl: HTMLElement | null = null;
    private addAllButtonEl: HTMLButtonElement | null = null;
    private clearButtonEl: HTMLButtonElement | null = null;
    private importButtonEl: HTMLButtonElement | null = null;
    private readonly sourceActionEls = new Map<string, HTMLButtonElement>();
    private readonly pendingActionEls = new Map<string, HTMLButtonElement>();
    private readonly pendingRowEls = new Map<string, HTMLElement>();

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
        this.sourceListEl = null;
        this.pendingListEl = null;
        this.sourceCountEl = null;
        this.pendingCountEl = null;
        this.addAllButtonEl = null;
        this.clearButtonEl = null;
        this.importButtonEl = null;
        this.sourceActionEls.clear();
        this.pendingActionEls.clear();
        this.pendingRowEls.clear();
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
        this.pendingKeys = [];
        this.disabledReasons.clear();
        for (const entry of this.entries) {
            this.entriesByKey.set(entry.key, entry);
            if (!entry.available || entry.youtubeId === null) {
                this.disabledReasons.set(entry.key, 'unavailable');
            } else if (existing.has(entry.youtubeId)) {
                this.disabledReasons.set(entry.key, 'existing');
            } else if (seen.has(entry.youtubeId)) {
                this.disabledReasons.set(entry.key, 'repeated');
            } else {
                seen.add(entry.youtubeId);
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
        this.modalEl.dataset.youtnotePlaylistPhase = this.phase;
        contentEl.empty();
        this.progressEl = null;
        this.sourceListEl = null;
        this.pendingListEl = null;
        this.sourceCountEl = null;
        this.pendingCountEl = null;
        this.addAllButtonEl = null;
        this.clearButtonEl = null;
        this.importButtonEl = null;
        this.sourceActionEls.clear();
        this.pendingActionEls.clear();
        this.pendingRowEls.clear();
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
            ? 'YouTube Mix playlists are generated automatically by YouTube\'s recommendation system and cannot be imported.'
            : 'This playlist is tied to a YouTube account and cannot be imported without signing in.');
        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons' });
        this.addButton(buttonsEl, 'OK', 'secondary', 'cancel', () => this.close());
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

        if ([...this.disabledReasons.values()].includes('existing')) {
            const existingNoteEl = contentEl.createDiv({
                cls: 'youtnote-plugin__playlist-note youtnote-plugin__playlist-existing-note',
            });
            existingNoteEl.setText('Videos already in this file are grayed out and cannot be added again.');
        }

        const columnsEl = contentEl.createDiv({ cls: 'youtnote-plugin__playlist-columns' });
        const sourcePane = this.renderPane(columnsEl, 'Playlist videos', 'source');
        const pendingPane = this.renderPane(columnsEl, 'Videos to add', 'pending');
        this.sourceCountEl = sourcePane.countEl;
        this.pendingCountEl = pendingPane.countEl;
        this.addAllButtonEl = this.addButton(sourcePane.headerEl, 'Add all', 'secondary', 'add-all', () => this.addAll());
        this.clearButtonEl = this.addButton(pendingPane.headerEl, 'Clear', 'secondary', 'clear', () => this.clearPending());
        this.sourceListEl = sourcePane.listEl;
        this.pendingListEl = pendingPane.listEl;
        this.renderLists();

        this.sortable = Sortable.create(this.pendingListEl, {
            draggable: '.youtnote-plugin__playlist-entry',
            handle: '.youtnote-plugin__playlist-entry-drag',
            animation: 150,
            forceFallback: true,
            fallbackOnBody: true,
            onEnd: (evt: SortableEvent) => {
                if (this.closed) {
                    return;
                }
                const oldIndex = evt.oldIndex;
                const newIndex = evt.newIndex;
                if (typeof oldIndex === 'number' && typeof newIndex === 'number' && oldIndex !== newIndex) {
                    this.reorderPending(oldIndex, newIndex);
                    this.applyDomOrder();
                }
            },
        });

        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons' });
        this.addButton(buttonsEl, 'Cancel', 'secondary', 'cancel', () => this.close());
        this.importButtonEl = this.addButton(
            buttonsEl,
            'Add videos',
            'primary',
            'import',
            () => this.commitImport(),
        );
        this.updateImportButton();
    }

    private renderPane(
        parent: HTMLElement,
        heading: string,
        pane: 'source' | 'pending',
    ): { countEl: HTMLElement; headerEl: HTMLElement; listEl: HTMLElement } {
        const paneEl = parent.createDiv({ cls: 'youtnote-plugin__playlist-pane' });
        paneEl.dataset.youtnotePane = pane;
        const headerEl = paneEl.createDiv({ cls: 'youtnote-plugin__playlist-pane-header' });
        const headingId = `youtnote-playlist-${pane}-${crypto.randomUUID()}`;
        const titleEl = headerEl.createDiv({ cls: 'youtnote-plugin__playlist-pane-title', attr: { id: headingId } });
        titleEl.setText(heading);
        const countEl = headerEl.createDiv({ cls: 'youtnote-plugin__playlist-pane-count' });
        countEl.dataset.youtnotePane = pane;
        const listEl = paneEl.createDiv({
            cls: `youtnote-plugin__playlist-list youtnote-plugin__playlist-list--${pane}`,
            attr: { role: 'region', 'aria-labelledby': headingId },
        });
        return { countEl, headerEl, listEl };
    }

    private renderLists(origin?: 'source' | 'pending', movedKey?: string, removedIndex?: number): void {
        const sourceListEl = this.sourceListEl;
        const pendingListEl = this.pendingListEl;
        if (!sourceListEl || !pendingListEl) {
            return;
        }
        const sourceScroll = sourceListEl.scrollTop;
        const pendingScroll = pendingListEl.scrollTop;
        const pendingSet = new Set(this.pendingKeys);
        const sourceEntries = this.entries.filter(entry => !pendingSet.has(entry.key));
        this.sourceActionEls.clear();
        this.pendingActionEls.clear();
        this.pendingRowEls.clear();

        sourceListEl.empty();
        if (sourceEntries.length === 0) {
            const emptyEl = sourceListEl.createDiv({ cls: 'youtnote-plugin__playlist-empty' });
            emptyEl.setText('No more videos in this playlist.');
        } else {
            for (const entry of sourceEntries) {
                this.renderSourceRow(sourceListEl, entry);
            }
        }

        pendingListEl.empty();
        if (this.pendingKeys.length === 0) {
            const emptyEl = pendingListEl.createDiv({ cls: 'youtnote-plugin__playlist-empty' });
            emptyEl.setText('Use the add buttons to queue videos here.');
        } else {
            for (const key of this.pendingKeys) {
                const entry = this.entriesByKey.get(key);
                if (entry) {
                    this.renderPendingRow(pendingListEl, entry);
                }
            }
        }

        sourceListEl.scrollTop = sourceScroll;
        pendingListEl.scrollTop = pendingScroll;
        this.updateControls(sourceEntries.length, pendingSet);
        if (origin !== undefined) {
            this.refocusAfterTransfer(origin, movedKey, removedIndex);
        }
    }

    private renderSourceRow(listEl: HTMLElement, entry: PlaylistEntry): void {
        const reason = this.disabledReasons.get(entry.key) ?? null;
        const row = listEl.createDiv({ cls: 'youtnote-plugin__playlist-entry' });
        row.dataset.youtnoteEntryKey = entry.key;
        if (reason !== null) {
            row.dataset.youtnoteEntryStatus = reason;
        }
        this.renderEntryContent(row, entry, reason);
        const addButton = this.addButton(row, 'Add', 'secondary', 'add-entry', () => this.addEntry(entry.key));
        addButton.disabled = reason !== null;
        this.sourceActionEls.set(entry.key, addButton);
    }

    private renderPendingRow(listEl: HTMLElement, entry: PlaylistEntry): void {
        const row = listEl.createDiv({ cls: 'youtnote-plugin__playlist-entry' });
        row.dataset.youtnoteEntryKey = entry.key;
        const drag = row.createSpan({ cls: 'youtnote-plugin__playlist-entry-drag' });
        drag.dataset.youtnoteAction = 'drag-handle';
        setIcon(drag, 'grip-vertical');
        this.renderEntryContent(row, entry, null);
        const removeButton = this.addButton(row, 'Remove', 'secondary', 'remove-entry', () => this.removeEntry(entry.key));
        this.pendingActionEls.set(entry.key, removeButton);
        this.pendingRowEls.set(entry.key, row);
    }

    private renderEntryContent(row: HTMLElement, entry: PlaylistEntry, reason: EntryDisabledReason | null): void {
        const contentEl = row.createDiv({ cls: 'youtnote-plugin__playlist-entry-content' });
        if (entry.thumbnail) {
            contentEl.createEl('img', {
                cls: 'youtnote-plugin__playlist-entry-thumb',
                attr: { src: entry.thumbnail, alt: '' },
            });
        }
        const textEl = contentEl.createDiv({ cls: 'youtnote-plugin__playlist-entry-text' });
        const titleEl = textEl.createDiv({ cls: 'youtnote-plugin__playlist-entry-title' });
        titleEl.setText(entry.title || 'Untitled video');
        if (reason !== null) {
            const statusEl = textEl.createDiv({ cls: 'youtnote-plugin__playlist-entry-status' });
            statusEl.setText(disabledReasonText(reason));
        }
    }

    private addEntry(key: string): void {
        if (this.closed || !this.options.isValid()) {
            return;
        }
        if (!this.entriesByKey.has(key) || this.disabledReasons.has(key) || this.pendingKeys.includes(key)) {
            return;
        }
        this.pendingKeys.push(key);
        this.renderLists('source', key);
    }

    private removeEntry(key: string): void {
        if (this.closed || !this.options.isValid()) {
            return;
        }
        const index = this.pendingKeys.indexOf(key);
        if (index === -1) {
            return;
        }
        this.pendingKeys.splice(index, 1);
        this.renderLists('pending', key, index);
    }

    private addAll(): void {
        if (this.closed || !this.options.isValid()) {
            return;
        }
        const pendingSet = new Set(this.pendingKeys);
        for (const entry of this.entries) {
            if (!pendingSet.has(entry.key) && !this.disabledReasons.has(entry.key)) {
                this.pendingKeys.push(entry.key);
            }
        }
        this.renderLists('source');
    }

    private clearPending(): void {
        if (this.closed || !this.options.isValid() || this.pendingKeys.length === 0) {
            return;
        }
        this.pendingKeys = [];
        this.renderLists('pending');
    }

    private refocusAfterTransfer(origin: 'source' | 'pending', movedKey?: string, removedIndex?: number): void {
        let target: HTMLElement | null = null;
        if (origin === 'source') {
            if (movedKey !== undefined) {
                target = this.nextActionableSourceButton(movedKey, 1)
                    ?? this.nextActionableSourceButton(movedKey, -1)
                    ?? this.pendingActionEls.get(movedKey)
                    ?? null;
            }
            target = target ?? this.clearButtonEl;
        } else {
            if (movedKey !== undefined && removedIndex !== undefined) {
                const nextKey = this.pendingKeys[removedIndex] ?? this.pendingKeys[removedIndex - 1];
                if (nextKey !== undefined) {
                    target = this.pendingActionEls.get(nextKey) ?? null;
                }
                target = target ?? this.sourceActionEls.get(movedKey) ?? null;
            }
            target = target ?? this.addAllButtonEl;
        }
        target?.focus({ preventScroll: true });
    }

    private nextActionableSourceButton(afterKey: string, direction: 1 | -1): HTMLButtonElement | null {
        const startIndex = this.entries.findIndex(entry => entry.key === afterKey);
        if (startIndex === -1) {
            return null;
        }
        const pendingSet = new Set(this.pendingKeys);
        for (let i = startIndex + direction; i >= 0 && i < this.entries.length; i += direction) {
            const key = this.entries[i].key;
            if (!pendingSet.has(key) && !this.disabledReasons.has(key)) {
                return this.sourceActionEls.get(key) ?? null;
            }
        }
        return null;
    }

    private reorderPending(from: number, to: number): void {
        if (from < 0 || from >= this.pendingKeys.length || to < 0 || to >= this.pendingKeys.length) {
            return;
        }
        const [moved] = this.pendingKeys.splice(from, 1);
        this.pendingKeys.splice(to, 0, moved);
    }

    private applyDomOrder(): void {
        const pendingListEl = this.pendingListEl;
        if (!pendingListEl) {
            return;
        }
        for (const key of this.pendingKeys) {
            const row = this.pendingRowEls.get(key);
            if (row) {
                pendingListEl.appendChild(row);
            }
        }
    }

    private updateControls(sourceCount: number, pendingSet: Set<string>): void {
        if (this.sourceCountEl) {
            this.sourceCountEl.setText(`${sourceCount}`);
            this.sourceCountEl.dataset.youtnoteCount = String(sourceCount);
        }
        if (this.pendingCountEl) {
            this.pendingCountEl.setText(`${this.pendingKeys.length}`);
            this.pendingCountEl.dataset.youtnoteCount = String(this.pendingKeys.length);
        }
        let eligible = 0;
        for (const entry of this.entries) {
            if (!pendingSet.has(entry.key) && !this.disabledReasons.has(entry.key)) {
                eligible += 1;
            }
        }
        if (this.addAllButtonEl) {
            this.addAllButtonEl.disabled = eligible === 0;
        }
        if (this.clearButtonEl) {
            this.clearButtonEl.disabled = this.pendingKeys.length === 0;
        }
        this.updateImportButton();
    }

    private updateImportButton(): void {
        if (this.importButtonEl) {
            const count = this.pendingKeys.length;
            this.importButtonEl.disabled = count === 0;
            this.importButtonEl.setText(`Add videos (${count})`);
            this.importButtonEl.dataset.youtnoteCount = String(count);
        }
    }

    private commitImport(): void {
        if (!this.options.isValid() || this.pendingKeys.length === 0) {
            this.settleAndClose(null);
            return;
        }
        const existing = this.options.getExistingVideoIds();
        const result: PlaylistEntry[] = [];
        for (const key of this.pendingKeys) {
            const entry = this.entriesByKey.get(key);
            if (!entry) {
                continue;
            }
            if (this.disabledReasons.has(key)) {
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
