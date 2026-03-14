import { TextFileView, WorkspaceLeaf, Notice } from 'obsidian';
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { YoutubePluginView } from './ui/YoutnoteView';
import { Video, Note, VideoId } from './types';
import { parseMarkdownToData, serializeDataToMarkdown, exportToMarkdown, exportSingleVideoToMarkdown } from './markdown';
import { extractYouTubeId } from './utils';
import YoutnotePlugin from './main';

export const VIEW_TYPE = 'youtnote-view';

export class YoutnoteView extends TextFileView {
    root: ReactDOM.Root | null = null;
    plugin: YoutnotePlugin;
    activeEditor: object | null = null;
    
    // State
    videos: Video[] = [];
    notes: Note[] = [];
    activeVideoId: VideoId | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: YoutnotePlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return this.file ? this.file.basename : 'Youtnote'; }
    getIcon() { return 'youtnote'; }

    canAcceptExtension(extension: string): boolean {
        return extension === 'md';
    }

    async onLoadFile(file: import('obsidian').TFile): Promise<void> {
        if (!(await this.plugin.isYoutnoteFile(file))) {
            // Not a Youtnote, switch this leaf back to the regular markdown view
            // Defer to avoid conflicts during the current file loading cycle
            setTimeout(() => {
                void this.leaf.setViewState({
                    type: 'markdown',
                    state: { file: file.path },
                    popstate: true,
                } as import('obsidian').ViewState);
            }, 0);
            return;
        }

        return super.onLoadFile(file);
    }

    getState(): Record<string, unknown> {
        return {
            ...super.getState(),
            file: this.file?.path,
        };
    }

    getViewData(): string {
        return serializeDataToMarkdown(this.videos, this.notes);
    }

    setViewData(data: string, clear: boolean): void {
        const parsed = parseMarkdownToData(data);
        this.videos = parsed.videos;
        this.notes = parsed.notes;
        
        // Maintain active video if it still exists
        if (this.activeVideoId && !this.videos.find(v => v.id === this.activeVideoId)) {
            this.activeVideoId = null;
        }
        
        // Auto-select first video if none selected
        if (!this.activeVideoId && this.videos.length > 0) {
            this.activeVideoId = this.videos[0].id;
        }

        this.render();
    }

    clear(): void {
        this.videos = [];
        this.notes = [];
        this.activeVideoId = null;
        this.render();
    }

    onOpen(): Promise<void> {
        this.contentEl.empty();
        this.root = ReactDOM.createRoot(this.contentEl);
        
        // Add a button to export as Markdown
        this.addAction('file-down', 'Export as Markdown', () => {
            void (async () => {
                if (!this.file) return;
                
                // Generate export content
                const exportContent = exportToMarkdown(this.videos, this.notes);
                
                // Create filename: original name + " - Export.md"
                const baseName = this.file.basename;
                const exportFileName = `${baseName} - Export`;
                
                await this.createExportFile(exportFileName, exportContent);
            })();
        });
        
        // Add a button to the view header to switch back to markdown
        this.addAction('file-text', 'Open as Markdown', () => {
            // Mark this leaf as manually switched to prevent auto-switch back
            this.plugin.youtnoteFileModes[this.leaf.id ?? this.file?.path ?? ''] = 'markdown';
            void this.plugin.setMarkdownView(this.leaf);
        });

        this.render();
        return Promise.resolve();
    }

    onClose(): Promise<void> {
        this.root?.unmount();
        return Promise.resolve();
    }

    // State update handlers
    handleUpdateVideos = (newVideos: Video[]) => {
        this.videos = newVideos;
        this.render();
        this.requestSave(); // Tell TextFileView to save
    };

    handleUpdateNotes = (newNotes: Note[]) => {
        this.notes = newNotes;
        this.render();
        this.requestSave();
    };

    handleSetActiveVideoId = (id: VideoId | null) => {
        this.activeVideoId = id;
        this.render();
    };

    handleExportSingleVideo = async (videoId: VideoId) => {
        const video = this.videos.find(v => v.id === videoId);
        if (!video) return;

        // Generate export content for single video
        const exportContent = exportSingleVideoToMarkdown(video, this.notes);
        
        // Create filename: Youtnote-<video id>
        const ytId = extractYouTubeId(video.url);
        const exportFileName = ytId ? `Youtnote-${ytId}-Export` : `Youtnote-${videoId}-Export`;
        
        await this.createExportFile(exportFileName, exportContent);
    };

    handleExportAllVideos = async () => {
        if (!this.file) return;
        
        // Generate export content for all videos
        const exportContent = exportToMarkdown(this.videos, this.notes);
        
        // Create filename: original name + " - Export"
        const baseName = this.file.basename;
        const exportFileName = `${baseName} - Export`;
        
        await this.createExportFile(exportFileName, exportContent);
    };

    // Public method to refresh the view (e.g., when settings change)
    refresh() {
        this.render();
    }

    // Helper method to create and optionally open an export file
    async createExportFile(baseFileName: string, content: string): Promise<void> {
        if (!this.file) return;
        
        const folder = this.file.parent;
        let exportFileName = `${baseFileName}.md`;
        let exportPath = folder ? `${folder.path}/${exportFileName}` : exportFileName;
        
        // Handle duplicate filenames
        let counter = 1;
        while (await this.plugin.app.vault.adapter.exists(exportPath)) {
            exportFileName = `${baseFileName} ${counter}.md`;
            exportPath = folder ? `${folder.path}/${exportFileName}` : exportFileName;
            counter++;
        }
        
        // Create the export file
        const createdFile = await this.plugin.app.vault.create(exportPath, content);
        
        // Open the exported file in a new tab if setting is enabled
        if (this.plugin.settings.openExportedFile) {
            const leaf = this.plugin.app.workspace.getLeaf('tab');
            await leaf.openFile(createdFile);
        }
        else{
            // Show a notification that the file was created
            new Notice(`Exported file created: ${exportFileName}`, 2000);
        }
    }

    render() {
        if (!this.root) return;

        this.root.render(
            React.createElement(YoutubePluginView, { 
                app: this.plugin.app,
                view: this,
                settings: this.plugin.settings,
                videos: this.videos,
                notes: this.notes,
                activeVideoId: this.activeVideoId,
                setActiveVideoId: this.handleSetActiveVideoId,
                onUpdateVideos: this.handleUpdateVideos,
                onUpdateNotes: this.handleUpdateNotes,
                onExportSingleVideo: this.handleExportSingleVideo,
                onExportAllVideos: this.handleExportAllVideos
            })
        );
    }
}
