import { Plugin, TFile, TFolder, ViewState, WorkspaceLeaf, addIcon, MarkdownView, Notice, requestUrl } from 'obsidian';
import { YoutnoteSettingTab, mergePluginSettings } from './settings';
import { YoutnoteView, VIEW_TYPE } from './view';
import { PluginSettings, PluginData, MarkdownEditorClass, Video, Note, VideoId, NoteId, TranscriptEntry } from './types';
import { createAIProvider } from './ai/registry';
import type { AIProviderFactoryConfig } from './ai/registry';
import { generateNotesFromTranscript } from './ai/notes';
import type { GeneratedNotesResult, GenerateNotesOptions } from './ai/notes';
import { AIProviderError } from './ai/types';
import type { AIProvider, ConfiguredAIProviderId } from './ai/types';
import { hasYoutnoteFrontmatter, extractYouTubeId, formatSecondsToDisplay, compareNotes } from './utils';
import { getMarkdownEditorClass } from './markdownEditor';
import { validateYoutnoteUriParams, isDebounced, getUnsupportedParams, ParsedYoutnoteUriParams } from './uri-scheme';
import './styles.css';

// Register custom icon
addIcon(
    'youtnote', `<svg width="100" height="100" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" version="1.1" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g transform="matrix(.56089 0 0 .56089 -36.616 -39.765)" fill="currentColor" stroke="none"><path d="m66.15 84.515 10.278 16.819v8.7213h5.2912v-8.7213l10.278-16.819h-6.311l-6.6122 10.82-6.6122-10.82z"/><path d="m94.186 84.515v17.13l-6.1466-6.3207-3.1559 5.1645 9.3025 9.566h5.2912v-25.54z"/><path d="m79.684 74.528c-1.0073 0-1.2989 0.97735-1.2873 1.8722h-0.67954c-2.0338 0-3.7052 1.6693-3.7052 3.7031v0.22428h-0.13074c-1.7856 0-3.2901 1.2884-3.6308 2.9791h2.2112c0.25656-0.51797 0.7859-0.86196 1.4196-0.86196h25.783c0.89778 0 1.5875 0.69024 1.5875 1.588v20.987c1.2478-0.59803 2.1172-1.8754 2.1172-3.3424v-0.22427h0.13126c2.0338 0 3.7031-1.6714 3.7031-3.7052v-17.644c0-2.0338-1.6693-3.7031-3.7031-3.7031h-14.541c-0.28984-0.81167-0.89855-1.8722-2.1017-1.8722zm-1.9668 3.9894h25.783c0.89778 0 1.5875 0.68817 1.5875 1.586v17.644c0 0.89778-0.68972 1.588-1.5875 1.588h-0.13126v-15.303c0-2.0338-1.6709-3.7052-3.7047-3.7052h-23.535v-0.22428c0-0.89778 0.69024-1.586 1.588-1.586z"/></g></svg>`);

type WorkspaceLeafWithId = WorkspaceLeaf & { id?: string };
type ViewStateWithFile = ViewState & { state?: { file?: string } };

const getFilePath = (state: unknown): string | undefined => {
    if (state && typeof state === 'object' && 'file' in state) {
        const file = (state as { file?: unknown }).file;
        if (typeof file === 'string') {
            return file;
        }
    }
    return undefined;
};

const getLeafKey = (leaf: WorkspaceLeafWithId, fallback?: string): string | undefined => {
    return leaf.id ?? fallback;
};

const asString = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;

/** Persistent notice for URI scheme errors, styled with Obsidian's error text color. */
const showUriSchemeError = (message: string): Notice => {
    const notice = new Notice(`Youtnote uri scheme error: ${message}`, 0);
    notice.messageEl.addClass('youtnote-plugin__notice-error');
    return notice;
};

export default class YoutnotePlugin extends Plugin {
    settings!: PluginSettings;
    MarkdownEditor: MarkdownEditorClass | null = null;
    // Track per-leaf view mode: leafId => 'markdown' | VIEW_TYPE
    // Allows users to manually switch to markdown and have that choice respected.
    youtnoteFileModes: Record<string, string> = {};
    private didFinishOnload = false;
    private lastUriSchemeInvocation = 0;
    private dataStateExtras: Record<string, unknown> = {};

    async onload() {
        await this.loadDataState();

        this.MarkdownEditor = getMarkdownEditorClass(this.app);

        this.registerView(VIEW_TYPE, (leaf) => new YoutnoteView(leaf, this));

        this.addCommand({
            id: 'create-file',
            name: 'Create new file',
            callback: async () => {
                const folder = this.app.workspace.getActiveFile()?.parent?.path || '';
                await this.createYoutnoteInFolder(folder);
            }
        });

        this.addCommand({
            id: 'open-as-view',
            name: 'Open as view',
            callback: () => {
                const activeLeaf = this.app.workspace.getLeaf(false);
                if (activeLeaf && activeLeaf.view.getViewType() === 'markdown') {
                    this.youtnoteFileModes[activeLeaf.id ?? (activeLeaf.view as MarkdownView).file?.path ?? ''] = VIEW_TYPE;
                    void this.setYoutnoteView(activeLeaf);
                }
            }
        });

        this.addSettingTab(new YoutnoteSettingTab(this.app, this));

        // Monkey-patch WorkspaceLeaf.prototype.setViewState to intercept markdown
        // view states for youtnote files and rewrite the type *before* Obsidian
        // processes it. This avoids a second setViewState call that would corrupt
        // the navigation history stack.
        this.register(
            this.monkeyPatchLeafSetViewState()
        );
        
        // Add option to file menu (the 3 dots menu)
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                void (async () => {
                    if (file instanceof TFile && file.extension === 'md') {
                        if (await this.isYoutnoteFile(file)) {
                            menu.addItem((item) => {
                                item.setTitle('Open as youtnote view')
                                    .setIcon('youtnote')
                                    .setSection('open')
                                    .onClick(() => {
                                        const leaves = this.app.workspace.getLeavesOfType('markdown');
                                        for (const leaf of leaves) {
                                            if ((leaf.view as MarkdownView).file?.path === file.path) {
                                                this.youtnoteFileModes[leaf.id ?? file.path] = VIEW_TYPE;
                                                void this.setYoutnoteView(leaf);
                                                return; // Only convert the first matching leaf
                                            }
                                        }
                                        // If not currently open in a markdown leaf, just open it
                                        const newLeaf = this.app.workspace.getLeaf(true);
                                        void newLeaf.setViewState({
                                            type: VIEW_TYPE,
                                            state: { file: file.path },
                                            active: true
                                        });
                                    });
                            });
                        }
                    } else if (file instanceof TFolder) {
                        menu.addItem((item) => {
                            item.setTitle('Create new youtnote')
                                .setIcon('youtnote')
                                .setSection('action-primary')
                                .onClick(() => {
                                    void this.createYoutnoteInFolder(file.path);
                                });
                        });
                    }
                })();
            })
        );
        
        // Add button to markdown view header for Youtnote files
        let pendingHeaderSync = false;
        let pendingHeaderSyncRaf: number | null = null;
        const syncMarkdownHeaderActions = () => {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (leaf.view.getViewType() === 'markdown') {
                    const markdownView = leaf.view as MarkdownView;
                    const file = markdownView.file;

                    const existingActionEl = markdownView.youtnoteActionEl;
                    const existingActionPath = markdownView.youtnoteActionFilePath;

                    if (!file || file.extension !== 'md') {
                        if (existingActionEl) {
                            existingActionEl.remove();
                            markdownView.youtnoteActionEl = null;
                            markdownView.youtnoteActionFilePath = null;
                        }
                        return;
                    }

                    const isYoutnote = this.isYoutnoteFileFromCache(file);

                    if (existingActionPath === file.path && existingActionEl?.isConnected) {
                        return;
                    }

                    if (existingActionEl) {
                        existingActionEl.remove();
                        markdownView.youtnoteActionEl = null;
                        markdownView.youtnoteActionFilePath = null;
                    }

                    if (isYoutnote) {
                        const actionEl = markdownView.addAction('youtnote', 'Open as youtnote view', () => {
                            this.youtnoteFileModes[leaf.id ?? file.path] = VIEW_TYPE;
                            void this.setYoutnoteView(leaf);
                        });
                        markdownView.youtnoteActionEl = actionEl;
                        markdownView.youtnoteActionFilePath = file.path;
                    }
                }
            });
        };

        const scheduleMarkdownHeaderSync = () => {
            if (pendingHeaderSync) return;
            pendingHeaderSync = true;
            pendingHeaderSyncRaf = window.requestAnimationFrame(() => {
                pendingHeaderSync = false;
                pendingHeaderSyncRaf = null;
                syncMarkdownHeaderActions();
            });
        };

        this.registerEvent(
            this.app.workspace.on('layout-change', scheduleMarkdownHeaderSync)
        );

        scheduleMarkdownHeaderSync();

        this.register(() => {
            if (pendingHeaderSyncRaf !== null) {
                activeWindow.cancelAnimationFrame(pendingHeaderSyncRaf);
                pendingHeaderSyncRaf = null;
                pendingHeaderSync = false;
            }
        });

        // Add a ribbon icon to easily create a new note
        this.addRibbonIcon('youtnote', 'Create new youtnote', () => {
            this.app.commands.executeCommandById(`${this.manifest.id}:create-file`);
        });

        // Register obsidian://youtnote URI scheme handler
        this.registerObsidianProtocolHandler('youtnote', (params) => {
            // Security gate: the URI scheme is disabled by default.
            // When disabled, no URI parameters are parsed or processed.
            if (!this.settings.uriSchemeEnabled) {
                new Notice('Youtnote uri scheme is disabled. Enable it in plugin settings to use this feature.', 0);
                return;
            }

            // params is a key-value object like { action: 'youtnote', url: '...', mode: '...' }

            // Check for unsupported params (security: reject, don't ignore)
            const unsupported = getUnsupportedParams(params);
            if (unsupported.length > 0) {
                showUriSchemeError(`Unsupported parameter(s): ${unsupported.join(', ')}. Allowed: url, mode, timestamp, text.`);
                return;
            }

            const url = asString(params.url);
            const mode = asString(params.mode);
            const timestamp = asString(params.timestamp);
            const text = asString(params.text);

            const parsed: ParsedYoutnoteUriParams = {
                url,
                mode,
                timestamp,
                text,
            };
            // Reconstruct URL length for the safeguard check
            const searchParams = new URLSearchParams();
            if (url) searchParams.set('url', url);
            if (mode) searchParams.set('mode', mode);
            if (timestamp) searchParams.set('timestamp', timestamp);
            if (text) searchParams.set('text', text);
            const fullUrlLength = `obsidian://youtnote?${searchParams.toString()}`.length;
            void this.handleYoutnoteUriScheme(parsed, fullUrlLength);
        });

        this.didFinishOnload = true;
    }

    onunload(): void {
        this.didFinishOnload = false;
    }

    async loadDataState() {
        const rawData = (await this.loadData() as Record<string, unknown> | null) ?? {};
        this.settings = mergePluginSettings(rawData.settings);
        const extras: Record<string, unknown> = {};
        for (const key of Object.keys(rawData)) {
            if (key !== 'settings') {
                extras[key] = rawData[key];
            }
        }
        this.dataStateExtras = extras;
    }

    private createConfiguredAIProvider(providerId: ConfiguredAIProviderId): AIProvider {
        const ai = this.settings.ai;
        const secretName = ai.secretNames[providerId].trim();
        const apiKey = secretName ? this.app.secretStorage.getSecret(secretName) : null;
        const timeoutSeconds = providerId === 'custom' ? ai.customTimeoutSeconds : ai.hostedTimeoutSeconds;
        const config: AIProviderFactoryConfig = {
            provider: providerId,
            apiKey,
            model: ai.models[providerId],
            timeoutMs: timeoutSeconds * 1000,
        };
        if (providerId === 'custom') {
            config.customBaseUrl = ai.customBaseUrl;
        }
        return createAIProvider(config);
    }

    openSettings = (): void => {
        const app = this.app as typeof this.app & {
            setting: {
                open(): void;
                openTabById(id: string): void;
            };
        };
        app.setting.open();
        app.setting.openTabById(this.manifest.id);
    };

    async listAIModels(provider: ConfiguredAIProviderId, signal?: AbortSignal): Promise<string[]> {
        return this.createConfiguredAIProvider(provider).listModels(signal);
    }

    async generateAINotes(transcript: TranscriptEntry[], options: GenerateNotesOptions): Promise<GeneratedNotesResult> {
        const ai = this.settings.ai;
        if (!ai.enabled) {
            throw new AIProviderError('invalid-config', 'AI-generated notes are disabled. Enable them in Youtnote settings.');
        }
        if (ai.provider === 'none') {
            throw new AIProviderError('invalid-config', 'No AI provider is configured. Select one in Youtnote settings.');
        }
        const provider = this.createConfiguredAIProvider(ai.provider);
        return generateNotesFromTranscript(provider, transcript, options);
    }

    async saveDataState() {
        const data: PluginData = {
            ...this.dataStateExtras,
            settings: this.settings,
        };
        await this.saveData(data);
    }

    private isYoutnoteFileFromCache(file: TFile): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        return cache?.frontmatter?.['youtnote'] === true;
    }

    // Create a new Youtnote file inside the given folder (use '' for vault root),
    // resolving name collisions with a numeric suffix, then open it in a new tab
    // in the Youtnote view. Shared by the create-file command and the folder
    // context-menu item.
    private async createYoutnoteInFolder(folderPath: string): Promise<void> {
        const baseFileName = 'Youtnote Untitled';
        let newFileName = `${baseFileName}.md`;
        let newFilePath = folderPath ? `${folderPath}/${newFileName}` : newFileName;

        // Add simple duplicate resolution
        let i = 1;
        while (await this.app.vault.adapter.exists(newFilePath)) {
            newFileName = `${baseFileName} ${i}.md`;
            newFilePath = folderPath ? `${folderPath}/${newFileName}` : newFileName;
            i++;
        }

        const initialContent = `---\nyoutnote: true\n---\n\n`;
        const newFile = await this.app.vault.create(newFilePath, initialContent);

        // Open the new file in a new tab directly in the Youtnote view
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(newFile);
        this.youtnoteFileModes[leaf.id ?? newFile.path] = VIEW_TYPE;
        await this.setYoutnoteView(leaf);
    }

    async isYoutnoteFile(file: TFile): Promise<boolean> {
        if (this.isYoutnoteFileFromCache(file)) {
            return true;
        }

        // Fallback: metadata cache can be delayed for newly created files.
        const content = await this.app.vault.cachedRead(file);
        return hasYoutnoteFrontmatter(content);
    }

    async setMarkdownView(leaf: WorkspaceLeaf) {
        await leaf.setViewState({
            type: 'markdown',
            state: leaf.view.getState(),
            popstate: true,
        } as ViewState);
    }

    async setYoutnoteView(leaf: WorkspaceLeaf) {
        await leaf.setViewState({
            type: VIEW_TYPE,
            state: leaf.view.getState(),
            popstate: true,
        } as ViewState);
    }

    monkeyPatchLeafSetViewState = (): (() => void) => {
        type LeafProto = {
            setViewState: (state: ViewState, eState?: Record<string, unknown>) => Promise<void>;
            detach: () => void;
        };
        const proto = WorkspaceLeaf.prototype as unknown as LeafProto;
        const originalSetViewState = proto.setViewState;
        const originalDetach = proto.detach;

        WorkspaceLeaf.prototype.setViewState = ((plugin: YoutnotePlugin) => {
            return function (this: WorkspaceLeafWithId, state: ViewStateWithFile, extraState?: Record<string, unknown>) {
                if (!plugin.didFinishOnload) {
                    return originalSetViewState.call(this, state, extraState);
                }

                const filePath = state.state?.file;
                const leafKey = filePath ? getLeafKey(this, filePath) : getLeafKey(this);

                if (
                    filePath &&
                    leafKey &&
                    state.type === 'markdown' &&
                    plugin.youtnoteFileModes[leafKey] !== 'markdown'
                ) {
                    const cache = plugin.app.metadataCache.getCache(filePath);
                    if (cache?.frontmatter?.youtnote === true) {
                        const newState: ViewState = { ...state, type: VIEW_TYPE };
                        plugin.youtnoteFileModes[leafKey] = VIEW_TYPE;
                        return originalSetViewState.call(this, newState, extraState);
                    }
                }

                return originalSetViewState.call(this, state, extraState);
            };
        })(this);

        WorkspaceLeaf.prototype.detach = ((plugin: YoutnotePlugin) => {
            return function (this: WorkspaceLeafWithId) {
                const filePath = getFilePath(this.view?.getState());
                const key = getLeafKey(this, filePath);
                if (key && plugin.youtnoteFileModes[key]) {
                    delete plugin.youtnoteFileModes[key];
                }
                return originalDetach.apply(this);
            };
        })(this);

        return () => {
            WorkspaceLeaf.prototype.setViewState = originalSetViewState;
            WorkspaceLeaf.prototype.detach = originalDetach;
        };
    };

    // Refresh all open Youtnote views (e.g., when settings change)
    refreshAllViews() {
        this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
            if (leaf.view instanceof YoutnoteView) {
                leaf.view.refresh();
            }
        });
    }

    // ─── URI scheme: reusable methods ───────────────────────────────────────

    /**
     * Fetch video metadata via YouTube's oEmbed endpoint.
     * Returns a Video object (without an ID — caller assigns one) or throws on failure.
     * Wrapped in a 10-second timeout to avoid hanging.
     */
    async fetchVideoMetadata(normalizedUrl: string): Promise<{ title: string; thumbnail: string; durationSec: number }> {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(normalizedUrl)}&format=json`;

        const timeoutPromise = new Promise<never>((_, reject) => {
            window.setTimeout(() => reject(new Error('oEmbed request timed out')), 10000);
        });

        const response = await Promise.race([
            requestUrl({ url: oembedUrl }),
            timeoutPromise,
        ]);

        if (response.status !== 200) {
            throw new Error('Video not found or unavailable');
        }

        interface OEmbedData { title?: string; thumbnail_url?: string; }
        const data = response.json as OEmbedData;
        const ytId = extractYouTubeId(normalizedUrl);

        return {
            title: data.title || `YouTube Video (${ytId ?? ''})`,
            thumbnail: data.thumbnail_url || `https://img.youtube.com/vi/${ytId ?? ''}/default.jpg`,
            durationSec: 0,
        };
    }

    /**
     * Create a new Youtnote file and open it in a new tab.
     * Reuses the same logic as the `create-file` command.
     * Returns the created file and the leaf it was opened in.
     */
    async createYoutnoteFile(): Promise<{ file: TFile; leaf: WorkspaceLeaf }> {
        const folder = this.app.workspace.getActiveFile()?.parent?.path || '';
        const baseFileName = 'Youtnote Untitled';
        let newFileName = `${baseFileName}.md`;
        let newFilePath = folder ? `${folder}/${newFileName}` : newFileName;

        let i = 1;
        while (await this.app.vault.adapter.exists(newFilePath)) {
            newFileName = `${baseFileName} ${i}.md`;
            newFilePath = folder ? `${folder}/${newFileName}` : newFileName;
            i++;
        }

        const initialContent = `---\nyoutnote: true\n---\n\n`;
        const newFile = await this.app.vault.create(newFilePath, initialContent);

        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(newFile);
        this.youtnoteFileModes[leaf.id ?? newFile.path] = VIEW_TYPE;
        await this.setYoutnoteView(leaf);

        return { file: newFile, leaf };
    }

    /**
     * Find the first open YoutnoteView leaf, or null if none is open.
     */
    getOpenYoutnoteView(): YoutnoteView | null {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        for (const leaf of leaves) {
            if (leaf.view instanceof YoutnoteView) {
                return leaf.view;
            }
        }
        return null;
    }

    /**
     * Add a video to a YoutnoteView. If the video already exists (by YouTube ID),
     * select it and return the existing video.
     */
    addVideoToView(view: YoutnoteView, normalizedUrl: string, metadata: { title: string; thumbnail: string; durationSec: number }): Video {
        const ytId = extractYouTubeId(normalizedUrl);

        // Check for duplicate
        const existingVideo = view.videos.find(v => extractYouTubeId(v.url) === ytId);
        if (existingVideo) {
            view.handleSetActiveVideoId(existingVideo.id);
            return existingVideo;
        }

        const newVideo: Video = {
            id: crypto.randomUUID() as VideoId,
            url: normalizedUrl,
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            durationSec: metadata.durationSec,
        };

        view.handleUpdateVideos([...view.videos, newVideo]);
        view.handleSetActiveVideoId(newVideo.id);

        return newVideo;
    }

    /**
     * Add a timestamped note to a specific video in a youtnoteView.
     */
    addNoteToView(view: YoutnoteView, videoId: VideoId, timestampSec: number, bodyMarkdown: string): Note {
        const newNote: Note = {
            id: crypto.randomUUID() as NoteId,
            videoId,
            timestampSec,
            bodyMarkdown,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const sortedNotes = [...view.notes, newNote].sort(compareNotes);

        view.handleUpdateNotes(sortedNotes);
        return newNote;
    }

    /**
     * Add a general note to a specific video in a youtnoteView.
     * Returns false if a general note already exists for that video.
     */
    addGeneralNoteToView(view: YoutnoteView, videoId: VideoId, bodyMarkdown: string): boolean {
        // Check if a general note already exists
        const hasGeneral = view.notes.some(n => n.videoId === videoId && (n.isGeneral === true || n.timestampSec === -1));
        if (hasGeneral) {
            return false;
        }

        const newNote: Note = {
            id: crypto.randomUUID() as NoteId,
            videoId,
            timestampSec: -1,
            bodyMarkdown,
            isGeneral: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const sortedNotes = [...view.notes, newNote].sort(compareNotes);

        view.handleUpdateNotes(sortedNotes);
        return true;
    }

    // ─── URI scheme: handler ────────────────────────────────────────────────

    /**
     * Main handler for obsidian://youtnote URLs.
     * Validates params, then dispatches to the appropriate mode logic.
     */
    private async handleYoutnoteUriScheme(parsed: ParsedYoutnoteUriParams, fullUrlLength: number): Promise<void> {
        // 8. Check debounce
        const now = Date.now();
        if (isDebounced(this.lastUriSchemeInvocation, now)) {
            return; // Silently ignore
        }
        this.lastUriSchemeInvocation = now;

        try {
            // 1-7. Validate (params already parsed by the protocol handler)
            const validated = validateYoutnoteUriParams(parsed, fullUrlLength);

            if (!validated.valid) {
                showUriSchemeError(validated.error ?? 'Invalid parameters.');
                return;
            }

            const { normalizedUrl, mode, timestampSec, text } = validated;

            switch (mode) {
                case 'new':
                    await this.handleUriSchemeNew(normalizedUrl!);
                    break;
                case 'append':
                    await this.handleUriSchemeAppend(normalizedUrl!);
                    break;
                case 'note':
                    await this.handleUriSchemeNote(normalizedUrl!, timestampSec!, text!);
                    break;
                case 'general-note':
                    await this.handleUriSchemeGeneralNote(normalizedUrl!, text!);
                    break;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            showUriSchemeError(message);
        }
    }

    /**
     * mode=new: Create a new Youtnote file with the video.
     */
    private async handleUriSchemeNew(normalizedUrl: string): Promise<void> {
        // 9. Fetch oEmbed metadata
        const metadata = await this.fetchVideoMetadata(normalizedUrl);

        // 10. Create file and add video
        const { leaf } = await this.createYoutnoteFile();
        const view = leaf.view;
        if (view instanceof YoutnoteView) {
            this.addVideoToView(view, normalizedUrl, metadata);
        }

        new Notice('Youtnote created with video.', 0);
    }

    /**
     * mode=append: Add the video to the currently open Youtnote, or fall back to mode=new.
     */
    private async handleUriSchemeAppend(normalizedUrl: string): Promise<void> {
        const view = this.getOpenYoutnoteView();

        if (!view) {
            // No open Youtnote — fall back to mode=new
            await this.handleUriSchemeNew(normalizedUrl);
            return;
        }

        // Check for duplicate before fetching metadata
        const ytId = extractYouTubeId(normalizedUrl);
        const existingVideo = view.videos.find(v => extractYouTubeId(v.url) === ytId);
        if (existingVideo) {
            view.handleSetActiveVideoId(existingVideo.id);
            new Notice('Video already exists in this youtnote.', 0);
            return;
        }

        // 9. Fetch oEmbed metadata
        const metadata = await this.fetchVideoMetadata(normalizedUrl);

        // 10. Add video
        this.addVideoToView(view, normalizedUrl, metadata);
        new Notice('Video added to youtnote.', 0);
    }

    /**
     * mode=note: Add a timestamped note to a specific video in the open Youtnote.
     * If the video doesn't exist, auto-add it first.
     * If no Youtnote is open, fall back to mode=new.
     *
     * The timestamp is validated against the video's actual duration before the
     * note is added. If the duration is not yet known (durationSec === 0), the
     * target video is selected as active to trigger the player to load it, then
     * we wait for the duration to be populated. If the duration can't be
     * determined (player fails or times out), the note is rejected rather than
     * accepted with an unvalidated timestamp.
     */
    private async handleUriSchemeNote(normalizedUrl: string, timestampSec: number, text: string): Promise<void> {
        const view = this.getOpenYoutnoteView();

        let targetView: YoutnoteView;
        let videoId: VideoId;

        if (!view) {
            // No open Youtnote — fall back to mode=new
            const metadata = await this.fetchVideoMetadata(normalizedUrl);
            const { leaf } = await this.createYoutnoteFile();
            const newView = leaf.view;
            if (!(newView instanceof YoutnoteView)) {
                showUriSchemeError('Failed to open new youtnote view.');
                return;
            }
            targetView = newView;
            const video = this.addVideoToView(targetView, normalizedUrl, metadata);
            videoId = video.id;
        } else {
            targetView = view;
            const ytId = extractYouTubeId(normalizedUrl);
            const existingVideo = targetView.videos.find(v => extractYouTubeId(v.url) === ytId);

            if (existingVideo) {
                videoId = existingVideo.id;
            } else {
                // Auto-add the video first
                const metadata = await this.fetchVideoMetadata(normalizedUrl);
                const video = this.addVideoToView(targetView, normalizedUrl, metadata);
                videoId = video.id;
            }
        }

        // Select the target video so the player loads it (populates durationSec)
        // and so the user sees the note appear once added.
        targetView.handleSetActiveVideoId(videoId);

        // Validate the timestamp against the video's actual duration.
        const durationSec = await this.waitForVideoDuration(targetView, videoId);
        if (durationSec === null) {
            showUriSchemeError('Could not determine video duration. The video may be private, embedding-blocked, or the player failed to load. Open the video in a youtnote and try again.');
            return;
        }
        if (timestampSec > durationSec) {
            showUriSchemeError(`Timestamp ${formatSecondsToDisplay(timestampSec, 0)} exceeds video duration (max: ${formatSecondsToDisplay(durationSec)}).`);
            return;
        }

        // Add the note
        this.addNoteToView(targetView, videoId, timestampSec, text);
        new Notice('Note added to video.', 0);
    }

    /**
     * Polls the view's videos array until the target video's `durationSec`
     * becomes positive, or the timeout elapses.
     *
     * Selecting a video as active triggers the player to load it, which fires
     * `handleDurationUpdate` in `YoutnoteView.tsx` and updates `durationSec`.
     * This method waits for that update.
     *
     * Returns the duration in seconds, or `null` if the duration could not be
     * determined within the timeout.
     */
    private async waitForVideoDuration(view: YoutnoteView, videoId: VideoId, timeoutMs = 10000): Promise<number | null> {
        // Fast path: duration already known (video was played before)
        const existing = view.videos.find(v => v.id === videoId);
        if (existing && (existing.durationSec ?? 0) > 0) {
            return existing.durationSec ?? 0;
        }

        // Poll until the player populates durationSec
        const intervalMs = 200;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await new Promise(resolve => window.setTimeout(resolve, intervalMs));
            const current = view.videos.find(v => v.id === videoId);
            if (current && (current.durationSec ?? 0) > 0) {
                return current.durationSec ?? 0;
            }
        }
        return null;
    }

    /**
     * mode=general-note: Add a general note to a specific video in the open Youtnote.
     * If the video doesn't exist, auto-add it first.
     * If no Youtnote is open, fall back to mode=new.
     */
    private async handleUriSchemeGeneralNote(normalizedUrl: string, text: string): Promise<void> {
        const view = this.getOpenYoutnoteView();

        let targetView: YoutnoteView;
        let videoId: VideoId;

        if (!view) {
            // No open Youtnote — fall back to mode=new
            const metadata = await this.fetchVideoMetadata(normalizedUrl);
            const { leaf } = await this.createYoutnoteFile();
            const newView = leaf.view;
            if (!(newView instanceof YoutnoteView)) {
                showUriSchemeError('Failed to open new youtnote view.');
                return;
            }
            targetView = newView;
            const video = this.addVideoToView(targetView, normalizedUrl, metadata);
            videoId = video.id;
        } else {
            targetView = view;
            const ytId = extractYouTubeId(normalizedUrl);
            const existingVideo = targetView.videos.find(v => extractYouTubeId(v.url) === ytId);

            if (existingVideo) {
                videoId = existingVideo.id;
            } else {
                // Auto-add the video first
                const metadata = await this.fetchVideoMetadata(normalizedUrl);
                const video = this.addVideoToView(targetView, normalizedUrl, metadata);
                videoId = video.id;
            }
        }

        // Select the target video so the user sees the general note appear
        targetView.handleSetActiveVideoId(videoId);

        // Add the general note
        const added = this.addGeneralNoteToView(targetView, videoId, text);
        if (added) {
            new Notice('General note added to video.', 0);
        } else {
            new Notice('A general note already exists for this video.', 0);
        }
    }
}