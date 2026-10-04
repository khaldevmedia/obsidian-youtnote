import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import { ActiveVideoTaskRegistry } from './activeVideoTasks';
import type { VideoTaskTarget } from './activeVideoTasks';
import { AIProviderError } from './ai/types';
import type { AIGenerationDialogOptions, PluginSettings, TranscriptEntry, Video, VideoId } from './types';
import type YoutnotePlugin from './main';
import type { YoutnoteView } from './view';
import { fetchCaptionTracks } from './transcriptFetch';
import { AIGenerationProgressModal, showAISetupModal } from './ui/MessageBoxes';
import type { GeneratedNotesResult } from './ai/notes';

vi.mock('obsidian', () => {
    class FakeNotice {
        static calls: string[] = [];
        messageEl = { addClass: vi.fn() };
        constructor(message?: unknown) {
            FakeNotice.calls.push(String(message));
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
            singleExpandMode: true,
            persistExpandedState: false,
            newLineTrigger: 'shift+enter',
            openExportedFile: true,
            showNoteStats: true,
            switchToNotesAfterTranscriptNote: false,
            autoScrollTranscript: true,
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

    const makeView = () => {
        const file = unsafeCast<TFile>({ path: 'video.md', basename: 'video' });
        const video = unsafeCast<Video>({
            id: 'video-1' as VideoId,
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
            title: 'Video',
            transcript: TRANSCRIPT,
        });
        const view = unsafeCast<YoutnoteView>({ file, videos: [video] });
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

    it.each<['disabled' | 'none' | 'blank secret' | 'blank model' | 'bad base URL', string]>([
        ['disabled', 'AI integration is turned off'],
        ['none', 'No AI provider is configured'],
        ['blank secret', 'MISSING_KEY_MESSAGE'],
        ['blank model', 'No AI model is configured'],
        ['bad base URL', 'The custom AI base URL is not valid'],
    ])('shows the setup modal for %s and starts no work', (caseName, expectedMessage) => {
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
        expect(vi.mocked(showAISetupModal).mock.calls[0][1]).toContain(expectedMessage);
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
});
