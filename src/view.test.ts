import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFile, WorkspaceLeaf } from 'obsidian';
import { Notice } from 'obsidian';
import { YoutnoteView } from './view';
import { promptLegacyConversionDecision } from './ui/MessageBoxes';
import type { LegacyConversionDecision } from './ui/MessageBoxes';
import type YoutnotePlugin from './main';
import type { Note, NoteId, VideoId } from './types';
import { extractFrontmatter } from './youtnote-format/frontmatter';
import { parseYoutnoteDocument, serializeYoutnoteDocument } from './youtnote-format';
import { validateYoutnoteUriParams } from './uri-scheme';

vi.mock('obsidian', () => {
    class FakeNotice {
        static calls: string[] = [];
        static records: { message: string; timeout: number | undefined; classes: string[] }[] = [];
        messageEl: { addClass: (cls: string) => void };
        constructor(message?: unknown, timeout?: number) {
            FakeNotice.calls.push(String(message));
            const record = { message: String(message), timeout, classes: [] as string[] };
            FakeNotice.records.push(record);
            this.messageEl = { addClass: (cls: string) => record.classes.push(cls) };
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
            Promise<LegacyConversionDecision> => {
            if (signal?.aborted) return Promise.resolve('read-only');
            return new Promise<LegacyConversionDecision>(resolve => {
                signal?.addEventListener('abort', () => resolve('read-only'), { once: true });
                resolve('read-only');
            });
        }),
    };
});

function unsafeCast<T>(value: unknown): T {
    return value as T;
}

const CONVERT: LegacyConversionDecision = { action: 'convert', createBackup: false };
const CONVERT_WITH_BACKUP: LegacyConversionDecision = { action: 'convert', createBackup: true };

const plainNotice = (timeout: number) =>
    (record: { timeout: number | undefined; classes: string[] }) => record.timeout === timeout && record.classes.length === 0;
const themedNotice = (cls: string) =>
    (record: { timeout: number | undefined; classes: string[] }) => record.timeout === 0 && record.classes.includes(cls);

const LEGACY = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=aircAruvnKk)

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

<!-- youtnote:file:start -->

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
Test Video
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=aircAruvnKk
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=0:05 -->
A note.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

<!-- youtnote:file:end -->
`;

const DECLARED_V1 = `---
youtnote: true
youtnote-format-version: 1
---

[Test Video](https://www.youtube.com/watch?v=aircAruvnKk)
`;

const V2_B = `---
youtnote: true
youtnote-format-version: 2
---

<!-- youtnote:file:start -->

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
Other Video
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=abcdefghijk
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

<!-- youtnote:file:end -->
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

<!-- youtnote:file:start -->

<!-- youtnote:topic-description:start -->
file-level payload
<!-- youtnote:topic-description:end -->

<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
Test Video
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=aircAruvnKk
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->

<!-- youtnote:file:end -->
`;

const INVALID_LEGACY = `---
youtnote: true
---

plain text that the legacy format cannot hold
`;

const RICH_V2_FRONTMATTER = `---
# file-level comment preserved verbatim
title: "Notes: Part #1" # inline comment preserved
tags:
  - learning
  - video-notes
aliases:
  - first-alias
  - "Quoted: Alias #2"
youtnote: true
youtnote-format-version: 2
metadata:
  author: someone
  youtnote-format-version: 99
  nested:
    deep: true
literal_block: |
  literal line one
  literal line two: kept
folded_block: >
  folded text
  continues here
views: 42
draft: false
rating: null
# trailing comment
---`;

const RICH_MIGRATED_FRONTMATTER = RICH_V2_FRONTMATTER;

const RICH_LEGACY_FRONTMATTER = RICH_V2_FRONTMATTER
    .replace('\nyoutnote-format-version: 2\n', '\n');

const RICH_V1_FRONTMATTER = RICH_V2_FRONTMATTER
    .replace('\nyoutnote-format-version: 2\n', '\nyoutnote-format-version: 1\n');

const RICH_REFRESHED_FRONTMATTER = RICH_V2_FRONTMATTER
    .replace('title: "Notes: Part #1" # inline comment preserved', 'title: "Renamed: Part #2"')
    .replace('views: 42\n', '')
    .replace('# trailing comment', 'extra_prop: added-externally\n# trailing comment');

const RICH_ROUNDTRIP_FRONTMATTER = RICH_V2_FRONTMATTER
    .replace('# trailing comment', 'closed_edit: added-while-closed\n# trailing comment');

const RICH_V2_FIRST_VIDEO = `<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
Test Video
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=aircAruvnKk
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:general-note:start -->
Original general body.
<!-- youtnote:general-note:end -->

<!-- youtnote:timestamped-note:start t=0:05 -->
Original timestamped body.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->`;

const RICH_V2_SECOND_VIDEO = `<!-- youtnote:video:start -->

<!-- youtnote:source:start -->
<!-- youtnote:title:start -->
Other Video
<!-- youtnote:title:end -->
<!-- youtnote:url:start -->
https://www.youtube.com/watch?v=abcdefghijk
<!-- youtnote:url:end -->
<!-- youtnote:source:end -->

<!-- youtnote:notes:start -->

<!-- youtnote:timestamped-note:start t=0:10 -->
Second video note.
<!-- youtnote:timestamped-note:end -->

<!-- youtnote:notes:end -->

<!-- youtnote:video:end -->`;

const RICH_V2_BODY = `\n<!-- youtnote:file:start -->\n\n${RICH_V2_FIRST_VIDEO}\n\n<!-- youtnote:file:end -->\n`;
const RICH_V2_TWO_BODY = `\n<!-- youtnote:file:start -->\n\n${RICH_V2_FIRST_VIDEO}\n\n${RICH_V2_SECOND_VIDEO}\n\n<!-- youtnote:file:end -->\n`;

const V2_RICH = `${RICH_V2_FRONTMATTER}\n${RICH_V2_BODY}`;
const V2_RICH_TWO = `${RICH_V2_FRONTMATTER}\n${RICH_V2_TWO_BODY}`;
const V2_RICH_REFRESHED = `${RICH_REFRESHED_FRONTMATTER}\n${RICH_V2_BODY}`;
const V2_RICH_ROUNDTRIP = `${RICH_ROUNDTRIP_FRONTMATTER}\n${RICH_V2_BODY}`;

const RICH_LEGACY_BODY = `
[Test Video](https://www.youtube.com/watch?v=aircAruvnKk)

[0:05](timestamp)
A note.
`;

const LEGACY_RICH = `${RICH_LEGACY_FRONTMATTER}\n${RICH_LEGACY_BODY}`;
const LEGACY_RICH_V1 = `${RICH_V1_FRONTMATTER}\n${RICH_LEGACY_BODY}`;

const rawFrontmatter = (source: string) => extractFrontmatter(source).raw;

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
        create: vi.fn(async (path: string, data: string) => {
            if (store.has(path)) {
                throw new Error('File already exists.');
            }
            store.set(path, data);
            return unsafeCast<TFile>({ path, basename: path.replace(/\.md$/i, '') });
        }),
        adapter: {
            exists: vi.fn(async (path: string) => store.has(path)),
        },
    };
    const layoutCallbacks: (() => void)[] = [];
    const workspace = {
        layoutReady: true,
        onLayoutReady: vi.fn((callback: () => void) => {
            layoutCallbacks.push(callback);
        }),
    };
    const app = {
        vault,
        workspace,
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
    const finishLayout = () => {
        workspace.layoutReady = true;
        for (const callback of layoutCallbacks.splice(0)) {
            callback();
        }
    };
    return { store, vault, app, leaf, plugin, view, file, workspace, layoutCallbacks, finishLayout };
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

interface NoticeRecordSnapshot {
    message: string;
    timeout: number | undefined;
    classes: string[];
}

function noticeRecords(): NoticeRecordSnapshot[] {
    return unsafeCast<{ records: NoticeRecordSnapshot[] }>(Notice).records;
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
        noticeRecords().length = 0;
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
        expect(vi.mocked(promptLegacyConversionDecision).mock.calls[0][1]).toBe('legacy.md');
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
        decide!(CONVERT);
        await loading;
        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        expect(store.get(f.path)).toContain('abcdefghijk');
        expect(view.getWriteMode()).toBe('editable-v2');
        const success = noticeRecords().find(plainNotice(4000));
        expect(success).toBeDefined();
        expect(success?.timeout).toBe(4000);
        expect(success?.classes).toEqual([]);
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
        decide!(CONVERT);
        await loading;
        expect(store.get(f.path)).toBe(V2);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(noticeRecords().some(plainNotice(4000))).toBe(false);
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
        decide!(CONVERT);
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
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
        view.handleRequestConversion();
        await flush();
        await flush();
        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(view.getWriteMode()).toBe('editable-v2');
    });

    it('converts through the read-only banner request with a backup when checked', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('legacy-preview');
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
        view.handleRequestConversion();
        await flush();
        await flush();
        expect(vault.create).toHaveBeenCalledTimes(1);
        expect(store.get('legacy - legacy backup.md')).toBe(LEGACY);
        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(store.get(f.path)).toContain('youtnote-format-version: 2');
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
        expect(vi.mocked(promptLegacyConversionDecision).mock.calls[1][1]).toBe('b.md');
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
        expect(vi.mocked(promptLegacyConversionDecision).mock.calls[1][1]).toBe('b.md');
        await loadA;
        resolvers[1](CONVERT);
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
        decide!(CONVERT);
        await flush();
        expect(processCallback).not.toBeNull();
        await view.onLoadFile(fB);
        const migrated = processCallback!(store.get(fA.path) ?? '');
        finishProcess!(migrated);
        await loading;
        expect(migrated).toBe(LEGACY);
        expect(store.get(fA.path)).toBe(LEGACY);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(noticeRecords().some(plainNotice(4000))).toBe(false);
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
        expect(saved).toContain('youtnote:topic-description:start');
        expect(saved).toContain('file-level payload');
        expect(saved).not.toContain('aircAruvnKk');
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
        vi.mocked(vault.read).mockImplementation((f: { path: string }) => {
            reads++;
            if (reads === 2) {
                return new Promise<string>(resolve => { resolvePostRead = resolve; });
            }
            return Promise.resolve(store.get(f.path) ?? '');
        });
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
        const loading = view.onLoadFile(f);
        await flush();
        await view.onUnloadFile(f);
        resolvePostRead!(store.get(f.path) ?? '');
        await loading;
        await flush();
        expect(view.getWriteMode()).toBe('blocked');
        expect(noticeRecords().some(plainNotice(4000))).toBe(false);
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
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
        vi.mocked(vault.process).mockRejectedValueOnce(new Error('deleted'));
        await view.onLoadFile(f);
        await flush();
        expect(store.get(f.path)).toBe(LEGACY);
        expect(view.getWriteMode()).not.toBe('editable-v2');
        const failure = noticeRecords().find(themedNotice('youtnote-plugin__notice-error'));
        expect(failure).toBeDefined();
        expect(failure?.timeout).toBe(0);
        expect(failure?.classes).toEqual(['youtnote-plugin__notice-error']);
    });

    it('shows a normal timed notice for an export when opening the file is disabled', async () => {
        const { store, view, file, plugin, app } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        unsafeCast<Record<string, unknown>>(plugin).settings = { openExportedFile: false };
        const create = vi.fn(async (path: string, _data: string) => ({ path }));
        const openFile = vi.fn(async () => {});
        unsafeCast<Record<string, unknown>>(app).vault = {
            ...app.vault,
            adapter: { exists: vi.fn(async () => false) },
            create,
        };
        unsafeCast<Record<string, unknown>>(app).workspace = {
            ...app.workspace,
            getLeaf: vi.fn(() => ({ openFile })),
        };
        const recordsBefore = noticeRecords().length;
        await view.createExportFile('a - Export', 'export body');
        expect(create).toHaveBeenCalledWith('a - Export.md', 'export body');
        expect(openFile).not.toHaveBeenCalled();
        const records = noticeRecords().slice(recordsBefore);
        expect(records).toHaveLength(1);
        expect(records[0].message).toContain('a - Export.md');
        expect(records[0].timeout).toBe(2000);
        expect(records[0].classes).toEqual([]);
    });

    describe('backup before legacy conversion', () => {
        it('creates an exact legacy backup in the same folder and converts the original in place', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vault.create).toHaveBeenCalledTimes(1);
            expect(vi.mocked(vault.create).mock.calls[0][0]).toBe('legacy - legacy backup.md');
            expect(store.get('legacy - legacy backup.md')).toBe(LEGACY);
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
            expect(store.get(f.path)).not.toBe(LEGACY);
            expect(view.getWriteMode()).toBe('editable-v2');
            expect(noticeRecords().some(r => plainNotice(6000)(r) && r.message.includes('legacy - legacy backup.md'))).toBe(true);
        });

        it('numbers the backup path inside nested folders without overwriting existing files', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('nested dir/my file.md');
            store.set(f.path, LEGACY_B);
            store.set('nested dir/my file - legacy backup.md', 'occupied 1');
            store.set('nested dir/my file - legacy backup 2.md', 'occupied 2');
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vi.mocked(vault.create).mock.calls.map(call => call[0]))
                .toEqual(['nested dir/my file - legacy backup 3.md']);
            expect(store.get('nested dir/my file - legacy backup.md')).toBe('occupied 1');
            expect(store.get('nested dir/my file - legacy backup 2.md')).toBe('occupied 2');
            expect(store.get('nested dir/my file - legacy backup 3.md')).toBe(LEGACY_B);
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        });

        it('moves to the next numbered path when create fails on a colliding destination', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(vault.create).mockImplementationOnce(async (path: string, _data: string) => {
                store.set(path, 'raced content');
                throw new Error('File already exists.');
            });
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vi.mocked(vault.create).mock.calls.map(call => call[0]))
                .toEqual(['legacy - legacy backup.md', 'legacy - legacy backup 2.md']);
            expect(store.get('legacy - legacy backup.md')).toBe('raced content');
            expect(store.get('legacy - legacy backup 2.md')).toBe(LEGACY);
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        });

        it('creates no backup when the option is unchecked', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
            await view.onLoadFile(f);
            await flush();
            expect(vault.create).not.toHaveBeenCalled();
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        });

        it('creates no backup when the decision is read-only', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue('read-only');
            await view.onLoadFile(f);
            await flush();
            expect(vault.create).not.toHaveBeenCalled();
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(LEGACY);
            expect(view.getWriteMode()).toBe('legacy-preview');
        });

        it('creates no backup when the pending prompt is aborted by unloading', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(promptLegacyConversionDecision).mockImplementation((_app, _name, signal) =>
                new Promise<LegacyConversionDecision>(resolve => {
                    signal?.addEventListener('abort', () => resolve('read-only'), { once: true });
                }));
            const loading = view.onLoadFile(f);
            await flush();
            expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
            await view.onUnloadFile(f);
            await loading;
            await flush();
            expect(vault.create).not.toHaveBeenCalled();
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(LEGACY);
        });

        it('stops without touching the original when the backup cannot be created', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            const recordsBefore = noticeRecords().length;
            vi.mocked(vault.create).mockRejectedValue(new Error('disk full'));
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vault.create).toHaveBeenCalledTimes(1);
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(LEGACY);
            expect(view.getWriteMode()).toBe('legacy-preview');
            const records = noticeRecords().slice(recordsBefore);
            expect(records).toHaveLength(1);
            expect(records[0].timeout).toBe(0);
            expect(records[0].classes).toEqual(['youtnote-plugin__notice-error']);
            expect(records[0].message).toContain('disk full');
        });

        it('stops without creating anything when the existence check fails', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            const recordsBefore = noticeRecords().length;
            vi.mocked(vault.adapter.exists).mockRejectedValue(new Error('storage unavailable'));
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vault.adapter.exists).toHaveBeenCalledTimes(1);
            expect(vault.create).not.toHaveBeenCalled();
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(LEGACY);
            const records = noticeRecords().slice(recordsBefore);
            expect(records).toHaveLength(1);
            expect(records[0].timeout).toBe(0);
            expect(records[0].classes).toEqual(['youtnote-plugin__notice-error']);
            expect(records[0].message).toContain('storage unavailable');
        });

        it('stops without retrying when the post-create existence recheck fails', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            const recordsBefore = noticeRecords().length;
            vi.mocked(vault.create).mockRejectedValue(new Error('create failed'));
            vi.mocked(vault.adapter.exists)
                .mockResolvedValueOnce(false)
                .mockRejectedValue(new Error('exists check failed'));
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vault.create).toHaveBeenCalledTimes(1);
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(LEGACY);
            const records = noticeRecords().slice(recordsBefore);
            expect(records).toHaveLength(1);
            expect(records[0].timeout).toBe(0);
            expect(records[0].classes).toEqual(['youtnote-plugin__notice-error']);
        });

        it.each(['initial exists', 'post-create exists recheck'] as const)(
            'shows no backup failure notice when the view unloads before the %s rejection lands',
            async (kind) => {
                const { store, vault, view, file } = makeFixture();
                const f = file('legacy.md');
                store.set(f.path, LEGACY);
                const recordsBefore = noticeRecords().length;
                let rejectExists: ((error: unknown) => void) | null = null;
                if (kind === 'post-create exists recheck') {
                    vi.mocked(vault.adapter.exists)
                        .mockResolvedValueOnce(false)
                        .mockImplementationOnce(() =>
                            new Promise<boolean>((_resolve, reject) => { rejectExists = reject; }));
                    vi.mocked(vault.create).mockRejectedValueOnce(new Error('create failed'));
                } else {
                    vi.mocked(vault.adapter.exists).mockImplementationOnce(() =>
                        new Promise<boolean>((_resolve, reject) => { rejectExists = reject; }));
                }
                vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
                const loading = view.onLoadFile(f);
                await flush();
                if (kind === 'post-create exists recheck') {
                    expect(vault.create).toHaveBeenCalledTimes(1);
                    expect(vault.adapter.exists).toHaveBeenCalledTimes(2);
                } else {
                    expect(vault.adapter.exists).toHaveBeenCalledTimes(1);
                }
                await view.onUnloadFile(f);
                rejectExists!(new Error('storage unavailable'));
                await loading;
                await flush();
                expect(vault.process).not.toHaveBeenCalled();
                expect(store.get(f.path)).toBe(LEGACY);
                const records = noticeRecords().slice(recordsBefore);
                expect(records).toHaveLength(0);
            },
        );

        it('stops without a backup when the fresh source snapshot cannot be read', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(vault.read).mockRejectedValueOnce(new Error('read failed'));
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vault.adapter.exists).not.toHaveBeenCalled();
            expect(vault.create).not.toHaveBeenCalled();
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(LEGACY);
            expect(noticeRecords().some(r => r.classes.includes('youtnote-plugin__notice-error'))).toBe(true);
        });

        it('keeps the created backup when the conversion write itself fails', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(vault.process).mockRejectedValueOnce(new Error('process failed'));
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(store.get('legacy - legacy backup.md')).toBe(LEGACY);
            expect(store.get(f.path)).toBe(LEGACY);
            expect(noticeRecords().some(themedNotice('youtnote-plugin__notice-error'))).toBe(true);
        });

        it('keeps newer source bytes and warns when the file changes between backup and process', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(vault.create).mockImplementationOnce(async (path: string, data: string) => {
                store.set(f.path, LEGACY_B);
                store.set(path, data);
                return unsafeCast<TFile>({ path, basename: path });
            });
            const recordsBefore = noticeRecords().length;
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(store.get(f.path)).toBe(LEGACY_B);
            expect(view.getWriteMode()).toBe('legacy-preview');
            const records = noticeRecords().slice(recordsBefore);
            const warning = records.find(themedNotice('youtnote-plugin__notice-warning'));
            expect(warning).toBeDefined();
            expect(warning?.timeout).toBe(0);
            expect(warning?.classes).toEqual(['youtnote-plugin__notice-warning']);
            expect(records.some(plainNotice(4000))).toBe(false);
        });

        it('does not downgrade when the file becomes v3 while the backup is pending', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            vi.mocked(vault.create).mockImplementationOnce(async (path: string, data: string) => {
                store.set(f.path, V3);
                store.set(path, data);
                return unsafeCast<TFile>({ path, basename: path });
            });
            vi.mocked(vault.cachedRead).mockResolvedValue(LEGACY);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(store.get(f.path)).toBe(V3);
            expect(view.getWriteMode()).toBe('blocked');
        });

        it('writes nothing to either file when a switch happens while the backup is pending', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            const other = file('other.md');
            store.set(f.path, LEGACY);
            store.set(other.path, V2_B);
            let resolveCreate: ((created: TFile) => void) | null = null;
            vi.mocked(vault.create).mockImplementationOnce(async (path: string, data: string) => {
                return new Promise<TFile>(resolve => {
                    resolveCreate = () => {
                        store.set(path, data);
                        resolve(unsafeCast<TFile>({ path, basename: path }));
                    };
                });
            });
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            const loading = view.onLoadFile(f);
            await flush();
            expect(vault.create).toHaveBeenCalledTimes(1);
            await view.onLoadFile(other);
            resolveCreate!(unsafeCast<TFile>({ path: 'legacy - legacy backup.md' }));
            await loading;
            await flush();
            expect(store.get(f.path)).toBe(LEGACY);
            expect(store.get('other.md')).toBe(V2_B);
        });

        it('does not rewrite the original when the file unloads while the backup is pending', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            let resolveCreate: ((created: TFile) => void) | null = null;
            vi.mocked(vault.create).mockImplementationOnce(async (path: string, data: string) => {
                return new Promise<TFile>(resolve => {
                    resolveCreate = () => {
                        store.set(path, data);
                        resolve(unsafeCast<TFile>({ path, basename: path }));
                    };
                });
            });
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            const loading = view.onLoadFile(f);
            await flush();
            expect(vault.create).toHaveBeenCalledTimes(1);
            await view.onUnloadFile(f);
            resolveCreate!(unsafeCast<TFile>({ path: 'legacy - legacy backup.md' }));
            await loading;
            await flush();
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(LEGACY);
            expect(store.get('legacy - legacy backup.md')).toBe(LEGACY);
        });

        it('does not rewrite old or new paths when the file is renamed while the backup is pending', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            let resolveCreate: ((created: TFile) => void) | null = null;
            vi.mocked(vault.create).mockImplementationOnce(async (path: string, data: string) => {
                return new Promise<TFile>(resolve => {
                    resolveCreate = () => {
                        store.set(path, data);
                        resolve(unsafeCast<TFile>({ path, basename: path }));
                    };
                });
            });
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            const loading = view.onLoadFile(f);
            await flush();
            expect(vault.create).toHaveBeenCalledTimes(1);
            store.delete('legacy.md');
            store.set('renamed.md', LEGACY_B);
            unsafeCast<{ path: string }>(f).path = 'renamed.md';
            resolveCreate!(unsafeCast<TFile>({ path: 'legacy - legacy backup.md' }));
            await loading;
            await flush();
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get('renamed.md')).toBe(LEGACY_B);
            expect(store.has('legacy.md')).toBe(false);
            expect(store.get('legacy - legacy backup.md')).toBe(LEGACY);
        });

        it('names the backup from the real file name, including a .md.md file', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('dir/foo.md.md');
            store.set(f.path, LEGACY);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vi.mocked(promptLegacyConversionDecision).mock.calls[0][1]).toBe('foo.md.md');
            expect(vi.mocked(vault.create).mock.calls.map(call => call[0]))
                .toEqual(['dir/foo.md - legacy backup.md']);
            expect(store.get('dir/foo.md - legacy backup.md')).toBe(LEGACY);
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        });

        it('stores the exact frontmatter and whitespace bytes in the backup', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich.md');
            store.set(f.path, LEGACY_RICH);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vault.create).toHaveBeenCalledTimes(1);
            expect(store.get('rich - legacy backup.md')).toBe(LEGACY_RICH);
            expect(store.get(f.path)).not.toBe(LEGACY_RICH);
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        });

        it('skips backup and rewrite when the file is already v2 once consent resolves', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            const decision = deferred<LegacyConversionDecision>();
            vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);
            const loading = view.onLoadFile(f);
            await flush();
            store.set(f.path, V2);
            decision.resolve(CONVERT_WITH_BACKUP);
            await loading;
            await flush();
            expect(vault.create).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(V2);
            expect(view.getWriteMode()).toBe('editable-v2');
        });

        it('backs up the original bytes for an explicitly declared v1 file', async () => {
            const { store, view, file } = makeFixture();
            const f = file('declared-v1.md');
            store.set(f.path, DECLARED_V1);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(store.get('declared-v1 - legacy backup.md')).toBe(DECLARED_V1);
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
            expect(view.getWriteMode()).toBe('editable-v2');
        });

        it('backs up the original bytes for a corrected-declaration migration', async () => {
            const { store, view, file } = makeFixture();
            const f = file('mislabeled.md');
            store.set(f.path, LEGACY);
            const mislabeled = `---\nyoutnote: true\nyoutnote-format-version: 1\n---\n${V2.slice(V2.indexOf('<!-- youtnote:file:start'))}`;
            const decision = deferred<LegacyConversionDecision>();
            vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);
            const loading = view.onLoadFile(f);
            await flush();
            store.set(f.path, mislabeled);
            decision.resolve(CONVERT_WITH_BACKUP);
            await loading;
            await flush();
            expect(store.get('mislabeled - legacy backup.md')).toBe(mislabeled);
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
            expect(view.getWriteMode()).toBe('editable-v2');
            expect(noticeRecords().some(plainNotice(4000))).toBe(true);
        });

        it('creates no backup for an invalid legacy document', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('broken.md');
            store.set(f.path, INVALID_LEGACY);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT_WITH_BACKUP);
            await view.onLoadFile(f);
            await flush();
            expect(vault.create).not.toHaveBeenCalled();
            expect(vault.process).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(INVALID_LEGACY);
            expect(view.getWriteMode()).toBe('blocked');
        });

        it('converts the source as it was when consent resolved, not when the prompt opened', async () => {
            const { store, view, file } = makeFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            const decision = deferred<LegacyConversionDecision>();
            vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);
            const loading = view.onLoadFile(f);
            await flush();
            store.set(f.path, LEGACY_B);
            decision.resolve(CONVERT_WITH_BACKUP);
            await loading;
            await flush();
            expect(store.get(f.path)).toContain('youtnote-format-version: 2');
            expect(store.get(f.path)).toContain('abcdefghijk');
            expect(store.get('legacy - legacy backup.md')).toBe(LEGACY_B);
            expect(view.getWriteMode()).toBe('editable-v2');
        });
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
        decide!(CONVERT);
        await loading;
        await flush();
        expect(store.get(f.path)).toBe(V3);
        expect(view.getWriteMode()).not.toBe('editable-v2');
        expect(noticeRecords().some(plainNotice(4000))).toBe(false);
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
        expect(saved).toContain('youtnote:topic-description:start');
        expect(saved).toContain('file-level payload');
        expect(saved).toContain('New note body');
        expect(saved.indexOf('youtnote:topic-description:start')).toBeLessThan(saved.indexOf('youtnote:video:start'));
    });

    it('persists URI-validated timestamped and general notes through save and reopen', async () => {
        const { store, view, file, leaf, plugin } = makeFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        const videoId = view.videos[0].id;
        const noteParams = validateYoutnoteUriParams(
            { url: 'https://www.youtube.com/watch?v=aircAruvnKk', mode: 'note', timestamp: '0:07', text: 'URI note body' },
            200,
        );
        expect(noteParams.valid).toBe(true);
        const generalParams = validateYoutnoteUriParams(
            { url: 'https://www.youtube.com/watch?v=aircAruvnKk', mode: 'general-note', text: 'URI general body' },
            200,
        );
        expect(generalParams.valid).toBe(true);
        view.handleUpdateNotes([
            ...view.notes,
            {
                id: 'note-uri' as NoteId,
                videoId,
                timestampSec: noteParams.timestampSec!,
                bodyMarkdown: noteParams.text!,
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            },
            {
                id: 'note-uri-general' as NoteId,
                videoId,
                timestampSec: -1,
                bodyMarkdown: generalParams.text!,
                isGeneral: true,
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            },
        ]);
        await view.save();
        const saved = store.get(f.path)!;
        expect(saved).toContain('<!-- youtnote:timestamped-note:start t=7 -->');
        expect(saved).toContain('<!-- youtnote:general-note:start -->\nURI general body\n<!-- youtnote:general-note:end -->');
        const reparsed = parseYoutnoteDocument(saved);
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;
        expect(reparsed.document.notes.some(
            n => n.timestampSec === 7 && n.bodyMarkdown === 'URI note body' && !n.isGeneral,
        )).toBe(true);
        expect(reparsed.document.notes.some(
            n => n.isGeneral === true && n.bodyMarkdown === 'URI general body',
        )).toBe(true);
        const reopened = new YoutnoteView(leaf, plugin);
        await reopened.onLoadFile(file('a.md'));
        expect(reopened.notes.some(n => n.bodyMarkdown === 'URI note body')).toBe(true);
        expect(reopened.notes.some(n => n.bodyMarkdown === 'URI general body')).toBe(true);
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
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
        vi.mocked(vault.read)
            .mockResolvedValueOnce(LEGACY)
            .mockRejectedValueOnce(new Error('read failed'));
        await view.onLoadFile(f);
        expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        expect(noticeRecords().some(themedNotice('youtnote-plugin__notice-error'))).toBe(true);
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
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
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
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
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

    describe('custom frontmatter regression', () => {
        const generalNote = (videoId: VideoId, body: string): Note => ({
            id: `general-${body}` as NoteId,
            videoId,
            timestampSec: -1,
            bodyMarkdown: body,
            isGeneral: true,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        });

        it.each<[string, (view: YoutnoteView) => void, (saved: string) => void]>([
            ['add timestamped note',
                view => view.handleUpdateNotes([...view.notes, addedNote(view.videos[0].id, 'Added timestamped body')]),
                saved => {
                    expect(saved).toContain('Added timestamped body');
                    expect(saved).toContain('Original timestamped body');
                }],
            ['edit timestamped note',
                view => view.handleUpdateNotes(view.notes.map(n =>
                    n.isGeneral ? n : { ...n, bodyMarkdown: 'Edited timestamped body' })),
                saved => {
                    expect(saved).toContain('Edited timestamped body');
                    expect(saved).not.toContain('Original timestamped body');
                }],
            ['delete timestamped note',
                view => view.handleUpdateNotes(view.notes.filter(n => n.isGeneral)),
                saved => {
                    expect(saved).not.toContain('Original timestamped body');
                    expect(saved).toContain('Original general body');
                }],
            ['add general note',
                view => view.handleUpdateNotes([...view.notes, generalNote(view.videos[0].id, 'Added general body')]),
                saved => {
                    expect(saved).toContain('Added general body');
                    expect(saved).toContain('Original general body');
                }],
            ['edit general note',
                view => view.handleUpdateNotes(view.notes.map(n =>
                    n.isGeneral ? { ...n, bodyMarkdown: 'Edited general body' } : n)),
                saved => {
                    expect(saved).toContain('Edited general body');
                    expect(saved).not.toContain('Original general body');
                }],
            ['delete general note',
                view => view.handleUpdateNotes(view.notes.filter(n => !n.isGeneral)),
                saved => {
                    expect(saved).not.toContain('Original general body');
                    expect(saved).not.toContain('youtnote:general-note:start');
                }],
        ])('keeps the rich frontmatter byte-identical through %s', async (_name, apply, assertSaved) => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich.md');
            store.set(f.path, V2_RICH);
            await view.onLoadFile(f);
            expect(view.isWritable()).toBe(true);
            apply(view);
            await flush();
            expect(vault.modify).toHaveBeenCalledTimes(1);
            const saved = store.get(f.path)!;
            expect(rawFrontmatter(saved)).toBe(RICH_V2_FRONTMATTER);
            assertSaved(saved);
            const reparsed = parseYoutnoteDocument(saved);
            expect(reparsed.ok).toBe(true);
        });

        it('keeps the rich frontmatter byte-identical when adding a video', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich.md');
            store.set(f.path, V2_RICH);
            await view.onLoadFile(f);
            view.handleUpdateVideos([...view.videos, {
                id: 'video-added' as VideoId,
                url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz',
                title: 'Added Video',
            }]);
            await flush();
            expect(vault.modify).toHaveBeenCalledTimes(1);
            const saved = store.get(f.path)!;
            expect(rawFrontmatter(saved)).toBe(RICH_V2_FRONTMATTER);
            expect(saved).toContain('<!-- youtnote:title:start -->\nAdded Video\n<!-- youtnote:title:end -->');
            expect(saved).toContain('<!-- youtnote:url:start -->\nhttps://www.youtube.com/watch?v=zzzzzzzzzzz\n<!-- youtnote:url:end -->');
            const reparsed = parseYoutnoteDocument(saved);
            expect(reparsed.ok).toBe(true);
            if (reparsed.ok) expect(reparsed.document.videos).toHaveLength(2);
        });

        it('keeps the rich frontmatter byte-identical when updating a video title', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich.md');
            store.set(f.path, V2_RICH);
            await view.onLoadFile(f);
            view.handleUpdateVideos(view.videos.map(v => ({ ...v, title: 'Renamed Video' })));
            await flush();
            expect(vault.modify).toHaveBeenCalledTimes(1);
            const saved = store.get(f.path)!;
            expect(rawFrontmatter(saved)).toBe(RICH_V2_FRONTMATTER);
            expect(saved).toContain('<!-- youtnote:title:start -->\nRenamed Video\n<!-- youtnote:title:end -->');
            expect(saved).not.toContain('Test Video');
        });

        it('keeps the rich frontmatter byte-identical when deleting a non-last video', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich-two.md');
            store.set(f.path, V2_RICH_TWO);
            await view.onLoadFile(f);
            expect(view.videos).toHaveLength(2);
            const kept = view.videos[1];
            view.handleUpdateVideos([kept]);
            view.handleUpdateNotes(view.notes.filter(n => n.videoId === kept.id));
            await flush();
            expect(vault.modify).toHaveBeenCalled();
            const saved = store.get(f.path)!;
            expect(rawFrontmatter(saved)).toBe(RICH_V2_FRONTMATTER);
            expect(saved).not.toContain('aircAruvnKk');
            expect(saved).not.toContain('Original timestamped body');
            expect(saved).toContain('abcdefghijk');
            expect(saved).toContain('Second video note');
            const reparsed = parseYoutnoteDocument(saved);
            expect(reparsed.ok).toBe(true);
            if (reparsed.ok) {
                expect(reparsed.document.videos).toHaveLength(1);
                expect(reparsed.document.notes).toHaveLength(1);
            }
        });

        it('writes only the frontmatter block and an empty file wrapper after deleting the last video', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich.md');
            store.set(f.path, V2_RICH);
            await view.onLoadFile(f);
            expect(view.notes).toHaveLength(2);
            view.handleUpdateVideos([]);
            await flush();
            expect(vault.modify).toHaveBeenCalledTimes(1);
            expect(store.get(f.path)).toBe(
                `${RICH_V2_FRONTMATTER}\n\n<!-- youtnote:file:start -->\n\n<!-- youtnote:file:end -->\n`);
        });

        it.each([
            ['unversioned', LEGACY_RICH],
            ['declared v1', LEGACY_RICH_V1],
        ])('changes only the format declaration when converting a rich %s legacy file on open', async (_label, source) => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich-legacy.md');
            store.set(f.path, source);
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
            await view.onLoadFile(f);
            await flush();
            expect(vault.process).toHaveBeenCalledTimes(1);
            const migrated = store.get(f.path)!;
            expect(rawFrontmatter(migrated)).toBe(RICH_MIGRATED_FRONTMATTER);
            expect(migrated.startsWith(`${RICH_MIGRATED_FRONTMATTER}\n`)).toBe(true);
            expect(migrated).toContain('<!-- youtnote:video:start -->');
            expect(view.isWritable()).toBe(true);
            vi.mocked(vault.modify).mockClear();
            view.handleUpdateNotes([...view.notes, addedNote(view.videos[0].id, 'Post-conversion rich body')]);
            await flush();
            expect(vault.modify).toHaveBeenCalledTimes(1);
            const saved = store.get(f.path)!;
            expect(rawFrontmatter(saved)).toBe(RICH_MIGRATED_FRONTMATTER);
            expect(saved).toContain('Post-conversion rich body');
        });

        it.each([
            ['unversioned', LEGACY_RICH],
            ['declared v1', LEGACY_RICH_V1],
        ])('changes only the format declaration when converting a rich %s legacy file from the banner', async (_label, source) => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich-legacy.md');
            store.set(f.path, source);
            await view.onLoadFile(f);
            expect(view.getWriteMode()).toBe('legacy-preview');
            vi.mocked(promptLegacyConversionDecision).mockResolvedValue(CONVERT);
            view.handleRequestConversion();
            await flush();
            expect(vault.process).toHaveBeenCalledTimes(1);
            expect(rawFrontmatter(store.get(f.path)!)).toBe(RICH_MIGRATED_FRONTMATTER);
            expect(view.isWritable()).toBe(true);
            vi.mocked(vault.modify).mockClear();
            view.handleUpdateNotes([...view.notes, addedNote(view.videos[0].id, 'Post-banner rich body')]);
            await flush();
            expect(vault.modify).toHaveBeenCalledTimes(1);
            const saved = store.get(f.path)!;
            expect(rawFrontmatter(saved)).toBe(RICH_MIGRATED_FRONTMATTER);
            expect(saved).toContain('Post-banner rich body');
        });

        it('converts the latest rich frontmatter when the file changed during the pending decision', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich-legacy.md');
            store.set(f.path, LEGACY);
            let decide: ((d: LegacyConversionDecision) => void) | null = null;
            vi.mocked(promptLegacyConversionDecision).mockReturnValue(
                new Promise<LegacyConversionDecision>(resolve => { decide = resolve; }),
            );
            const loading = view.onLoadFile(f);
            await flush();
            store.set(f.path, LEGACY_RICH);
            decide!(CONVERT);
            await loading;
            expect(vault.process).toHaveBeenCalledTimes(1);
            const migrated = store.get(f.path)!;
            expect(rawFrontmatter(migrated)).toBe(RICH_MIGRATED_FRONTMATTER);
            expect(migrated).toContain('"Quoted: Alias #2"');
            expect(migrated).toContain('literal line two: kept');
        });

        it('persists edits on top of frontmatter delivered through an external refresh', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich.md');
            store.set(f.path, V2_RICH);
            await view.onLoadFile(f);
            expect(view.isWritable()).toBe(true);
            store.set(f.path, V2_RICH_REFRESHED);
            view.setViewData(V2_RICH_REFRESHED);
            expect(view.isWritable()).toBe(true);
            view.handleUpdateNotes([...view.notes, addedNote(view.videos[0].id, 'Post-refresh body')]);
            await flush();
            expect(vault.modify).toHaveBeenCalled();
            const saved = store.get(f.path)!;
            expect(rawFrontmatter(saved)).toBe(RICH_REFRESHED_FRONTMATTER);
            expect(saved).toContain('extra_prop: added-externally');
            expect(saved).not.toContain('views: 42');
            expect(saved).toContain('Post-refresh body');
        });

        it('keeps frontmatter added while the file was closed across unload and reload', async () => {
            const { store, vault, view, file } = makeFixture();
            const f = file('rich.md');
            store.set(f.path, V2_RICH);
            await view.onLoadFile(f);
            await view.onUnloadFile(f);
            store.set(f.path, V2_RICH_ROUNDTRIP);
            await view.onLoadFile(f);
            expect(view.isWritable()).toBe(true);
            vi.mocked(vault.modify).mockClear();
            view.handleUpdateNotes([...view.notes, addedNote(view.videos[0].id, 'Post-reload body')]);
            await flush();
            expect(vault.modify).toHaveBeenCalledTimes(1);
            const saved = store.get(f.path)!;
            expect(rawFrontmatter(saved)).toBe(RICH_ROUNDTRIP_FRONTMATTER);
            expect(saved).toContain('closed_edit: added-while-closed');
            expect(saved).toContain('Post-reload body');
        });
    });
});


describe('YoutnoteView startup legacy loading (layout not ready)', () => {
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
        noticeRecords().length = 0;
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('read-only');
    });

    const startupFixture = () => {
        const fixture = makeFixture();
        fixture.workspace.layoutReady = false;
        return fixture;
    };

    it('resolves the load into a read-only preview and prompts only after layout ready', async () => {
        const { store, vault, view, file, finishLayout } = startupFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        let settled = false;
        const loading = view.onLoadFile(f).then(() => { settled = true; });
        await flush();

        expect(settled).toBe(true);
        expect(vi.mocked(promptLegacyConversionDecision)).not.toHaveBeenCalled();
        expect(view.getWriteMode()).toBe('legacy-preview');
        expect(view.isWritable()).toBe(false);
        expect(view.videos).toHaveLength(1);
        expect(view.notes).toHaveLength(1);
        expect(view.getViewData()).toBe(LEGACY);
        view.requestSave();
        await view.save();
        expect(vault.process).not.toHaveBeenCalled();
        expect(vault.modify).not.toHaveBeenCalled();

        finishLayout();
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);

        decision.resolve('read-only');
        await flush();
        await loading;
        expect(view.getWriteMode()).toBe('legacy-preview');
        expect(store.get(f.path)).toBe(LEGACY);
    });

    it('defers conversion until layout ready and an explicit convert decision', async () => {
        const { store, vault, view, file, finishLayout } = startupFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        const loading = view.onLoadFile(f);
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).not.toHaveBeenCalled();
        expect(vault.process).not.toHaveBeenCalled();
        expect(view.getWriteMode()).toBe('legacy-preview');

        finishLayout();
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(vault.process).not.toHaveBeenCalled();

        decision.resolve(CONVERT);
        await flush();
        await loading;
        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(store.get(f.path)).toContain('youtnote-format-version: 2');
        expect(store.get(f.path)).toContain('aircAruvnKk');
        expect(parseYoutnoteDocument(store.get(f.path)!).ok).toBe(true);
        expect(view.getWriteMode()).toBe('editable-v2');
    });

    it.each(['unload', 'close', 'clear', 'switch-to-v2'] as const)(
        'cancels a queued startup prompt via %s without rewriting the file',
        async (how) => {
            const { store, vault, view, file, finishLayout } = startupFixture();
            const f = file('legacy.md');
            store.set(f.path, LEGACY);
            const decision = deferred<LegacyConversionDecision>();
            vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

            const loading = view.onLoadFile(f);
            await flush();
            expect(view.getWriteMode()).toBe('legacy-preview');

            if (how === 'unload') {
                await view.onUnloadFile(f);
            } else if (how === 'close') {
                await view.onClose();
            } else if (how === 'clear') {
                view.clear();
            } else {
                const other = file('other.md');
                store.set(other.path, V2);
                await view.onLoadFile(other);
                expect(view.getWriteMode()).toBe('editable-v2');
            }

            finishLayout();
            await flush();
            decision.resolve(CONVERT);
            await flush();
            await loading;

            expect(vi.mocked(promptLegacyConversionDecision)).not.toHaveBeenCalled();
            expect(store.get(f.path)).toBe(LEGACY);
            expect(vault.process).not.toHaveBeenCalled();
            expect(vault.modify).not.toHaveBeenCalled();
        }
    );

    it('queues a replacement decision when the same legacy file reloads during startup', async () => {
        const { store, view, file, finishLayout } = startupFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        const loading = view.onLoadFile(f);
        await flush();
        store.set(f.path, LEGACY_B);
        await view.onLoadFile(f);
        await flush();
        expect(view.getViewData()).toBe(LEGACY_B);
        expect(view.videos[0].url).toContain('abcdefghijk');

        finishLayout();
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        decision.resolve('read-only');
        await flush();
        await loading;
        expect(view.getViewData()).toBe(LEGACY_B);
        expect(store.get(f.path)).toBe(LEGACY_B);
    });

    it('only prompts for the current file when a different legacy file loads during startup', async () => {
        const { store, view, file, finishLayout } = startupFixture();
        const a = file('a.md');
        const b = file('b.md');
        store.set(a.path, LEGACY);
        store.set(b.path, LEGACY_B);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        await view.onLoadFile(a);
        await flush();
        await view.onLoadFile(b);
        await flush();
        expect(view.getViewData()).toBe(LEGACY_B);

        finishLayout();
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(promptLegacyConversionDecision).mock.calls[0][1]).toBe('b.md');
        decision.resolve('read-only');
        await flush();
        expect(store.get(a.path)).toBe(LEGACY);
        expect(view.getViewData()).toBe(LEGACY_B);
    });

    it('rechecks the latest source when a deferred read-only decision resolves', async () => {
        const { store, view, file, finishLayout } = startupFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        await view.onLoadFile(f);
        await flush();
        store.set(f.path, V2);
        finishLayout();
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        decision.resolve('read-only');
        await flush();
        expect(view.getWriteMode()).toBe('editable-v2');
    });

    it('does not rewrite an externally replaced future-version file on convert', async () => {
        const { store, vault, view, file, leaf, finishLayout } = startupFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        await view.onLoadFile(f);
        await flush();
        store.set(f.path, V3);
        finishLayout();
        await flush();
        decision.resolve(CONVERT);
        await flush();
        expect(store.get(f.path)).toBe(V3);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(view.getWriteMode()).toBe('blocked');
        expect(unsafeCast<{ setViewState: ReturnType<typeof vi.fn> }>(leaf).setViewState)
            .toHaveBeenCalledWith(expect.objectContaining({ type: 'markdown' }));
    });

    it('opens a v2 file editable at startup without prompting or queueing a layout callback', async () => {
        const { store, view, file, layoutCallbacks } = startupFixture();
        const f = file('a.md');
        store.set(f.path, V2);
        await view.onLoadFile(f);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(vi.mocked(promptLegacyConversionDecision)).not.toHaveBeenCalled();
        expect(layoutCallbacks).toHaveLength(0);
    });

    it('keeps awaiting the modal decision on a normal post-startup legacy open', async () => {
        const { store, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        let settled = false;
        const loading = view.onLoadFile(f).then(() => { settled = true; });
        await flush();
        expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        decision.resolve('read-only');
        await loading;
        expect(view.getWriteMode()).toBe('legacy-preview');
    });
});


describe('YoutnoteView same-tab legacy open while a v2 file was loaded', () => {
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
        noticeRecords().length = 0;
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('read-only');
    });

    it.each<LegacyConversionDecision>(['read-only', CONVERT])(
        'never renders the old v2 video under the new file while the modal is pending (%s)',
        async (decisionKind) => {
            const { store, vault, view, file, layoutCallbacks } = makeFixture();
            const oldFile = file('old.md');
            const newFile = file('legacy.md');
            store.set(oldFile.path, V2_B);
            store.set(newFile.path, LEGACY);

            await view.onLoadFile(oldFile);
            expect(view.getWriteMode()).toBe('editable-v2');
            await view.onUnloadFile(oldFile);

            interface Snapshot {
                file: string | undefined;
                videos: string[];
                notes: (string | undefined)[];
                writeMode: string;
                writable: boolean;
            }
            const snapshot = (): Snapshot => ({
                file: view.file?.path,
                videos: view.videos.map(v => v.url),
                notes: view.notes.map(n => n.bodyMarkdown),
                writeMode: view.getWriteMode(),
                writable: view.isWritable(),
            });
            const snapshots: Snapshot[] = [];
            const viewForSpy = unsafeCast<{ render(): void }>(view);
            const originalRender = viewForSpy.render.bind(view);
            vi.spyOn(viewForSpy, 'render').mockImplementation(() => {
                originalRender();
                snapshots.push(snapshot());
            });

            const decision = deferred<LegacyConversionDecision>();
            let promptSnapshot: Snapshot | null = null;
            vi.mocked(promptLegacyConversionDecision).mockImplementation(() => {
                promptSnapshot = snapshot();
                return decision.promise;
            });

            let settled = false;
            const loading = view.onLoadFile(newFile).then(() => { settled = true; });
            await flush();

            const expected = {
                file: newFile.path,
                videos: ['https://www.youtube.com/watch?v=aircAruvnKk'],
                notes: ['A note.'],
                writeMode: 'legacy-preview',
                writable: false,
            };
            expect(settled).toBe(false);
            expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
            expect(layoutCallbacks).toHaveLength(0);
            expect(promptSnapshot).toEqual(expected);
            expect(snapshots.length).toBeGreaterThan(0);
            for (const snap of snapshots) {
                expect(snap).toEqual(expected);
            }
            expect(view.getViewData()).toBe(LEGACY);
            expect(view.activeVideoId).toBe(view.videos[0].id);

            view.handleUpdateVideos([]);
            view.handleUpdateNotes([]);
            await flush();
            expect(vault.process).not.toHaveBeenCalled();
            expect(vault.modify).not.toHaveBeenCalled();

            decision.resolve(decisionKind);
            await loading;
            await flush();

            if (decisionKind === 'read-only') {
                expect(view.getWriteMode()).toBe('legacy-preview');
                expect(view.getViewData()).toBe(LEGACY);
                expect(vault.process).not.toHaveBeenCalled();
                expect(vault.modify).not.toHaveBeenCalled();
            } else {
                expect(vault.process).toHaveBeenCalledTimes(1);
                expect(view.getWriteMode()).toBe('editable-v2');
                const saved = store.get(newFile.path)!;
                expect(saved).toContain('youtnote-format-version: 2');
                expect(saved).toContain('A note.');
                expect(parseYoutnoteDocument(saved).ok).toBe(true);
            }
            expect(store.get(oldFile.path)).toBe(V2_B);
        }
    );
});


const LEGACY_TWO = `---
youtnote: true
---

[Test Video](https://www.youtube.com/watch?v=aircAruvnKk)

[0:05](timestamp)
A note.

[Other Video](https://www.youtube.com/watch?v=abcdefghijk)

[0:30](timestamp)
Other note.
`;

describe('YoutnoteView read-only preview identity after dismissing the popup', () => {
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
        noticeRecords().length = 0;
        vi.mocked(promptLegacyConversionDecision).mockResolvedValue('read-only');
    });

    it.each([false, true])(
        'keeps preview object identity when the source is unchanged (layoutReady=%s)',
        async (layoutReady) => {
            const { store, vault, view, file, workspace, finishLayout } = makeFixture();
            workspace.layoutReady = layoutReady;
            const f = file('legacy.md');
            store.set(f.path, LEGACY_TWO);
            const decision = deferred<LegacyConversionDecision>();
            vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

            const loading = view.onLoadFile(f);
            await flush();
            if (!layoutReady) {
                finishLayout();
                await flush();
            }
            expect(vi.mocked(promptLegacyConversionDecision)).toHaveBeenCalledTimes(1);
            expect(view.getWriteMode()).toBe('legacy-preview');
            expect(view.videos).toHaveLength(2);
            expect(view.notes).toHaveLength(2);

            view.handleSetActiveVideoId(view.videos[1].id);
            const videos = view.videos;
            const videoRefs = [...view.videos];
            const notes = view.notes;
            const noteRefs = [...view.notes];
            const active = view.activeVideoId;
            const readsBefore = vi.mocked(vault.cachedRead).mock.calls.length;

            decision.resolve('read-only');
            await loading;
            await flush();

            expect(vi.mocked(vault.cachedRead).mock.calls.length)
                .toBeGreaterThan(readsBefore);
            expect(view.videos).toBe(videos);
            view.videos.forEach((v, i) => expect(v).toBe(videoRefs[i]));
            expect(view.notes).toBe(notes);
            view.notes.forEach((n, i) => expect(n).toBe(noteRefs[i]));
            expect(view.activeVideoId).toBe(active);
            expect(view.getWriteMode()).toBe('legacy-preview');
            expect(view.isWritable()).toBe(false);
            expect(view.getViewData()).toBe(LEGACY_TWO);
            expect(vault.process).not.toHaveBeenCalled();
            expect(vault.modify).not.toHaveBeenCalled();
            expect(unsafeCast<{ pendingLegacyDecision: unknown }>(view).pendingLegacyDecision)
                .toBeNull();
        }
    );

    it('rebuilds the preview when the legacy source changed while the modal was pending', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY_TWO);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        const loading = view.onLoadFile(f);
        await flush();
        const videos = view.videos;
        store.set(f.path, LEGACY_B);
        decision.resolve('read-only');
        await loading;
        await flush();

        expect(view.videos).not.toBe(videos);
        expect(view.videos[0].url).toContain('abcdefghijk');
        expect(view.videos).toHaveLength(1);
        expect(view.getViewData()).toBe(LEGACY_B);
        expect(vault.process).not.toHaveBeenCalled();
        expect(vault.modify).not.toHaveBeenCalled();
    });

    it('fails closed when the source becomes malformed while the modal was pending', async () => {
        const { store, vault, view, file, leaf } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY_TWO);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        const loading = view.onLoadFile(f);
        await flush();
        store.set(f.path, INVALID_LEGACY);
        decision.resolve('read-only');
        await loading;
        await flush();

        expect(view.getWriteMode()).toBe('blocked');
        expect(view.isWritable()).toBe(false);
        expect(store.get(f.path)).toBe(INVALID_LEGACY);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(unsafeCast<{ setViewState: ReturnType<typeof vi.fn> }>(leaf).setViewState)
            .toHaveBeenCalledWith(expect.objectContaining({ type: 'markdown' }));
    });

    it('does not install a stale legacy preview after a newer file wins during the re-read', async () => {
        const { store, vault, view, file } = makeFixture();
        const f = file('legacy.md');
        store.set(f.path, LEGACY_TWO);
        const decision = deferred<LegacyConversionDecision>();
        vi.mocked(promptLegacyConversionDecision).mockReturnValue(decision.promise);

        const loading = view.onLoadFile(f);
        await flush();
        expect(view.getWriteMode()).toBe('legacy-preview');

        const deferredRead = deferred<string>();
        vi.mocked(vault.cachedRead).mockImplementationOnce(() => deferredRead.promise);
        decision.resolve('read-only');
        await flush();

        const other = file('v2.md');
        store.set(other.path, V2);
        await view.onLoadFile(other);
        expect(view.getWriteMode()).toBe('editable-v2');

        deferredRead.resolve(LEGACY_TWO);
        await loading;
        await flush();
        const parsedV2 = parseYoutnoteDocument(V2);
        if (!parsedV2.ok) throw new Error('V2 fixture must parse');
        const expectedV2 = serializeYoutnoteDocument(parsedV2.document);
        expect(view.getWriteMode()).toBe('editable-v2');
        expect(view.file).toBe(other);
        expect(view.getViewData()).toBe(expectedV2);
        expect(vault.process).not.toHaveBeenCalled();
        expect(vault.modify).not.toHaveBeenCalled();
    });
});

describe('video selection provenance', () => {
    it('records an automatic request by default and a manual request when sourced', () => {
        const { view } = makeFixture();
        view.handleSetActiveVideoId('video-1' as VideoId);
        expect(view.videoSelectionRequest).toEqual({ id: 'video-1', source: 'automatic', sequence: 1 });
        expect(view.activeVideoId).toBe('video-1');

        view.handleSetActiveVideoId('video-2' as VideoId, 'manual');
        expect(view.videoSelectionRequest).toEqual({ id: 'video-2', source: 'manual', sequence: 2 });
        expect(view.activeVideoId).toBe('video-2');
    });

    it('records a new request on every call, even for the same id', () => {
        const { view } = makeFixture();
        view.handleSetActiveVideoId('video-1' as VideoId, 'manual');
        view.handleSetActiveVideoId('video-1' as VideoId);
        expect(view.videoSelectionRequest).toEqual({ id: 'video-1', source: 'automatic', sequence: 2 });
    });

    it('clears the recorded request when the view is cleared', () => {
        const { view } = makeFixture();
        view.handleSetActiveVideoId('video-1' as VideoId, 'manual');
        view.clear();
        expect(view.videoSelectionRequest).toBeNull();
    });
});
