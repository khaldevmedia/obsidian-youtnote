import { Plugin, TFile, ViewState, WorkspaceLeaf, addIcon, MarkdownView } from 'obsidian';
import { DEFAULT_SETTINGS, YoutnoteSettingTab } from './settings';
import { YoutnoteView, VIEW_TYPE } from './view';
import { PluginSettings, PluginData, MarkdownEditorClass } from './types';
import { hasYoutnoteFrontmatter } from './utils';
import { getMarkdownEditorClass } from './markdownEditor';
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
            if (activeWindow.YT && typeof activeWindow.YT.Player === 'function') {
                return;
            }

            const existingScript =activeDocument.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR)
                ||activeDocument.querySelector<HTMLScriptElement>(`script[src="${YT_IFRAME_API_SRC}"]`);
            if (existingScript) {
                return;
            }

            const script = createEl('script');
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

           activeDocument.body.appendChild(script);
        };

        const ensureYouTubeAPIPromise = () => {
            if (!activeWindow.youtubeAPIPromise) {
                activeWindow.youtubeAPIPromise = new Promise<void>((resolve) => {
                    if (activeWindow.YT && typeof activeWindow.YT.Player === 'function') {
                        resolve();
                        return;
                    }

                    activeWindow.onYouTubeIframeAPIReady = () => {
                        console.debug('[youtnoteAPIPromise] IFrame API ready');
                        resolve();
                    };
                });
            }
            return activeWindow.youtubeAPIPromise;
        };

        void ensureYouTubeAPIPromise();
        ensureYouTubeIframeAPILoaded();

        const handleOnline = () => {
            if (!activeWindow.YT || typeof activeWindow.YT.Player !== 'function') {
                ensureYouTubeIframeAPILoaded();
            }
        };

        activeWindow.addEventListener('online', handleOnline);
        this.register(() => {
            activeWindow.removeEventListener('online', handleOnline);
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
                                item.setTitle('Open as youtnote view')
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