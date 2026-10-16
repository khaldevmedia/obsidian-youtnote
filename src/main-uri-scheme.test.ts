/**
 * Tests the URI handlers in main.ts: notice styling and persistence, duplicate
 * handling, and target-view selection. Unlike uri-scheme.test.ts, which tests
 * parameter validation, these tests mock Obsidian to exercise plugin behavior
 * without launching the app. Assertions avoid message wording for i18n safety;
 * actual theme colors still require manual verification.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import type YoutnotePlugin from './main';
import { YoutnoteView, VIEW_TYPE } from './view';
import type { Note, Video, VideoId } from './types';

interface NoticeRecord {
    message: string;
    timeout: number | undefined;
    classes: string[];
}

const noticeRecords: NoticeRecord[] = [];

vi.mock('obsidian', () => {
    class FakeNotice {
        messageEl = {
            addClass: (cls: string): void => {
                noticeRecords[noticeRecords.length - 1]?.classes.push(cls);
            },
        };
        constructor(message?: unknown, timeout?: number) {
            noticeRecords.push({ message: String(message), timeout, classes: [] });
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

vi.mock('./ui/MessageBoxes', () => ({
    AIGenerationProgressModal: class {},
    MISSING_AI_API_KEY_MESSAGE: 'MISSING_KEY_MESSAGE',
    showAISetupModal: vi.fn(),
}));

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

const YT_URL = 'https://www.youtube.com/watch?v=abcdefghijk';

interface UriSchemeInternals {
    handleUriSchemeAppend(normalizedUrl: string): Promise<void>;
    handleUriSchemeGeneralNote(normalizedUrl: string, text: string): Promise<void>;
    fetchVideoMetadata(normalizedUrl: string): Promise<{ title: string; thumbnail: string; durationSec: number }>;
}

describe('YoutnotePlugin URI scheme notices', () => {
    let YoutnotePluginClass: typeof YoutnotePlugin;

    beforeAll(async () => {
        YoutnotePluginClass = (await import('./main')).default;
    });

    beforeEach(() => {
        noticeRecords.length = 0;
    });

    const makeVideo = (): Video => unsafeCast<Video>({
        id: 'video-1' as VideoId,
        url: YT_URL,
        title: 'Video',
    });

    const makeView = (options: { writable?: boolean; videos?: Video[]; notes?: Note[] } = {}) => {
        const writable = options.writable ?? true;
        return Object.assign(Object.create(YoutnoteView.prototype) as YoutnoteView, {
            file: unsafeCast<TFile>({ path: 'video.md', basename: 'video' }),
            videos: options.videos ?? [],
            notes: options.notes ?? [],
            isWritable: () => writable,
            getMutationGuard: () => () => writable,
            handleSetActiveVideoId: vi.fn(),
            handleUpdateNotes: vi.fn(),
        });
    };

    const makePlugin = (leaves: { view: unknown }[], activeLeaf?: { view: unknown }) => {
        const app = unsafeCast<App>({
            vault: {},
            workspace: {
                getLeavesOfType: vi.fn((type: string) =>
                    type === VIEW_TYPE ? leaves.map(l => unsafeCast<WorkspaceLeaf>(l)) : []),
                activeLeaf: activeLeaf ? unsafeCast<WorkspaceLeaf>(activeLeaf) : null,
            },
        });
        const plugin = new YoutnotePluginClass(app, unsafeCast({ id: 'youtnote' }));
        return { plugin, internals: unsafeCast<UriSchemeInternals>(plugin) };
    };

    describe('duplicate append', () => {
        it('shows a persistent warning notice and selects the existing video on a writable view', async () => {
            const video = makeVideo();
            const view = makeView({ videos: [video] });
            const { plugin, internals } = makePlugin([{ view }]);
            const fetchSpy = vi.spyOn(internals, 'fetchVideoMetadata');
            const addSpy = vi.spyOn(plugin, 'addVideoToView');

            await internals.handleUriSchemeAppend(YT_URL);

            expect(noticeRecords).toHaveLength(1);
            expect(noticeRecords[0].timeout).toBe(0);
            expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-warning']);
            expect(view.handleSetActiveVideoId).toHaveBeenCalledWith(video.id);
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(addSpy).not.toHaveBeenCalled();
        });

        it('still warns (not error) on a read-only view because the duplicate check runs first', async () => {
            const video = makeVideo();
            const view = makeView({ writable: false, videos: [video] });
            const { internals } = makePlugin([{ view }]);
            const fetchSpy = vi.spyOn(internals, 'fetchVideoMetadata');

            await internals.handleUriSchemeAppend(YT_URL);

            expect(noticeRecords).toHaveLength(1);
            expect(noticeRecords[0].timeout).toBe(0);
            expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-warning']);
            expect(view.handleSetActiveVideoId).toHaveBeenCalledWith(video.id);
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    describe('duplicate general note', () => {
        it('shows a persistent warning and leaves notes untouched', async () => {
            const video = makeVideo();
            const generalNote = unsafeCast<Note>({
                id: 'note-1',
                videoId: video.id,
                timestampSec: -1,
                bodyMarkdown: 'existing',
                isGeneral: true,
                createdAt: 'x',
                updatedAt: 'x',
            });
            const view = makeView({ videos: [video], notes: [generalNote] });
            const { internals } = makePlugin([{ view }]);
            const fetchSpy = vi.spyOn(internals, 'fetchVideoMetadata');

            await internals.handleUriSchemeGeneralNote(YT_URL, 'new text');

            expect(noticeRecords).toHaveLength(1);
            expect(noticeRecords[0].timeout).toBe(0);
            expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-warning']);
            expect(view.handleUpdateNotes).not.toHaveBeenCalled();
            expect(view.handleSetActiveVideoId).toHaveBeenCalledWith(video.id);
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    describe('success notices stay unstyled', () => {
        it('append success shows a persistent notice without warning or error class', async () => {
            const view = makeView();
            const { plugin, internals } = makePlugin([{ view }]);
            vi.spyOn(internals, 'fetchVideoMetadata').mockResolvedValue({
                title: 'T', thumbnail: 'thumb', durationSec: 60,
            });
            const addedVideo = makeVideo();
            vi.spyOn(plugin, 'addVideoToView').mockReturnValue(addedVideo);

            await internals.handleUriSchemeAppend(YT_URL);

            expect(noticeRecords).toHaveLength(1);
            expect(noticeRecords[0].timeout).toBe(0);
            expect(noticeRecords[0].classes).toEqual([]);
        });

        it('general-note success shows a persistent notice without warning or error class', async () => {
            const video = makeVideo();
            const view = makeView({ videos: [video] });
            const { internals } = makePlugin([{ view }]);
            const fetchSpy = vi.spyOn(internals, 'fetchVideoMetadata');

            await internals.handleUriSchemeGeneralNote(YT_URL, 'general text');

            expect(noticeRecords).toHaveLength(1);
            expect(noticeRecords[0].timeout).toBe(0);
            expect(noticeRecords[0].classes).toEqual([]);
            expect(view.handleUpdateNotes).toHaveBeenCalledTimes(1);
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    describe('read-only errors stay errors', () => {
        it('append on a read-only view with a non-duplicate video shows an error, not a warning', async () => {
            const view = makeView({ writable: false });
            const { internals } = makePlugin([{ view }]);
            const fetchSpy = vi.spyOn(internals, 'fetchVideoMetadata');

            await internals.handleUriSchemeAppend(YT_URL);

            expect(noticeRecords).toHaveLength(1);
            expect(noticeRecords[0].timeout).toBe(0);
            expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-error']);
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    describe('getOpenYoutnoteView', () => {
        it('returns the first YoutnoteView leaf, not a later active one or one containing the video', () => {
            const first = makeView();
            const second = makeView({ videos: [makeVideo()] });
            const secondLeaf = { view: second };
            const { plugin } = makePlugin([{ view: first }, secondLeaf], secondLeaf);

            expect(plugin.getOpenYoutnoteView()).toBe(first);
        });

        it('skips leaves whose view is not a YoutnoteView', () => {
            const target = makeView();
            const { plugin } = makePlugin([{ view: {} }, { view: target }]);

            expect(plugin.getOpenYoutnoteView()).toBe(target);
        });

        it('returns null when no Youtnote view is open', () => {
            const { plugin } = makePlugin([{ view: {} }]);

            expect(plugin.getOpenYoutnoteView()).toBeNull();
        });
    });
});
