import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFile, WorkspaceLeaf } from 'obsidian';
import { Notice } from 'obsidian';
import { YoutnoteView } from './view';
import { promptLegacyConversionDecision } from './ui/MessageBoxes';
import type { LegacyConversionDecision } from './ui/MessageBoxes';
import type YoutnotePlugin from './main';
import type { NoteId, VideoId } from './types';

vi.mock('obsidian', () => {
    class FakeNotice {
        static calls: string[] = [];
        messageEl = { addClass: vi.fn() };
        constructor(message?: unknown) {
            FakeNotice.calls.push(String(message));
        }
    }
    interface FakeFileRef {
        path: string;
        basename: string;
    }
    interface FakeVault {
        cachedRead(file: FakeFileRef): Promise<string>;
        read(file: FakeFileRef): Promise<string>;
        process(file: FakeFileRef, fn: (data: string) => string): Promise<string>;
        modify(file: FakeFileRef, data: string): Promise<void>;
    }
    interface FakeLeaf {
        id: string;
        app: { vault: FakeVault };
        setViewState: ReturnType<typeof vi.fn>;
    }
    class FakeTextFileView {
        app: { vault: FakeVault };
        leaf: FakeLeaf;
        file: FakeFileRef | null = null;
        data: string | null = null;
        lastSavedData: string | null = null;
        dirty = false;
        saving = false;
        saveAgain = false;
        contentEl = { empty: vi.fn() };
        requestSave = () => {
            this.dirty = true;
            void this.save();
        };
        constructor(leaf: FakeLeaf) {
            this.leaf = leaf;
            this.app = leaf.app;
        }
        async onLoadFile(file: FakeFileRef): Promise<void> {
            this.file = file;
            this.data = await this.app.vault.read(file);
            this.lastSavedData = this.data;
            this.setViewData(this.data, true);
        }
        async onUnloadFile(_file: FakeFileRef): Promise<void> {
            await this.save(true);
        }
        async save(clear?: boolean): Promise<void> {
            this.dirty = false;
            const file = this.file;
            if (!file) return;
            if (this.saving) {
                if (!clear) this.saveAgain = true;
                return;
            }
            this.saveAgain = false;
            const source = this.getViewData();
            if (this.lastSavedData === source || this.lastSavedData === null) return;
            const previousBaseline = this.lastSavedData;
            if (clear === true) {
                this.data = null;
                this.lastSavedData = null;
                this.clear();
            } else {
                this.data = source;
                this.lastSavedData = source;
            }
            this.saving = true;
            try {
                await this.app.vault.modify(file, source);
            } catch (err) {
                this.lastSavedData = previousBaseline;
                throw err;
            } finally {
                this.saving = false;
                if (this.saveAgain && !clear) void this.save();
            }
        }
        getViewData(): string {
            return this.data ?? '';
        }
        setViewData(data: string, _clear: boolean): void {
            this.data = data;
        }
        clear(): void {}
        getState(): Record<string, unknown> {
            return {};
        }
        getViewType(): string {
            return 'youtnote-view';
        }
        getDisplayText(): string {
            return '';
        }
        getIcon(): string {
            return '';
        }
        canAcceptExtension(): boolean {
            return true;
        }
        addAction() {
            return null;
        }
    }
    return {
        TextFileView: FakeTextFileView,
        WorkspaceLeaf: class {},
        Notice: FakeNotice,
        TFile: class {},
        ViewState: class {},
        App: class {},
        Component: class {},
    };
});

vi.mock('./ui/YoutnoteView', () => ({
    YoutubePluginView: () => null,
}));

vi.mock('./ui/MessageBoxes', () => {
    class FakeAlertModal {
        static instances: { title: string; message: string }[] = [];
        constructor(_app: unknown, title: string, message: string) {
            FakeAlertModal.instances.push({ title, message });
        }
        open(): void {}
    }
    class FakeExportOptionsModal {
        constructor(..._args: unknown[]) {}
        open(): void {}
    }
    return {
        AlertModal: FakeAlertModal,
        ExportOptionsModal: FakeExportOptionsModal,
        promptLegacyConversionDecision: vi.fn((_app: unknown, _fileName: string, signal?: AbortSignal):
            Promise<'read-only' | 'convert'> => {
            if (signal?.aborted) return Promise.resolve('read-only');
            return new Promise<'read-only' | 'convert'>(resolve => {
                signal?.addEventListener('abort', () => resolve('read-only'), { once: true });
                resolve('read-only');
            });
        }),
    };
});

function unsafeCast<T>(value: unknown): T {
    return value as T;
}

const LEGACY = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

[0:05](timestamp)
A note.
`;

const LEGACY_B = `---
youtnote: true
---

[Other Video](https://www.youtube.com/watch?v=abcdefghijk)
`;

const V2 = `---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
<!-- youtnote:section:source:end -->

<!-- youtnote:section:notes:start -->

<!-- youtnote:timestamped-notes:start -->

\`0:05\` <!-- youtnote:timestamp -->
A note.

<!-- youtnote:timestamped-notes:end -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;

const DECLARED_V1 = `---
youtnote: true
youtnote-format-version: 1
---

[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
`;

const V2_B = `---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[Other Video](https://www.youtube.com/watch?v=abcdefghijk)
<!-- youtnote:section:source:end -->

<!-- youtnote:video:end -->
`;

const V3 = `---
youtnote: true
youtnote-format-version: 3
---
`;

const V2_WITH_SECTIONS = `---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:section:topic-description:start -->
file-level payload
<!-- youtnote:section:topic-description:end -->

<!-- youtnote:video:start -->

<!-- youtnote:section:source:start -->
[Test Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
<!-- youtnote:section:source:end -->

<!-- youtnote:section:notes:start -->

<!-- youtnote:section:notes:end -->

<!-- youtnote:video:end -->
`;

const INVALID_LEGACY = `---
youtnote: true
---

plain text that the legacy format cannot hold
`;

function makeFixture() {
    const store = new Map<string, string>();
    const vault = {
        cachedRead: vi.fn(async (f: { path: string }) => store.get(f.path) ?? ''),
        read: vi.fn(async (f: { path: string }) => store.get(f.path) ?? ''),
        process: vi.fn(async (f: { path: string }, fn: (data: string) => string) => {
            const next = fn(store.get(f.path) ?? '');
            store.set(f.path, next);
            return next;
        }),
        modify: vi.fn(async (f: { path: string }, data: string) => {
            store.set(f.path, data);
        }),
    };
    const app = {
        vault,
        workspace: {},
        secretStorage: { getSecret: vi.fn(() => null) },
    };
    const leaf = unsafeCast<WorkspaceLeaf>({
        id: 'leaf-1',
        app,
        setViewState: vi.fn(async () => {}),
    });
    const plugin = unsafeCast<YoutnotePlugin>({
        app,
        settings: {},
        youtnoteFileModes: {},
        isYoutnoteFile: vi.fn(async () => true),
        getVideoTaskState: vi.fn(() => ({ transcriptPhase: null, aiPhase: null })),
        openSettings: vi.fn(),
        startTranscriptFetch: vi.fn(),
        startAINoteGeneration: vi.fn(),
        cancelVideoTasks: vi.fn(),
        setMarkdownView: vi.fn(),
    });
    const view = new YoutnoteView(leaf, plugin);
    const file = (path: string) => unsafeCast<TFile>({
        path,
        basename: path.replace(/\.md$/, ''),
    });
    return { store, vault, app, leaf, plugin, view, file };
}

const flush = async () => {
    for (let i = 0; i < 40; i++) {
        await Promise.resolve();
    }
};

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const addedNote = (videoId: VideoId, body: string) => ({
    id: `note-${body}` as NoteId,
    videoId,
    timestampSec: 42,
    bodyMarkdown: body,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
});

function noticeCalls(): string[] {
    return unsafeCast<{ calls: string[] }>(Notice).calls;
}

describe('YoutnoteView write modes and legacy conversion', () => {
    beforeAll(() => {
        vi.stubGlobal('window', {
            setTimeout: (callback: () => void) => {
                void Promise.resolve().then(callback);
            },
        });
    });

    beforeEach(() => {
        vi.clearAllMocks();
        noticeCalls().length = 0;
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('read-only');
    });

    it('opens a v2 file editable without prompting', async () => {
        const { store, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(view.isWritable()).toBe(true);
        expect(vi.mocked(promptLegacyConversionDecision)).not.toHaveBeenCalled();
        expect(view.videos).toHaveLength(1);
        expect(view.getViewData()).toContain('youtnote-format-version: 2');
    });

    it('prompts for a legacy file and opens a read-only preview without writing', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(promptLegacyConversionDecision).mock.calls[0][1]).toBe('legacy');
        expect(view.getWriteMode()).toBe('legacy-preview');
        expect(view.isWritable()).toBe(false);
        expect(view.videos).toHaveLength(1);
        expect(view.notes).toHaveLength(1);
        expect(vault.process).not.toHaveBeenCalled();
        expect(vault.modify).not.toHaveBeenCalled();
    });

    it('performs no vault writes from save, requestSave, or mutation handlers while read-only', async () => {
        const { store, vault, view, file, plugin } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        view.requestSave();
        await view.save();
        await view.onUnloadFile(f);
        view.handleUpdateVideos([]);
        view.handleUpdateNotes([]);
        view.handleFetchTranscript(unsafeCast<VideoId>('video-1'));
        await flush();
        expect(vault.modify).not.toHaveBeenCalled();
        expect(vault.process).not.toHaveBeenCalled();
        expect(view.videos).toHaveLength(1);
        expect(view.notes).toHaveLength(1);
        expect(unsafeCast<Record<string, unknown>>(plugin).startTranscriptFetch).not.toHaveBeenCalled();
        expect(view.getViewData()).toBe(LEGACY);
        expect(store.get(f.path)).toBe(LEGACY);
        expect(view.getWriteMode()).toBe('blocked');
    });

    it('converts on the latest file contents via vault.process and becomes editable', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        let decide: ((d: LegacyConversionDecision) => void) | null = null;
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(
            new Promise<LegacyConversionDecision>(resolve => { decide = resolve; }),
        );
        const loading = view.onLoadFile(f);
        await flush();
        store.set(f.path, LEGACY_B);
        decide!('convert');
        await loading;
        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        expect(store.get(f.path)).toContain('abcdefghijk');
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(noticeCalls().some(m => m.includes('Updated this file'))).toBe(true);
    });

    it('loads an externally converted file without rewriting it', async () => {
        const { store, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        let decide: ((d: LegacyConversionDecision) => void) | null = null;
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(
            new Promise<LegacyConversionDecision>(resolve => { decide = resolve; }),
        );
        const loading = view.onLoadFile(f);
        await flush();
        store.set(f.path, V2);
        decide!('convert');
        await loading;
        expect(store.get(f.path)).toBe(V2);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(noticeCalls().some(m => m.includes('Updated this file'))).toBe(false);
    });

    it('prompts even for an empty legacy file', async () => {
        const { store, view, file } = makeFixture();
        const f = file('empty.md');
        store.set(f.path, '---\nyoutnote: true\n---\n');
        await view.onLoadFile(f);
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(view.getWriteMode()).toBe('legacy-preview');
        expect(view.videos).toHaveLength(0);
    });

    it('fails closed to markdown without prompting when the legacy structure is invalid', async () => {
        const { store, view, file, leaf } = makeFixture();
        const f = file('broken.md');
        store.set(f.path, INVALID_LEGACY);
        await view.onLoadFile(f);
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).not.toHaveBeenCalled();
        expect(view.getWriteMode()).toBe('blocked');
        expect(unsafeCast<{ setViewState: ReturnType<typeof vi.fn> }>(leaf).setViewState)
            .toHaveBeenCalledWith(expect.objectContaining({ type: 'markdown' }));
    });

    it('fails closed for an unsupported format version', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('future.md');
        store.set(f.path, V3);
        await view.onLoadFile(f);
        await view.save();
        expect(view.getWriteMode()).toBe('blocked');
        expect(view.isWritable()).toBe(false);
        expect(view.getViewData()).toBe(V3);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(vi.mocked(promptLegacyConversionDecision)).not.toHaveBeenCalled();
    });

    it('reparses an external legacy refresh into the preview without prompting again', async () => {
        const { store, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        store.set(f.path, LEGACY_B);
        await view.onLoadFile(f);
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(view.getWriteMode()).toBe('legacy-preview');
        expect(view.videos[0].url).toContain('abcdefghijk');
        expect(view.getViewData()).toBe(LEGACY_B);
    });

    it('loads an external v2 refresh normally while previewing', async () => {
        const { store, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        store.set(f.path, V2);
        await view.onLoadFile(f);
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(view.getWriteMode()).toBe('editable-v2');
    });

    it('ignores a stale modal decision after the view unloads', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        let decide: ((d: LegacyConversionDecision) => void) | null = null;
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(
            new Promise<LegacyConversionDecision>(resolve => { decide = resolve; }),
        );
        const loading = view.onLoadFile(f);
        await flush();
        await view.onUnloadFile(f);
        decide!('convert');
        await loading;
        expect(vault.process).not.toHaveBeenCalled();
        expect(vault.modify).not.toHaveBeenCalled();
        expect(view.getWriteMode()).toBe('blocked');
    });

    it('converts through the read-only banner request', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('legacy-preview');
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('convert');
        view.handleRequestConversion();
        await flush();
        await flush();
        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(view.getWriteMode()).toBe('editable-v2');
    });

    it('prompts again when a still-legacy file is reloaded after unload', async () => {
        const { store, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('legacy-preview');
        await view.onUnloadFile(f);
        await view.onLoadFile(f);
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(2);
        expect(view.getWriteMode()).toBe('legacy-preview');
    });

    it('does not leak write mode to a different file', async () => {
        const { store, view, file } = makeFixture();
        const f1 = file('a.md');
        store.set(f1.path, V2);
        await view.onLoadFile(f1);
        expect(view.getWriteMode()).toBe('editable-v2');
        const f2 = file('b.md');
        store.set(f2.path, LEGACY);
        await view.onLoadFile(f2);
        expect(view.getWriteMode()).toBe('legacy-preview');
    });

    it('prompts for a declared-v1 file', async () => {
        const { store, view, file } = makeFixture();
        const f = file('v1.md');
        store.set(f.path, DECLARED_V1);
        await view.onLoadFile(f);
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(view.getWriteMode()).toBe('legacy-preview');
    });

    it('prompts for a legacy file with only videos and no notes', async () => {
        const { store, view, file } = makeFixture();
        const f = file('videos-only.md');
        store.set(f.path, LEGACY_B);
        await view.onLoadFile(f);
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(view.getWriteMode()).toBe('legacy-preview');
        expect(view.videos).toHaveLength(1);
        expect(view.notes).toHaveLength(0);
    });

    it('prompts for a different legacy file even when the host already assigned the file', async () => {
        const { store, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, LEGACY);
        store.set(fB.path, LEGACY_B);
        await view.onLoadFile(fA);
        expect(view.getWriteMode()).toBe('legacy-preview');
        unsafeCast<{ file: unknown }>(view).file = fB;
        await view.onLoadFile(fB);
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(promptLegacyConversionDecision).mock.calls[1][1]).toBe('b');
        expect(view.getWriteMode()).toBe('legacy-preview');
        expect(view.videos[0].url).toContain('abcdefghijk');
    });

    it('aborts a pending modal on a new load and converts only the current file', async () => {
        const { store, vault, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, LEGACY);
        store.set(fB.path, LEGACY_B);
        const resolvers: ((d: LegacyConversionDecision) => void)[] = [];
        vi.mocked(promptLegacyConversionDecision).mockImplementation((_app, _name, signal) =>
            new Promise<LegacyConversionDecision>(resolve => {
                resolvers.push(resolve);
                signal?.addEventListener('abort', () => resolve('read-only'), { once: true });
            }));
        const loadA = view.onLoadFile(fA);
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        const loadB = view.onLoadFile(fB);
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(promptLegacyConversionDecision).mock.calls[1][1]).toBe('b');
        await loadA;
        resolvers[1]('convert');
        await loadB;
        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(store.get(fB.path)).toContain('youtnote-format-version: 2');
        expect(store.get(fA.path)).toBe(LEGACY);
        expect(view.getWriteMode()).toBe('editable-v2');
    });

    it('does not run the conversion callback for an obsolete request', async () => {
        const { store, vault, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, LEGACY);
        store.set(fB.path, V2);
        let decide: ((d: LegacyConversionDecision) => void) | null = null;
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(
            new Promise<LegacyConversionDecision>(resolve => { decide = resolve; }),
        );
        const loading = view.onLoadFile(fA);
        await flush();
        let processCallback: ((data: string) => string) | null = null;
        let finishProcess: ((value: string) => void) | null = null;
        unsafeCast<Record<string, unknown>>(vault).process = vi.fn(
            (_f: { path: string }, fn: (data: string) => string) =>
                new Promise<string>(resolve => {
                    processCallback = fn;
                    finishProcess = resolve;
                }),
        );
        decide!('convert');
        await flush();
        expect(processCallback).not.toBeNull();
        await view.onLoadFile(fB);
        const migrated = processCallback!(store.get(fA.path) ?? '');
        finishProcess!(migrated);
        await loading;
        expect(migrated).toBe(LEGACY);
        expect(store.get(fA.path)).toBe(LEGACY);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(noticeCalls().some(m => m.includes('Updated this file'))).toBe(false);
    });

    it('re-reads current contents after the modal and opens v2 instead of previewing', async () => {
        const { store, view, file } = makeFixture();
        const f = file('swap.md');
        store.set(f.path, LEGACY);
        let decide: ((d: LegacyConversionDecision) => void) | null = null;
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(
            new Promise<LegacyConversionDecision>(resolve => { decide = resolve; }),
        );
        const loading = view.onLoadFile(f);
        await flush();
        store.set(f.path, V2);
        decide!('read-only');
        await loading;
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(view.videos).toHaveLength(1);
    });

    it('re-reads current contents after the modal and fails closed on an unsupported version', async () => {
        const { store, view, file, leaf } = makeFixture();
        const f = file('swap.md');
        store.set(f.path, LEGACY);
        let decide: ((d: LegacyConversionDecision) => void) | null = null;
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(
            new Promise<LegacyConversionDecision>(resolve => { decide = resolve; }),
        );
        const loading = view.onLoadFile(f);
        await flush();
        store.set(f.path, V3);
        decide!('read-only');
        await loading;
        await flush();
        expect(view.getWriteMode()).toBe('blocked');
        expect(view.getViewData()).toBe(V3);
        expect(unsafeCast<{ setViewState: ReturnType<typeof vi.fn> }>(leaf).setViewState)
            .toHaveBeenCalledWith(expect.objectContaining({ type: 'markdown' }));
    });

    it('handles a deferred markdown switch only while the load is current', async () => {
        const { store, view, file, leaf, plugin } = makeFixture();
        const scheduled: Array<() => void> = [];
        vi.stubGlobal('window', {
            setTimeout: (callback: () => void) => {
                scheduled.push(callback);
                return 0;
            },
        });
        const fA = file('plain.md');
        const fB = file('b.md');
        store.set(fA.path, '# just markdown');
        store.set(fB.path, V2);
        unsafeCast<Record<string, unknown>>(plugin).isYoutnoteFile = vi.fn(
            async (f: TFile) => f.path !== fA.path,
        );
        const loading = view.onLoadFile(fA);
        await flush();
        expect(scheduled).toHaveLength(1);
        await view.onLoadFile(fB);
        await loading;
        await flush();
        scheduled.forEach(callback => callback());
        expect(unsafeCast<{ setViewState: ReturnType<typeof vi.fn> }>(leaf).setViewState)
            .not.toHaveBeenCalled();
        expect(view.getWriteMode()).toBe('editable-v2');
        vi.stubGlobal('window', {
            setTimeout: (callback: () => void) => {
                void Promise.resolve().then(callback);
            },
        });
    });

    it('preserves file-level sections through a delete-last-video save', async () => {
        const { store, view, file } = makeFixture();
        const f = file('sections.md');
        store.set(f.path, V2_WITH_SECTIONS);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(view.getViewData()).toContain('file-level payload');
        view.handleUpdateVideos([]);
        await view.save();
        const saved = store.get(f.path)!;
        expect(saved).toContain('section:topic-description:start');
        expect(saved).toContain('file-level payload');
        expect(saved).not.toContain('dQw4w9WgXcQ');
        expect(view.getWriteMode()).toBe('editable-v2');
    });

    it('keeps the vault untouched when setViewData receives an unsupported version', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        view.setViewData(V3);
        await view.save();
        expect(view.getWriteMode()).toBe('blocked');
        expect(view.getViewData()).toBe(V3);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(store.get(f.path)).toBe(V2);
    });

    it('keeps the vault untouched when setViewData receives an invalid document', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        view.setViewData(INVALID_LEGACY);
        await view.save();
        expect(view.getWriteMode()).toBe('blocked');
        expect(view.getViewData()).toBe(INVALID_LEGACY);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(store.get(f.path)).toBe(V2);
    });

    it('does not install a stale load result after a newer file wins the race', async () => {
        const { store, vault, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, V2);
        store.set(fB.path, V2_B);
        let resolveA: ((value: string) => void) | null = null;
        vi.mocked(vault.cachedRead).mockImplementation((f: { path: string }) => {
            if (f.path === fA.path) {
                return new Promise<string>(resolve => { resolveA = resolve; });
            }
            return Promise.resolve(store.get(f.path) ?? '');
        });
        const loadingA = view.onLoadFile(fA);
        await flush();
        await view.onLoadFile(fB);
        expect(view.file).toBe(fB);
        resolveA!(V2);
        await loadingA;
        await flush();
        expect(view.file).toBe(fB);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(view.getViewData()).toContain('abcdefghijk');
    });

    it('does not install converted data when the post-conversion read finishes after unload', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        let reads = 0;
        let resolvePostRead: ((value: string) => void) | null = null;
        vi.mocked(vault.cachedRead).mockImplementation((f: { path: string }) => {
            reads++;
            if (reads === 2) {
                return new Promise<string>(resolve => { resolvePostRead = resolve; });
            }
            return Promise.resolve(store.get(f.path) ?? '');
        });
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('convert');
        const loading = view.onLoadFile(f);
        await flush();
        await view.onUnloadFile(f);
        resolvePostRead!(store.get(f.path) ?? '');
        await loading;
        await flush();
        expect(view.getWriteMode()).toBe('blocked');
        expect(noticeCalls().some(m => m.includes('Updated this file'))).toBe(false);
    });

    it('persists modified notes when an editable v2 view unloads', async () => {
        const { store, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        unsafeCast<Record<string, unknown>>(view).requestSave = () => {};
        const videoId = view.videos[0].id;
        view.handleUpdateNotes([
            ...view.notes,
            {
                id: 'note-added' as NoteId,
                videoId,
                timestampSec: 42,
                bodyMarkdown: 'Edited body',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            },
        ]);
        expect(store.get(f.path)).toBe(V2);
        await view.onUnloadFile(f);
        expect(store.get(f.path)).toContain('Edited body');
    });

    it('writes nothing when a legacy preview unloads', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('legacy-preview');
        await view.onUnloadFile(f);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(store.get(f.path)).toBe(LEGACY);
        expect(view.getWriteMode()).toBe('blocked');
    });

    it('refuses edits and saves when the host file no longer matches the loaded file', async () => {
        const { store, vault, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, V2);
        store.set(fB.path, V2_B);
        await view.onLoadFile(fA);
        expect(view.isWritable()).toBe(true);
        unsafeCast<Record<string, unknown>>(view).file = fB;
        expect(view.isWritable()).toBe(false);
        view.handleUpdateNotes([]);
        view.handleUpdateVideos([]);
        await view.save();
        expect(view.notes).toHaveLength(1);
        expect(view.videos).toHaveLength(1);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(store.get(fA.path)).toBe(V2);
        expect(store.get(fB.path)).toBe(V2_B);
    });

    it('reports a failed conversion without writing when vault.process rejects', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('convert');
        vi.mocked(vault.process).mockRejectedValueOnce(new Error('deleted'));
        await view.onLoadFile(f);
        await flush();
        expect(store.get(f.path)).toBe(LEGACY);
        expect(view.getWriteMode()).not.toBe('editable-v2');
        expect(noticeCalls().some(m => m.includes('Conversion failed'))).toBe(true);
    });

    it('does not rewrite a file that became an unsupported version before conversion ran', async () => {
        const { store, view, file, leaf } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        let decide: ((d: LegacyConversionDecision) => void) | null = null;
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(
            new Promise<LegacyConversionDecision>(resolve => { decide = resolve; }),
        );
        const loading = view.onLoadFile(f);
        await flush();
        store.set(f.path, V3);
        decide!('convert');
        await loading;
        await flush();
        expect(store.get(f.path)).toBe(V3);
        expect(view.getWriteMode()).not.toBe('editable-v2');
        expect(noticeCalls().some(m => m.includes('Updated this file'))).toBe(false);
        expect(unsafeCast<{ setViewState: ReturnType<typeof vi.fn> }>(leaf).setViewState)
            .toHaveBeenCalledWith(expect.objectContaining({ type: 'markdown' }));
    });

    it('round-trips file-level sections through a load, note edit, and save', async () => {
        const { store, view, file } = makeFixture();
        const f = file('sections.md');
        store.set(f.path, V2_WITH_SECTIONS);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('editable-v2');
        const videoId = view.videos[0].id;
        view.handleUpdateNotes([
            ...view.notes,
            {
                id: 'note-added' as NoteId,
                videoId,
                timestampSec: 7,
                bodyMarkdown: 'New note body',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            },
        ]);
        await view.save();
        const saved = store.get(f.path)!;
        expect(saved).toContain('section:topic-description:start');
        expect(saved).toContain('file-level payload');
        expect(saved).toContain('New note body');
        expect(saved.indexOf('section:topic-description:start')).toBeLessThan(saved.indexOf('youtnote:video:start'));
    });

    it('invalidates pending mutations as soon as closing starts', async () => {
        const { store, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        const guard = view.getMutationGuard();
        let finishSave!: () => void;
        vi.spyOn(view, 'save').mockReturnValue(new Promise<void>(resolve => { finishSave = resolve; }));
        const closing = view.onClose();
        expect(guard()).toBe(false);
        finishSave();
        await closing;
        expect(view.isWritable()).toBe(false);
    });

    it('does not clear a newer load when an older unload finishes', async () => {
        const { store, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, V2);
        store.set(fB.path, V2_B);
        await view.onLoadFile(fA);
        let finishSave!: () => void;
        vi.spyOn(view, 'save').mockReturnValue(new Promise<void>(resolve => { finishSave = resolve; }));
        const unloading = view.onUnloadFile(fA);
        await view.onLoadFile(fB);
        finishSave();
        await unloading;
        expect(view.file).toBe(fB);
        expect(view.isWritable()).toBe(true);
        expect(view.getViewData()).toContain('abcdefghijk');
    });

    it('does not claim the file is unchanged when reading an already-converted file fails', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('convert');
        vi.mocked(vault.cachedRead)
            .mockResolvedValueOnce(LEGACY)
            .mockRejectedValueOnce(new Error('read failed'));
        await view.onLoadFile(f);
        expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        expect(noticeCalls().some(message => message.includes('unchanged'))).toBe(false);
        expect(view.isWritable()).toBe(false);
    });

    it('initializes the save baseline to the loaded v2 source', async () => {
        const { store, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        expect(view.isWritable()).toBe(true);
        expect(unsafeCast<{ lastSavedData: string | null }>(view).lastSavedData).toBe(V2);
    });

    it('persists a note through requestSave auto-save', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        const videoId = view.videos[0].id;
        view.handleUpdateNotes([
            ...view.notes,
            {
                id: 'note-added' as NoteId,
                videoId,
                timestampSec: 42,
                bodyMarkdown: 'Auto-saved body',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            },
        ]);
        await flush();
        expect(vault.modify).toHaveBeenCalledTimes(1);
        expect(store.get(f.path)).toContain('Auto-saved body');
    });

    it('persists a video change through requestSave auto-save', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        view.handleUpdateVideos(view.videos.map(v => ({ ...v, title: 'New title' })));
        await flush();
        expect(vault.modify).toHaveBeenCalledTimes(1);
        const saved = store.get(f.path)!;
        expect(saved).toContain('New title');
        expect(saved).toContain('A note.');
    });

    it('keeps edits to A and B across load switches when auto-save is deferred to unload', async () => {
        const { store, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, V2);
        store.set(fB.path, V2_B);
        unsafeCast<Record<string, unknown>>(view).requestSave = () => {};
        const editNotes = (body: string) => view.handleUpdateNotes([
            ...view.notes,
            {
                id: `note-${body}` as NoteId,
                videoId: view.videos[0].id,
                timestampSec: 30,
                bodyMarkdown: body,
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            },
        ]);

        await view.onLoadFile(fA);
        editNotes('Edit A');
        expect(store.get(fA.path)).toBe(V2);
        await view.onUnloadFile(fA);
        expect(store.get(fA.path)).toContain('Edit A');

        await view.onLoadFile(fB);
        editNotes('Edit B');
        await view.onUnloadFile(fB);
        expect(store.get(fB.path)).toContain('Edit B');

        await view.onLoadFile(fA);
        expect(view.getViewData()).toContain('Edit A');
        await view.onUnloadFile(fA);
        await view.onLoadFile(fB);
        expect(view.getViewData()).toContain('Edit B');
    });

    it('persists edits after converting a legacy file on open', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('convert');
        await view.onLoadFile(f);
        await flush();
        expect(view.isWritable()).toBe(true);
        const migrated = store.get(f.path)!;
        expect(unsafeCast<{ lastSavedData: string | null }>(view).lastSavedData).toBe(migrated);
        vi.mocked(vault.modify).mockClear();
        const videoId = view.videos[0].id;
        view.handleUpdateNotes([
            ...view.notes,
            {
                id: 'note-added' as NoteId,
                videoId,
                timestampSec: 42,
                bodyMarkdown: 'Post-conversion body',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            },
        ]);
        await flush();
        expect(vault.modify).toHaveBeenCalledTimes(1);
        expect(store.get(f.path)).toContain('Post-conversion body');
    });

    it('persists edits after converting from the read-only banner', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('legacy-preview');
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('convert');
        view.handleRequestConversion();
        await flush();
        expect(view.isWritable()).toBe(true);
        const migrated = store.get(f.path)!;
        expect(unsafeCast<{ lastSavedData: string | null }>(view).lastSavedData).toBe(migrated);
        vi.mocked(vault.modify).mockClear();
        const videoId = view.videos[0].id;
        view.handleUpdateNotes([
            ...view.notes,
            {
                id: 'note-added' as NoteId,
                videoId,
                timestampSec: 42,
                bodyMarkdown: 'Post-banner-conversion body',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            },
        ]);
        await flush();
        expect(vault.modify).toHaveBeenCalledTimes(1);
        expect(store.get(f.path)).toContain('Post-banner-conversion body');
    });

    it('skips a redundant save when the data matches the baseline', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        const canonical = view.getViewData();
        store.set(f.path, canonical);
        await view.onLoadFile(f);
        vi.mocked(vault.modify).mockClear();
        await view.save();
        expect(vault.modify).not.toHaveBeenCalled();
        expect(store.get(f.path)).toBe(canonical);
    });

    it('loads editable v2 through the public superclass read and persists edits', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        expect(vault.read).toHaveBeenCalledTimes(1);
        expect(vault.read).toHaveBeenCalledWith(f);
        expect(view.isWritable()).toBe(true);
        view.handleUpdateNotes([...view.notes, addedNote(view.videos[0].id, 'Loader body')]);
        await flush();
        expect(vault.modify).toHaveBeenCalledTimes(1);
        expect(store.get(f.path)).toContain('Loader body');
    });

    it('never invokes the superclass read for a read-only legacy preview', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        await flush();
        expect(view.getWriteMode()).toBe('legacy-preview');
        expect(vault.read).not.toHaveBeenCalled();
        expect(vault.modify).not.toHaveBeenCalled();
        expect(store.get(f.path)).toBe(LEGACY);
    });

    it('serializes superclass reads so only the newest file installs', async () => {
        const { store, vault, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, V2);
        store.set(fB.path, V2_B);
        const readsStarted: string[] = [];
        const gateA = deferred<string>();
        vi.mocked(vault.read).mockImplementation((f: { path: string }) => {
            readsStarted.push(f.path);
            if (f.path === fA.path) return gateA.promise;
            return Promise.resolve(store.get(f.path) ?? '');
        });
        const loadA = view.onLoadFile(fA);
        await flush();
        const loadB = view.onLoadFile(fB);
        await flush();
        expect(readsStarted).toEqual([fA.path]);
        expect(view.isWritable()).toBe(false);
        gateA.resolve(store.get(fA.path)!);
        await Promise.all([loadA, loadB]);
        await flush();
        expect(readsStarted).toEqual([fA.path, fB.path]);
        expect(view.isWritable()).toBe(true);
        expect(unsafeCast<{ lastSavedData: string | null }>(view).lastSavedData).toBe(V2_B);
        expect(view.videos[0].title).toBe('Other Video');
        view.handleUpdateNotes([...view.notes, addedNote(view.videos[0].id, 'B edit')]);
        await flush();
        expect(store.get(fB.path)).toContain('B edit');
        expect(store.get(fA.path)).toBe(V2);
    });

    it('skips a queued superclass load superseded by a newer file', async () => {
        const { store, vault, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        const fC = file('c.md');
        const V2_C = V2.replace('Test Video', 'Third Video');
        store.set(fA.path, V2);
        store.set(fB.path, V2_B);
        store.set(fC.path, V2_C);
        const readsStarted: string[] = [];
        const gateA = deferred<string>();
        vi.mocked(vault.read).mockImplementation((f: { path: string }) => {
            readsStarted.push(f.path);
            if (f.path === fA.path) return gateA.promise;
            return Promise.resolve(store.get(f.path) ?? '');
        });
        const loadA = view.onLoadFile(fA);
        await flush();
        const loadB = view.onLoadFile(fB);
        await flush();
        const loadC = view.onLoadFile(fC);
        await flush();
        expect(readsStarted).toEqual([fA.path]);
        gateA.resolve(store.get(fA.path)!);
        await Promise.all([loadA, loadB, loadC]);
        await flush();
        expect(readsStarted).toEqual([fA.path, fC.path]);
        expect(view.isWritable()).toBe(true);
        expect(view.videos[0].title).toBe('Third Video');
        expect(unsafeCast<{ lastSavedData: string | null }>(view).lastSavedData).toBe(V2_C);
    });

    it.each(['clear', 'unload', 'close'] as const)(
        'does not install stale content when %s happens during a pending superclass read',
        async (action) => {
            const { store, vault, view, file } = makeFixture();
            const fA = file('a.md');
            store.set(fA.path, V2);
            const gateA = deferred<string>();
            vi.mocked(vault.read).mockReturnValue(gateA.promise);
            const loading = view.onLoadFile(fA);
            await flush();
            expect(vault.read).toHaveBeenCalledTimes(1);
            expect(vault.read).toHaveBeenCalledWith(fA);
            expect(view.isWritable()).toBe(false);
            if (action === 'clear') {
                view.clear();
            } else if (action === 'unload') {
                await view.onUnloadFile(fA);
            } else {
                await view.onClose();
            }
            gateA.resolve(store.get(fA.path)!);
            await loading;
            await flush();
            expect(view.getWriteMode()).toBe('blocked');
            expect(view.isWritable()).toBe(false);
            expect(view.videos).toHaveLength(0);
            expect(view.notes).toHaveLength(0);
            expect(vault.modify).not.toHaveBeenCalled();
        },
    );

    it('fails closed when the fresh superclass read returns an unsupported version', async () => {
        const { store, vault, view, file, leaf } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        vi.mocked(vault.read).mockResolvedValue(V3);
        await view.onLoadFile(f);
        await flush();
        expect(view.getWriteMode()).toBe('blocked');
        expect(view.isWritable()).toBe(false);
        expect(view.getViewData()).toBe(V3);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(store.get(f.path)).toBe(V2);
        expect(unsafeCast<{ setViewState: ReturnType<typeof vi.fn> }>(leaf).setViewState)
            .toHaveBeenCalledWith(expect.objectContaining({ type: 'markdown' }));
    });

    it('recovers the superclass load queue after a rejected parent read', async () => {
        const { store, vault, view, file } = makeFixture();
        const fA = file('a.md');
        const fB = file('b.md');
        store.set(fA.path, V2);
        store.set(fB.path, V2_B);
        const gateA = deferred<string>();
        const readsStarted: string[] = [];
        vi.mocked(vault.read).mockImplementation((f: { path: string }) => {
            readsStarted.push(f.path);
            if (f.path === fA.path) return gateA.promise;
            return Promise.resolve(store.get(f.path) ?? '');
        });
        const loadA = view.onLoadFile(fA).then(() => 'resolved', () => 'rejected');
        await flush();
        const loadB = view.onLoadFile(fB);
        await flush();
        expect(readsStarted).toEqual([fA.path]);
        expect(view.isWritable()).toBe(false);
        gateA.reject(new Error('read failed'));
        await Promise.all([loadA, loadB]);
        await flush();
        expect(await loadA).toBe('rejected');
        expect(vault.read).toHaveBeenCalledTimes(2);
        expect(view.isWritable()).toBe(true);
        expect(view.videos[0].title).toBe('Other Video');
        view.handleUpdateNotes([...view.notes, addedNote(view.videos[0].id, 'B body')]);
        await flush();
        expect(store.get(fB.path)).toContain('B body');
    });
});
