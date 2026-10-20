import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Notice } from 'obsidian';
import type { TFile } from 'obsidian';
import { ActiveVideoTaskRegistry } from './activeVideoTasks';
import type { VideoTaskTarget } from './activeVideoTasks';
import { AIProviderError } from './ai/types';
import { getAIErrorPresentation } from './ai/errorPresentation';
import { getAINoteGenerationSetupError } from './ai/registry';
import type { AIGenerationDialogOptions, PluginSettings, TranscriptEntry, Video, VideoId } from './types';
import type YoutnotePlugin from './main';
import { YoutnoteView } from './view';
import { fetchCaptionTracks } from './transcriptFetch';
import { updateYoutnoteSource } from './videoTaskResults';
import { AIGenerationProgressModal, showAISetupModal } from './ui/MessageBoxes';
import type { GeneratedNotesResult } from './ai/notes';

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
    class FakePlugin {
        app: unknown;
        manifest: unknown;
        constructor(app: unknown, manifest: unknown) {
            this.app = app;
            this.manifest = manifest;
        }
    }
    return {
        Plugin: FakePlugin,
        Notice: FakeNotice,
        App: class {},
        Component: class {},
        TFile: class {},
        TFolder: class {},
        ViewState: class {},
        WorkspaceLeaf: class {},
        MarkdownView: class {},
        addIcon: vi.fn(),
        requestUrl: vi.fn(),
    };
});

vi.mock('./view', () => ({
    YoutnoteView: class {},
    VIEW_TYPE: 'youtnote',
}));

vi.mock('./settings', () => ({
    YoutnoteSettingTab: class {},
    mergePluginSettings: vi.fn((raw: unknown) => raw ?? {}),
}));

vi.mock('./markdownEditor', () => ({
    getMarkdownEditorClass: vi.fn(() => null),
}));

vi.mock('./ui/MessageBoxes', () => {
    class FakeProgressModal {
        static instances: FakeProgressModal[] = [];
        opened = false;
        finished = false;
        phase: unknown;
        constructor(_app: unknown, phase: unknown, _onCancel: unknown) {
            this.phase = phase;
            FakeProgressModal.instances.push(this);
        }
        open(): void {
            this.opened = true;
        }
        setPhase(phase: unknown): void {
            this.phase = phase;
        }
        finish(): void {
            this.finished = true;
        }
    }
    return {
        AIGenerationProgressModal: FakeProgressModal,
        MISSING_AI_API_KEY_MESSAGE: 'MISSING_KEY_MESSAGE',
        showAISetupModal: vi.fn(),
    };
});

vi.mock('./ui/CaptionTrackModal', () => ({
    pickCaptionTrack: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('./transcriptFetch', () => ({
    fetchCaptionTracks: vi.fn(() => Promise.resolve([])),
    fetchTranscriptEntries: vi.fn(() => Promise.resolve([])),
}));

vi.mock('./videoTaskResults', () => ({
    applyGeneratedNotesForYoutubeVideo: vi.fn(() => null),
    setTranscriptForYoutubeVideo: vi.fn(() => null),
    updateYoutnoteSource: vi.fn(() => ({ status: 'missing-target' })),
}));

function unsafeCast<T>(value: unknown): T {
    return value as T;
}

const fileA = unsafeCast<TFile>({ path: 'a.md' });
const fileB = unsafeCast<TFile>({ path: 'b.md' });

function targetFor(file: TFile, youtubeId = 'yt-1', videoTitle = 'Video'): VideoTaskTarget {
    return { file, youtubeId, videoTitle };
}

describe('ActiveVideoTaskRegistry', () => {
    it('rejects a duplicate task of the same kind and target', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const first = registry.start('transcript', target, 'fetching-tracks');
        const second = registry.start('transcript', target, 'fetching-tracks');
        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    it('lets transcript and ai tasks coexist for one target', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const transcript = registry.start('transcript', target, 'fetching-tracks');
        const ai = registry.start('ai', target, 'generating-notes');
        expect(transcript).not.toBeNull();
        expect(ai).not.toBeNull();
        expect(ai!.id).not.toBe(transcript!.id);
        const state = registry.getVideoState(fileA, 'yt-1');
        expect(state.transcriptPhase).toBe('fetching-tracks');
        expect(state.aiPhase).toBe('generating-notes');
    });

    it('treats the same YouTube ID in different file objects as independent targets', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const first = registry.start('transcript', targetFor(fileA, 'yt-1'), 'fetching-tracks');
        const second = registry.start('transcript', targetFor(fileB, 'yt-1'), 'fetching-tracks');
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        registry.cancelFile(fileA);
        expect(registry.getVideoState(fileA, 'yt-1').transcriptPhase).toBeNull();
        expect(registry.getVideoState(fileB, 'yt-1').transcriptPhase).toBe('fetching-tracks');
    });

    it('requires strict file identity for state and deduplication', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const otherA = unsafeCast<TFile>({ path: 'a.md' });
        registry.start('transcript', targetFor(fileA, 'yt-1'), 'fetching-tracks');
        expect(registry.start('transcript', targetFor(otherA, 'yt-1'), 'fetching-tracks')).not.toBeNull();
        expect(registry.getVideoState(otherA, 'yt-1').transcriptPhase).toBe('fetching-tracks');
    });

    it('updates phases and reports them through getVideoState', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const handle = registry.start('transcript', targetFor(fileA), 'fetching-tracks');
        expect(handle).not.toBeNull();
        expect(registry.update(handle!.id, 'choosing-track')).toBe(true);
        expect(registry.getVideoState(fileA, 'yt-1').transcriptPhase).toBe('choosing-track');
        expect(registry.update(handle!.id, 'fetching-captions')).toBe(true);
        expect(registry.getVideoState(fileA, 'yt-1').transcriptPhase).toBe('fetching-captions');
    });

    it('completes tasks and clears their state', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const handle = registry.start('ai', targetFor(fileA), 'generating-notes');
        expect(handle).not.toBeNull();
        expect(registry.isActive(handle!.id)).toBe(true);
        expect(registry.complete(handle!.id)).toBe(true);
        expect(registry.isActive(handle!.id)).toBe(false);
        expect(registry.getVideoState(fileA, 'yt-1').aiPhase).toBeNull();
        expect(registry.complete(handle!.id)).toBe(false);
    });

    it('cancels a single kind for a target and aborts its signal', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const transcript = registry.start('transcript', target, 'fetching-tracks');
        const ai = registry.start('ai', target, 'generating-notes');
        expect(registry.cancelTarget(fileA, 'yt-1', 'transcript')).toBe(true);
        expect(transcript!.signal.aborted).toBe(true);
        expect(ai!.signal.aborted).toBe(false);
        const state = registry.getVideoState(fileA, 'yt-1');
        expect(state.transcriptPhase).toBeNull();
        expect(state.aiPhase).toBe('generating-notes');
    });

    it('cancels every kind for a target when no kind is given', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const transcript = registry.start('transcript', target, 'fetching-tracks');
        const ai = registry.start('ai', target, 'generating-notes');
        expect(registry.cancelTarget(fileA, 'yt-1')).toBe(true);
        expect(transcript!.signal.aborted).toBe(true);
        expect(ai!.signal.aborted).toBe(true);
        const state = registry.getVideoState(fileA, 'yt-1');
        expect(state.transcriptPhase).toBeNull();
        expect(state.aiPhase).toBeNull();
    });

    it('cancels all tasks for a file', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const a1 = registry.start('transcript', targetFor(fileA, 'yt-1'), 'fetching-tracks');
        const a2 = registry.start('ai', targetFor(fileA, 'yt-2'), 'generating-notes');
        const b1 = registry.start('transcript', targetFor(fileB, 'yt-1'), 'fetching-tracks');
        expect(registry.cancelFile(fileA)).toBe(true);
        expect(a1!.signal.aborted).toBe(true);
        expect(a2!.signal.aborted).toBe(true);
        expect(b1!.signal.aborted).toBe(false);
        expect(registry.getVideoState(fileB, 'yt-1').transcriptPhase).toBe('fetching-tracks');
    });

    it('cancels all tasks and aborts all signals', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const first = registry.start('transcript', targetFor(fileA, 'yt-1'), 'fetching-tracks');
        const second = registry.start('ai', targetFor(fileB, 'yt-2'), 'generating-notes');
        expect(registry.cancelAll()).toBe(true);
        expect(first!.signal.aborted).toBe(true);
        expect(second!.signal.aborted).toBe(true);
        expect(registry.isActive(first!.id)).toBe(false);
        expect(registry.isActive(second!.id)).toBe(false);
        expect(registry.cancelAll()).toBe(false);
    });

    it('makes late update and complete calls harmless after cancellation', () => {
        const onChange = vi.fn();
        const registry = new ActiveVideoTaskRegistry(onChange);
        const handle = registry.start('transcript', targetFor(fileA), 'fetching-tracks');
        expect(handle).not.toBeNull();
        onChange.mockClear();
        expect(registry.cancelTarget(fileA, 'yt-1')).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);
        onChange.mockClear();
        expect(registry.update(handle!.id, 'fetching-captions')).toBe(false);
        expect(registry.complete(handle!.id)).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('does not call onChange for no-op calls', () => {
        const onChange = vi.fn();
        const registry = new ActiveVideoTaskRegistry(onChange);
        expect(registry.cancelTarget(fileA, 'yt-1')).toBe(false);
        expect(registry.cancelFile(fileA)).toBe(false);
        expect(registry.cancelAll()).toBe(false);
        expect(registry.update(999, 'fetching-captions')).toBe(false);
        expect(registry.complete(999)).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('allows a new task of the same kind after the previous one completed', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const first = registry.start('transcript', target, 'fetching-tracks');
        registry.complete(first!.id);
        const second = registry.start('transcript', target, 'fetching-tracks');
        expect(second).not.toBeNull();
        expect(second!.id).not.toBe(first!.id);
    });
});

describe('YoutnotePlugin AI task workflow', () => {
    let YoutnotePluginClass: typeof YoutnotePlugin;

    beforeAll(async () => {
        YoutnotePluginClass = (await import('./main')).default;
    });

    const DIALOG_OPTIONS: AIGenerationDialogOptions = {
        customInstructions: '',
        includeGeneralNote: true,
        generalNoteMode: 'replace',
        mode: 'replace',
    };

    const TRANSCRIPT: TranscriptEntry[] = [
        { startMs: 0, text: 'Welcome' },
        { startMs: 10_000, text: 'First topic' },
    ];

    const makeApp = (secret: string | null = null) => ({
        secretStorage: { getSecret: vi.fn((_name: string) => secret) },
        vault: { process: vi.fn() },
        workspace: {},
    });

    const makePlugin = (mutateAi?: (ai: PluginSettings['ai']) => void, secret: string | null = null) => {
        const app = makeApp(secret);
        const plugin = new YoutnotePluginClass(app as never, { id: 'youtnote' } as never);
        plugin.settings = {
            pinOnPhone: false,
            autoplayOnNoteSelect: false,
            autoplayOnCaptionSelect: false,
            singleExpandMode: true,
            persistExpandedState: false,
            newLineTrigger: 'shift+enter',
            openExportedFile: true,
            showNoteStats: true,
            switchToNotesAfterTranscriptNote: false,
            autoScrollTranscript: true,
            rememberPlaybackPosition: false,
            exportIncludeNotes: true,
            exportIncludeTranscripts: true,
            uriSchemeEnabled: false,
            ai: {
                enabled: true,
                provider: 'openai',
                secretNames: { openai: 's1', anthropic: '', google: '', custom: '' },
                models: { openai: 'gpt-4o', anthropic: '', google: '', custom: '' },
                availableModels: { openai: [], anthropic: [], google: [], custom: [] },
                customBaseUrl: '',
                hostedTimeoutSeconds: 120,
                customTimeoutSeconds: 300,
            },
        };
        mutateAi?.(plugin.settings.ai);
        return plugin;
    };

    const makeView = (writable = true) => {
        const file = unsafeCast<TFile>({ path: 'video.md', basename: 'video' });
        const video = unsafeCast<Video>({
            id: 'video-1' as VideoId,
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
            title: 'Video',
            transcript: TRANSCRIPT,
        });
        const view = unsafeCast<YoutnoteView>({
            file,
            videos: [video],
            notes: [],
            isWritable: () => writable,
            getMutationGuard: () => () => writable,
            handleSetActiveVideoId: vi.fn(),
        });
        return { file, video, view };
    };

    interface TaskFixture {
        plugin: YoutnotePlugin;
        target: VideoTaskTarget;
        handle: NonNullable<ReturnType<ActiveVideoTaskRegistry['start']>>;
        resolved: { target: VideoTaskTarget; video: Video };
        internals: Record<string, unknown>;
    }

    const makeTaskFixture = (mutateAi?: (ai: PluginSettings['ai']) => void): TaskFixture => {
        const plugin = makePlugin(mutateAi);
        const { file, video } = makeView();
        const target: VideoTaskTarget = { file, youtubeId: 'abcdefghijk', videoTitle: 'Video' };
        const internals = unsafeCast<Record<string, unknown>>(plugin);
        const registry = internals.activeVideoTasks as ActiveVideoTaskRegistry;
        const handle = registry.start('ai', target, 'generating-notes');
        expect(handle).not.toBeNull();
        return { plugin, target, handle: handle!, resolved: { target, video }, internals };
    };

    const invokeRunAITask = (
        fixture: TaskFixture,
        dialogOptions: AIGenerationDialogOptions = DIALOG_OPTIONS,
    ): Promise<void> =>
        unsafeCast<{
            runAITask(
                handle: TaskFixture['handle'],
                resolved: TaskFixture['resolved'],
                transcript: TranscriptEntry[],
                options: AIGenerationDialogOptions,
            ): Promise<void>;
        }>(fixture.plugin).runAITask(fixture.handle, fixture.resolved, TRANSCRIPT, dialogOptions);

    const generatedResult = (): GeneratedNotesResult => ({
        notes: [{ timestampSec: 10, bodyMarkdown: 'A note.' }],
        noteMarkdown: '[00:10](timestamp)\nA note.\n',
        response: { content: '' },
        corrected: false,
        format: 'structured',
    });

    it.each(['disabled', 'none', 'blank secret', 'blank model', 'bad base URL'] as const)(
        'shows the setup modal for %s and starts no work', (caseName) => {
            vi.mocked(showAISetupModal).mockClear();
            vi.mocked(fetchCaptionTracks).mockClear();
            const plugin = makePlugin(ai => {
                if (caseName === 'disabled') {
                    ai.enabled = false;
                } else if (caseName === 'none') {
                    ai.provider = 'none';
                } else if (caseName === 'blank secret') {
                    ai.secretNames.openai = '  ';
                } else if (caseName === 'blank model') {
                    ai.models.openai = ' ';
                } else if (caseName === 'bad base URL') {
                    ai.provider = 'custom';
                    ai.models.custom = 'llama';
                    ai.customBaseUrl = 'not a url';
                }
            }, caseName === 'blank model' ? 'sk-test' : null);
            const runAITask = vi.fn(() => Promise.resolve());
            const generateAINotes = vi.fn();
            const internals = unsafeCast<Record<string, unknown>>(plugin);
            internals.runAITask = runAITask;
            plugin.generateAINotes = generateAINotes;
            const progressModals = unsafeCast<{ instances: { opened: boolean }[] }>(AIGenerationProgressModal).instances;
            const progressBefore = progressModals.length;
            const { file, video, view } = makeView();
            plugin.startAINoteGeneration(view, video.id, DIALOG_OPTIONS);
            expect(vi.mocked(showAISetupModal)).toHaveBeenCalledTimes(1);
            const call = vi.mocked(showAISetupModal).mock.calls[0];
            expect(call[0]).toBe(plugin.app);
            expect(call[2]).toBe(plugin.openSettings);
            const setupError = getAINoteGenerationSetupError(
                plugin.settings.ai,
                name => unsafeCast<{ secretStorage: { getSecret(n: string): string | null } }>(plugin.app)
                    .secretStorage.getSecret(name),
            );
            expect(setupError).not.toBeNull();
            if (setupError!.kind === 'missing-key') {
                expect(call[1]).toBe('MISSING_KEY_MESSAGE');
            } else {
                expect(call[1]).toBe(setupError!.message);
            }
            expect(runAITask).not.toHaveBeenCalled();
            expect(generateAINotes).not.toHaveBeenCalled();
            expect(fetchCaptionTracks).not.toHaveBeenCalled();
            expect(progressModals.length).toBe(progressBefore);
            expect((unsafeCast<Record<string, unknown>>(plugin).activeVideoTasks as ActiveVideoTaskRegistry)
                .getVideoState(file, 'abcdefghijk')).toEqual({ transcriptPhase: null, aiPhase: null });
        });

    it('shows the missing-key message when the hosted secret resolves empty', () => {
        vi.mocked(showAISetupModal).mockClear();
        const plugin = makePlugin();
        const runAITask = vi.fn(() => Promise.resolve());
        unsafeCast<Record<string, unknown>>(plugin).runAITask = runAITask;
        const { video, view } = makeView();
        plugin.startAINoteGeneration(view, video.id, DIALOG_OPTIONS);
        expect(vi.mocked(showAISetupModal)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(showAISetupModal).mock.calls[0][1]).toBe('MISSING_KEY_MESSAGE');
        expect(runAITask).not.toHaveBeenCalled();
    });

    it('proceeds with a valid keyless custom provider', () => {
        vi.mocked(showAISetupModal).mockClear();
        const plugin = makePlugin(ai => {
            ai.provider = 'custom';
            ai.models.custom = 'llama';
            ai.customBaseUrl = 'http://localhost:11434/v1';
        });
        const runAITask = vi.fn(() => Promise.resolve());
        unsafeCast<Record<string, unknown>>(plugin).runAITask = runAITask;
        const { file, video, view } = makeView();
        plugin.startAINoteGeneration(view, video.id, DIALOG_OPTIONS);
        expect(vi.mocked(showAISetupModal)).not.toHaveBeenCalled();
        expect(runAITask).toHaveBeenCalledTimes(1);
        expect((unsafeCast<Record<string, unknown>>(plugin).activeVideoTasks as ActiveVideoTaskRegistry)
            .getVideoState(file, 'abcdefghijk').aiPhase).toBe('generating-notes');
    });

    it('does not refetch an existing transcript and passes modes through to persistence', async () => {
        const fixture = makeTaskFixture();
        const fetchTranscriptForTask = vi.fn(() => Promise.resolve(null));
        const persistGeneratedNotesResult = vi.fn((..._args: unknown[]) => Promise.resolve(true));
        const result = generatedResult();
        const generateAINotes = vi.fn(() => Promise.resolve(result));
        fixture.internals.fetchTranscriptForTask = fetchTranscriptForTask;
        fixture.internals.persistGeneratedNotesResult = persistGeneratedNotesResult;
        fixture.plugin.generateAINotes = generateAINotes;
        await invokeRunAITask(fixture, {
            customInstructions: '',
            includeGeneralNote: true,
            generalNoteMode: 'append',
            mode: 'append',
        });
        expect(fetchTranscriptForTask).not.toHaveBeenCalled();
        expect(generateAINotes).toHaveBeenCalledTimes(1);
        expect(persistGeneratedNotesResult).toHaveBeenCalledTimes(1);
        const persistCall = persistGeneratedNotesResult.mock.calls[0];
        expect(persistCall[0]).toBe(fixture.handle);
        expect(persistCall[1]).toBe(fixture.target);
        expect(persistCall[2]).toBe(result.notes);
        expect(persistCall[3]).toEqual({ mode: 'append', generalNoteMode: 'append' });
    });

    it.each(['truncated', 'refused', 'blocked'] as const)(
        'never persists %s generation failures',
        async (kind) => {
            const fixture = makeTaskFixture();
            const persistGeneratedNotesResult = vi.fn((..._args: unknown[]) => Promise.resolve(true));
            fixture.internals.persistGeneratedNotesResult = persistGeneratedNotesResult;
            fixture.plugin.generateAINotes = vi.fn(() => Promise.reject(new AIProviderError(kind, 'boom')));
            await invokeRunAITask(fixture);
            expect(persistGeneratedNotesResult).not.toHaveBeenCalled();
        },
    );

    it('never persists a successful result when the task was cancelled mid-generation', async () => {
        const fixture = makeTaskFixture();
        const persistGeneratedNotesResult = vi.fn((..._args: unknown[]) => Promise.resolve(true));
        const registry = fixture.internals.activeVideoTasks as ActiveVideoTaskRegistry;
        fixture.internals.persistGeneratedNotesResult = persistGeneratedNotesResult;
        fixture.plugin.generateAINotes = vi.fn(() => {
            registry.cancelTarget(fixture.target.file, fixture.target.youtubeId, 'ai');
            return Promise.resolve(generatedResult());
        });
        await invokeRunAITask(fixture);
        expect(persistGeneratedNotesResult).not.toHaveBeenCalled();
    });

    interface NoticeRecordSnapshot {
        message: string;
        timeout: number | undefined;
        classes: string[];
    }

    const noticeRecords = (): NoticeRecordSnapshot[] =>
        unsafeCast<{ records: NoticeRecordSnapshot[] }>(Notice).records;

    const noticesSince = (start: number): NoticeRecordSnapshot[] => noticeRecords().slice(start);

    it('shows a persistent warning notice when the provider is overloaded', async () => {
        const fixture = makeTaskFixture();
        const persistGeneratedNotesResult = vi.fn((..._args: unknown[]) => Promise.resolve(true));
        fixture.internals.persistGeneratedNotesResult = persistGeneratedNotesResult;
        const failure = new AIProviderError('provider', 'Service overloaded', 503, 'UNAVAILABLE');
        fixture.plugin.generateAINotes = vi.fn(() => Promise.reject(failure));
        const before = noticeRecords().length;
        await invokeRunAITask(fixture);
        expect(persistGeneratedNotesResult).not.toHaveBeenCalled();
        const notices = noticesSince(before);
        expect(notices).toHaveLength(1);
        expect(notices[0].timeout).toBe(0);
        expect(notices[0].classes).toEqual(['youtnote-plugin__notice-warning']);
        expect(notices[0].message).toContain(fixture.target.videoTitle);
        expect(notices[0].message).toContain(fixture.target.file.basename);
        expect(notices[0].message).toContain('Service overloaded');
        expect(notices[0].message).toContain(getAIErrorPresentation(failure).guidance);
    });

    it('shows a persistent error notice for a provider bad request', async () => {
        const fixture = makeTaskFixture();
        const persistGeneratedNotesResult = vi.fn((..._args: unknown[]) => Promise.resolve(true));
        fixture.internals.persistGeneratedNotesResult = persistGeneratedNotesResult;
        const failure = new AIProviderError('provider', 'Invalid schema', 400, 'INVALID_ARGUMENT');
        fixture.plugin.generateAINotes = vi.fn(() => Promise.reject(failure));
        const before = noticeRecords().length;
        await invokeRunAITask(fixture);
        expect(persistGeneratedNotesResult).not.toHaveBeenCalled();
        const notices = noticesSince(before);
        expect(notices).toHaveLength(1);
        expect(notices[0].timeout).toBe(0);
        expect(notices[0].classes).toEqual(['youtnote-plugin__notice-error']);
        expect(notices[0].message).toContain(fixture.target.videoTitle);
        expect(notices[0].message).toContain('Invalid schema');
        const guidance = getAIErrorPresentation(failure).guidance;
        if (guidance) expect(notices[0].message).toContain(guidance);
    });

    it('shows a persistent warning notice for an AI timeout with the timeout advice', async () => {
        const fixture = makeTaskFixture();
        const persistGeneratedNotesResult = vi.fn((..._args: unknown[]) => Promise.resolve(true));
        fixture.internals.persistGeneratedNotesResult = persistGeneratedNotesResult;
        const failure = new AIProviderError('timeout', 'timed out after 1 ms');
        fixture.plugin.generateAINotes = vi.fn(() => Promise.reject(failure));
        const before = noticeRecords().length;
        await invokeRunAITask(fixture);
        expect(persistGeneratedNotesResult).not.toHaveBeenCalled();
        const notices = noticesSince(before);
        expect(notices).toHaveLength(1);
        expect(notices[0].timeout).toBe(0);
        expect(notices[0].classes).toEqual(['youtnote-plugin__notice-warning']);
        expect(notices[0].message).toContain(fixture.target.videoTitle);
        expect(notices[0].message).toContain('timed out after 1 ms');
        expect(notices[0].message).toContain(getAIErrorPresentation(failure).guidance);
    });

    it('shows a default normal notice on a structured success', async () => {
        const fixture = makeTaskFixture();
        fixture.internals.persistGeneratedNotesResult = vi.fn(() => Promise.resolve(true));
        fixture.plugin.generateAINotes = vi.fn(() => Promise.resolve(generatedResult()));
        const before = noticeRecords().length;
        await invokeRunAITask(fixture);
        const notices = noticesSince(before);
        expect(notices).toHaveLength(1);
        expect(notices[0].timeout).toBe(3000);
        expect(notices[0].classes).toEqual([]);
        expect(notices[0].message).toContain(fixture.target.videoTitle);
        expect(notices[0].message).toContain(fixture.target.file.basename);
    });

    it('shows a persistent warning notice on an unstructured (compatibility mode) success', async () => {
        const fixture = makeTaskFixture();
        fixture.internals.persistGeneratedNotesResult = vi.fn(() => Promise.resolve(true));
        fixture.plugin.generateAINotes = vi.fn(() => Promise.resolve({
            ...generatedResult(),
            corrected: true,
            format: 'unstructured',
        } as GeneratedNotesResult));
        const before = noticeRecords().length;
        await invokeRunAITask(fixture);
        const notices = noticesSince(before);
        expect(notices).toHaveLength(1);
        expect(notices[0].timeout).toBe(0);
        expect(notices[0].classes).toEqual(['youtnote-plugin__notice-warning']);
        expect(notices[0].message).toContain(fixture.target.videoTitle);
        expect(notices[0].message).toContain(fixture.target.file.basename);
    });

    it('shows no notice when the task fails as cancelled', async () => {
        const fixture = makeTaskFixture();
        fixture.internals.persistGeneratedNotesResult = vi.fn(() => Promise.resolve(true));
        fixture.plugin.generateAINotes = vi.fn(() =>
            Promise.reject(new AIProviderError('cancelled', 'The request was cancelled.')));
        const before = noticeRecords().length;
        await invokeRunAITask(fixture);
        expect(noticesSince(before)).toHaveLength(0);
    });

    it('opens the setup modal instead of a notice on a missing key', async () => {
        vi.mocked(showAISetupModal).mockClear();
        const fixture = makeTaskFixture();
        fixture.internals.persistGeneratedNotesResult = vi.fn(() => Promise.resolve(true));
        fixture.plugin.generateAINotes = vi.fn(() =>
            Promise.reject(new AIProviderError('missing-key', 'OpenAI API key is not configured.')));
        const before = noticeRecords().length;
        await invokeRunAITask(fixture);
        expect(vi.mocked(showAISetupModal)).toHaveBeenCalledTimes(1);
        expect(noticesSince(before)).toHaveLength(0);
    });

    it('rejects transcript fetch and AI generation on a read-only view before any task starts', () => {
        vi.mocked(showAISetupModal).mockClear();
        vi.mocked(fetchCaptionTracks).mockClear();
        const noticesBefore = noticeRecords().length;
        const plugin = makePlugin(ai => {
            ai.provider = 'custom';
            ai.models.custom = 'llama';
            ai.customBaseUrl = 'http://localhost:11434/v1';
        });
        const internals = unsafeCast<Record<string, unknown>>(plugin);
        const runAITask = vi.fn(() => Promise.resolve());
        const runTranscriptTask = vi.fn(() => Promise.resolve());
        internals.runAITask = runAITask;
        internals.runTranscriptTask = runTranscriptTask;
        const { file, video, view } = makeView(false);
        plugin.startTranscriptFetch(view, video.id);
        plugin.startAINoteGeneration(view, video.id, DIALOG_OPTIONS);
        expect(runTranscriptTask).not.toHaveBeenCalled();
        expect(runAITask).not.toHaveBeenCalled();
        expect(fetchCaptionTracks).not.toHaveBeenCalled();
        expect(vi.mocked(showAISetupModal)).not.toHaveBeenCalled();
        const registry = internals.activeVideoTasks as ActiveVideoTaskRegistry;
        expect(registry.getVideoState(file, 'abcdefghijk')).toEqual({ transcriptPhase: null, aiPhase: null });
        const records = noticesSince(noticesBefore);
        expect(records).toHaveLength(2);
        expect(records.every(r => r.classes.includes('youtnote-plugin__notice-error'))).toBe(true);
    });

    const makeOpenLeafView = (plugin: YoutnotePlugin, file: TFile, writable: boolean | (() => boolean)) => {
        const isWritable = typeof writable === 'function' ? writable : () => writable;
        const handleUpdateVideos = vi.fn();
        const handleUpdateNotes = vi.fn();
        const handleSetActiveVideoId = vi.fn();
        const save = vi.fn(() => Promise.resolve());
        const view = unsafeCast<YoutnoteView>(Object.assign(
            Object.create(unsafeCast<{ prototype: object }>(YoutnoteView).prototype),
            {
                file,
                videos: [unsafeCast<Video>({
                    id: 'video-1' as VideoId,
                    url: 'https://www.youtube.com/watch?v=abcdefghijk',
                    title: 'Video',
                    transcript: TRANSCRIPT,
                    durationSec: 120,
                })],
                notes: [],
                isWritable,
                getMutationGuard: () => {
                    const owned = view.file;
                    return () => isWritable() && view.file === owned;
                },
                handleUpdateVideos,
                handleUpdateNotes,
                handleSetActiveVideoId,
                save,
            },
        ));
        unsafeCast<Record<string, unknown>>(plugin.app).workspace = {
            getLeavesOfType: vi.fn(() => [{ view }]),
        };
        return { view, handleUpdateVideos, handleUpdateNotes, handleSetActiveVideoId, save };
    };

    it('discards a completed transcript when the open view is no longer writable', async () => {
        const fixture = makeTaskFixture();
        const noticesBefore = noticeRecords().length;
        const { handleUpdateVideos, save } = makeOpenLeafView(fixture.plugin, fixture.target.file, false);
        const persist = unsafeCast<{
            persistTranscriptResult(handle: unknown, target: unknown, entries: TranscriptEntry[]): Promise<boolean>;
        }>(fixture.plugin);
        const result = await persist.persistTranscriptResult(fixture.handle, fixture.target, TRANSCRIPT);
        expect(result).toBe(false);
        expect(handleUpdateVideos).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        const records = noticesSince(noticesBefore);
        expect(records).toHaveLength(1);
        expect(records[0].timeout).toBe(0);
        expect(records[0].classes).toEqual(['youtnote-plugin__notice-error']);
    });

    it('discards completed generated notes when the open view is no longer writable', async () => {
        const fixture = makeTaskFixture();
        const recordsBefore = noticeRecords().length;
        const { handleUpdateNotes, save } = makeOpenLeafView(fixture.plugin, fixture.target.file, false);
        const persist = unsafeCast<{
            persistGeneratedNotesResult(
                handle: unknown,
                target: unknown,
                drafts: unknown[],
                options: unknown,
            ): Promise<boolean>;
        }>(fixture.plugin);
        const result = await persist.persistGeneratedNotesResult(
            fixture.handle,
            fixture.target,
            generatedResult().notes,
            { mode: 'append', generalNoteMode: 'append' },
        );
        expect(result).toBe(false);
        expect(handleUpdateNotes).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        const records = noticesSince(recordsBefore);
        expect(records).toHaveLength(1);
        expect(records[0].timeout).toBe(0);
        expect(records[0].classes).toEqual(['youtnote-plugin__notice-error']);
        expect(records[0].message).toContain(fixture.target.videoTitle);
    });

    it('discards completed generated notes with a persistent error when the file is incompatible', async () => {
        const fixture = makeTaskFixture();
        unsafeCast<Record<string, unknown>>(fixture.plugin.app).workspace = {
            getLeavesOfType: vi.fn(() => []),
        };
        unsafeCast<{ vault: { process: unknown } }>(fixture.plugin.app).vault.process =
            vi.fn((_file: unknown, cb: (data: string) => string) => {
                cb('markdown');
                return Promise.resolve();
            });
        vi.mocked(updateYoutnoteSource).mockReturnValueOnce({ status: 'incompatible', message: 'bad format', reason: 'invalid-document' });
        const recordsBefore = noticeRecords().length;
        const persist = unsafeCast<{
            persistGeneratedNotesResult(
                handle: unknown,
                target: unknown,
                drafts: unknown[],
                options: unknown,
            ): Promise<boolean>;
        }>(fixture.plugin);
        const result = await persist.persistGeneratedNotesResult(
            fixture.handle,
            fixture.target,
            generatedResult().notes,
            { mode: 'append', generalNoteMode: 'append' },
        );
        expect(result).toBe(false);
        const records = noticesSince(recordsBefore);
        expect(records).toHaveLength(1);
        expect(records[0].timeout).toBe(0);
        expect(records[0].classes).toEqual(['youtnote-plugin__notice-error']);
        expect(records[0].message).toContain('bad format');
        expect(records[0].message).toContain(fixture.target.videoTitle);
    });

    it('discards completed generated notes with a persistent warning when the target is missing', async () => {
        const fixture = makeTaskFixture();
        unsafeCast<Record<string, unknown>>(fixture.plugin.app).workspace = {
            getLeavesOfType: vi.fn(() => []),
        };
        unsafeCast<{ vault: { process: unknown } }>(fixture.plugin.app).vault.process =
            vi.fn((_file: unknown, cb: (data: string) => string) => {
                cb('markdown');
                return Promise.resolve();
            });
        const recordsBefore = noticeRecords().length;
        const persist = unsafeCast<{
            persistGeneratedNotesResult(
                handle: unknown,
                target: unknown,
                drafts: unknown[],
                options: unknown,
            ): Promise<boolean>;
        }>(fixture.plugin);
        const result = await persist.persistGeneratedNotesResult(
            fixture.handle,
            fixture.target,
            generatedResult().notes,
            { mode: 'append', generalNoteMode: 'append' },
        );
        expect(result).toBe(false);
        const records = noticesSince(recordsBefore);
        expect(records).toHaveLength(1);
        expect(records[0].timeout).toBe(0);
        expect(records[0].classes).toEqual(['youtnote-plugin__notice-warning']);
        expect(records[0].message).toContain(fixture.target.videoTitle);
    });

    it('reports a persist as unsuccessful when the view turns read-only during the save', async () => {
        const fixture = makeTaskFixture();
        let writable = true;
        const { save } = makeOpenLeafView(fixture.plugin, fixture.target.file, () => writable);
        save.mockImplementation(() => {
            writable = false;
            return Promise.resolve();
        });
        const persist = unsafeCast<{
            persistTranscriptResult(handle: unknown, target: unknown, entries: TranscriptEntry[]): Promise<boolean>;
        }>(fixture.plugin);
        const result = await persist.persistTranscriptResult(fixture.handle, fixture.target, TRANSCRIPT);
        expect(result).toBe(false);
    });

    it('rejects a URI append on a read-only view before fetching metadata', async () => {
        const fixture = makeTaskFixture();
        const { handleUpdateVideos } = makeOpenLeafView(fixture.plugin, fixture.target.file, false);
        const fetchVideoMetadata = vi.fn(() =>
            Promise.resolve({ title: 't', thumbnail: 't', durationSec: 60 }));
        fixture.internals.fetchVideoMetadata = fetchVideoMetadata;
        const noticesBefore = noticeRecords().length;
        await unsafeCast<{ handleUriSchemeAppend(url: string): Promise<void> }>(fixture.plugin)
            .handleUriSchemeAppend('https://www.youtube.com/watch?v=bbbbbbbbbbb');
        expect(fetchVideoMetadata).not.toHaveBeenCalled();
        expect(handleUpdateVideos).not.toHaveBeenCalled();
        const records = noticesSince(noticesBefore);
        expect(records).toHaveLength(1);
        expect(records[0].classes).toEqual(['youtnote-plugin__notice-error']);
    });

    it('rejects a URI append when the target becomes read-only during the metadata fetch', async () => {
        const fixture = makeTaskFixture();
        let writable = true;
        const { handleUpdateVideos } = makeOpenLeafView(fixture.plugin, fixture.target.file, () => writable);
        let resolveMetadata: ((value: { title: string; thumbnail: string; durationSec: number }) => void) | null = null;
        fixture.internals.fetchVideoMetadata = vi.fn(() =>
            new Promise<{ title: string; thumbnail: string; durationSec: number }>(resolve => {
                resolveMetadata = resolve;
            }));
        const noticesBefore = noticeRecords().length;
        const pending = unsafeCast<{ handleUriSchemeAppend(url: string): Promise<void> }>(fixture.plugin)
            .handleUriSchemeAppend('https://www.youtube.com/watch?v=bbbbbbbbbbb');
        await Promise.resolve();
        writable = false;
        resolveMetadata!({ title: 't', thumbnail: 't', durationSec: 60 });
        await pending;
        expect(handleUpdateVideos).not.toHaveBeenCalled();
        const records = noticesSince(noticesBefore);
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(r => r.classes.includes('youtnote-plugin__notice-error'))).toBe(true);
    });

    it('rejects a URI note on an existing target when the view file switches during the duration wait', async () => {
        const fixture = makeTaskFixture();
        const { view, handleUpdateNotes } = makeOpenLeafView(fixture.plugin, fixture.target.file, true);
        const otherFile = unsafeCast<TFile>({ path: 'other.md' });
        const noticesBefore = noticeRecords().length;
        const pending = unsafeCast<{
            handleUriSchemeNote(url: string, timestampSec: number, text: string): Promise<void>;
        }>(fixture.plugin).handleUriSchemeNote('https://www.youtube.com/watch?v=abcdefghijk', 5, 'body');
        unsafeCast<Record<string, unknown>>(view).file = otherFile;
        await pending;
        expect(handleUpdateNotes).not.toHaveBeenCalled();
        const records = noticesSince(noticesBefore);
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(r => r.classes.includes('youtnote-plugin__notice-error'))).toBe(true);
    });

    it('rejects a URI note on a newly created target when the view file switches during the duration wait', async () => {
        const fixture = makeTaskFixture();
        const plugin = fixture.plugin;
        unsafeCast<Record<string, unknown>>(plugin.app).workspace = {
            getLeavesOfType: vi.fn(() => []),
        };
        const newFile = unsafeCast<TFile>({ path: 'new.md' });
        const isWritable = () => true;
        const handleUpdateNotes = vi.fn();
        const handleUpdateVideos = vi.fn();
        const newView = unsafeCast<YoutnoteView>(Object.assign(
            Object.create(unsafeCast<{ prototype: object }>(YoutnoteView).prototype),
            {
                file: newFile,
                videos: [],
                notes: [],
                isWritable,
                getMutationGuard: () => {
                    const owned = newView.file;
                    return () => isWritable() && newView.file === owned;
                },
                handleUpdateVideos,
                handleUpdateNotes,
                handleSetActiveVideoId: vi.fn(),
                save: vi.fn(() => Promise.resolve()),
            },
        ));
        fixture.internals.fetchVideoMetadata = vi.fn(() =>
            Promise.resolve({ title: 't', thumbnail: 't', durationSec: 60 }));
        fixture.internals.createYoutnoteFile = vi.fn(() =>
            Promise.resolve({ leaf: { view: newView }, file: newFile }));
        let resolveDuration: ((value: number) => void) | null = null;
        fixture.internals.waitForVideoDuration = vi.fn(() =>
            new Promise<number>(resolve => { resolveDuration = resolve; }));
        const noticesBefore = noticeRecords().length;
        const pending = unsafeCast<{
            handleUriSchemeNote(url: string, timestampSec: number, text: string): Promise<void>;
        }>(plugin).handleUriSchemeNote('https://www.youtube.com/watch?v=bbbbbbbbbbb', 5, 'body');
        for (let i = 0; i < 20; i++) await Promise.resolve();
        unsafeCast<Record<string, unknown>>(newView).file = unsafeCast<TFile>({ path: 'other.md' });
        resolveDuration!(120);
        await pending;
        expect(handleUpdateNotes).not.toHaveBeenCalled();
        const records = noticesSince(noticesBefore);
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(r => r.classes.includes('youtnote-plugin__notice-error'))).toBe(true);
    });

    it('rejects a URI video auto-add when the view file switches during the metadata fetch', async () => {
        const fixture = makeTaskFixture();
        const { view, handleUpdateVideos } = makeOpenLeafView(fixture.plugin, fixture.target.file, true);
        let resolveMetadata: ((value: { title: string; thumbnail: string; durationSec: number }) => void) | null = null;
        fixture.internals.fetchVideoMetadata = vi.fn(() =>
            new Promise<{ title: string; thumbnail: string; durationSec: number }>(resolve => {
                resolveMetadata = resolve;
            }));
        const noticesBefore = noticeRecords().length;
        const pending = unsafeCast<{
            handleUriSchemeNote(url: string, timestampSec: number, text: string): Promise<void>;
        }>(fixture.plugin).handleUriSchemeNote('https://www.youtube.com/watch?v=bbbbbbbbbbb', 5, 'body');
        await Promise.resolve();
        unsafeCast<Record<string, unknown>>(view).file = unsafeCast<TFile>({ path: 'other.md' });
        resolveMetadata!({ title: 't', thumbnail: 't', durationSec: 60 });
        await pending;
        expect(handleUpdateVideos).not.toHaveBeenCalled();
        const records = noticesSince(noticesBefore);
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(r => r.classes.includes('youtnote-plugin__notice-error'))).toBe(true);
    });

    it.each(['addVideoToView', 'addNoteToView', 'addGeneralNoteToView'] as const)(
        'direct helper %s performs no mutation on a read-only view',
        (helper) => {
            const fixture = makeTaskFixture();
            const { view, handleUpdateVideos, handleUpdateNotes } = makeOpenLeafView(
                fixture.plugin,
                fixture.target.file,
                false,
            );
            const noticesBefore = noticeRecords().length;
            const helpers = unsafeCast<Record<string, (...args: unknown[]) => unknown>>(fixture.plugin);
            const result = helper === 'addVideoToView'
                ? helpers.addVideoToView(view, 'https://www.youtube.com/watch?v=bbbbbbbbbbb', { title: 't', thumbnail: 't', durationSec: 1 })
                : helper === 'addNoteToView'
                    ? helpers.addNoteToView(view, 'video-1', 5, 'body')
                    : helpers.addGeneralNoteToView(view, 'video-1', 'body');
            expect(result).toBeFalsy();
            expect(handleUpdateVideos).not.toHaveBeenCalled();
            expect(handleUpdateNotes).not.toHaveBeenCalled();
            const records = noticesSince(noticesBefore);
            expect(records).toHaveLength(1);
            expect(records[0].classes).toEqual(['youtnote-plugin__notice-error']);
        },
    );
});
