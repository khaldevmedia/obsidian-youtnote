import { Plugin, TFile, ViewState, WorkspaceLeaf, addIcon, MarkdownView } from 'obsidian';
import { DEFAULT_SETTINGS, YoutnoteSettingTab } from './settings';
import { YoutnoteView, VIEW_TYPE } from './view';
import { PluginSettings, PluginData } from './types';
import { hasYoutnoteFrontmatter } from './utils';
import { getMarkdownEditorClass, MarkdownEditorClass } from './markdownEditor';
import './styles.css';

// Register custom icon
addIcon(
    'youtnote', `<svg width="100" height="100" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" version="1.1" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="4.1837" y="2.44" width="18.083" height="19.12" rx="3.8512" ry="3.8512" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9999" style="paint-order:fill markers stroke"/><path d="m10.877 15.591 5.8606-3.5905-5.8606-3.5905z" fill="currentColor" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9999"/><g stroke-width="2"><path d="m1.7871 17.966h4.2104"/><path d="m1.5894 13.989h4.2104"/><path d="m1.6552 10.012h4.2104"/><path d="m1.7212 6.0346h4.2104"/></g></svg>`);

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

export default class YoutnotePlugin extends Plugin {
    settings!: PluginSettings;
    MarkdownEditor: MarkdownEditorClass | null = null;
    // Track per-leaf view mode: leafId => 'markdown' | VIEW_TYPE
    // Allows users to manually switch to markdown and have that choice respected.
    youtnoteFileModes: Record<string, string> = {};
    private didFinishOnload = false;

    async onload() {
        await this.loadDataState();

        this.MarkdownEditor = getMarkdownEditorClass(this.app);

        this.registerView(VIEW_TYPE, (leaf) => new YoutnoteView(leaf, this));

        this.addCommand({
            id: 'create-file',
            name: 'Create new file',
            callback: async () => {
                const folder = this.app.workspace.getActiveFile()?.parent?.path || '';
                const baseFileName = 'Youtnote Untitled';
                let newFileName = `${baseFileName}.md`;
                let newFilePath = folder ? `${folder}/${newFileName}` : newFileName;
                
                // Add simple duplicate resolution
                let i = 1;
                while (await this.app.vault.adapter.exists(newFilePath)) {
                    newFileName = `${baseFileName} ${i}.md`;
                    newFilePath = folder ? `${folder}/${newFileName}` : newFileName;
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

        const YT_IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';
        const SCRIPT_SELECTOR = 'script[data-youtnote-iframe-api]';
        let pendingScriptRetry: number | null = null;

        const clearPendingScriptRetry = () => {
            if (pendingScriptRetry !== null) {
                window.clearTimeout(pendingScriptRetry);
                pendingScriptRetry = null;
            }
        };

        const ensureYouTubeIframeAPILoaded = () => {
            if (window.YT && typeof window.YT.Player === 'function') {
                return;
            }

            const existingScript = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR)
                || document.querySelector<HTMLScriptElement>(`script[src="${YT_IFRAME_API_SRC}"]`);
            if (existingScript) {
                return;
            }

            const script = document.createElement('script');
            script.src = YT_IFRAME_API_SRC;
            script.async = true;
            script.dataset.youtnoteIframeApi = 'true';
            script.onerror = () => {
                console.error('[youtnoteAPIPromise] Failed to load YouTube IFrame API script');
                script.remove();

                if (navigator.onLine && pendingScriptRetry === null) {
                    pendingScriptRetry = window.setTimeout(() => {
                        pendingScriptRetry = null;
                        ensureYouTubeIframeAPILoaded();
                    }, 5000);
                }
            };

            document.body.appendChild(script);
        };

        const ensureYouTubeAPIPromise = () => {
            if (!window.youtubeAPIPromise) {
                window.youtubeAPIPromise = new Promise<void>((resolve) => {
                    if (window.YT && typeof window.YT.Player === 'function') {
                        resolve();
                        return;
                    }

                    window.onYouTubeIframeAPIReady = () => {
                        console.debug('[youtnoteAPIPromise] IFrame API ready');
                        resolve();
                    };
                });
            }
            return window.youtubeAPIPromise;
        };

        void ensureYouTubeAPIPromise();
        ensureYouTubeIframeAPILoaded();

        const handleOnline = () => {
            if (!window.YT || typeof window.YT.Player !== 'function') {
                ensureYouTubeIframeAPILoaded();
            }
        };

        window.addEventListener('online', handleOnline);
        this.register(() => {
            window.removeEventListener('online', handleOnline);
            clearPendingScriptRetry();
        });
        
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
                                // eslint-disable-next-line obsidianmd/ui/sentence-case -- Justification: Youtnote is a brand name
                                item.setTitle('Open as Youtnote view')
                                    .setIcon('youtnote')
                                    .setSection('pane')
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
                        const actionEl = markdownView.addAction('youtnote', 'Open as Youtnote view', () => {
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
                window.cancelAnimationFrame(pendingHeaderSyncRaf);
                pendingHeaderSyncRaf = null;
                pendingHeaderSync = false;
            }
        });

        // Add a ribbon icon to easily create a new note
        this.addRibbonIcon('youtnote', 'Create new youtnote', () => {
            this.app.commands.executeCommandById(`${this.manifest.id}:create-file`);
        });

        this.didFinishOnload = true;
    }

    onunload(): void {
        this.didFinishOnload = false;
    }

    async loadDataState() {
        const data: PluginData = (await this.loadData() as PluginData | null) ?? ({} as PluginData);
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    }

    async saveDataState() {
        const data: PluginData = {
            settings: this.settings,
        };
        await this.saveData(data);
    }

    private isYoutnoteFileFromCache(file: TFile): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        return cache?.frontmatter?.['youtnote'] === true;
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
}