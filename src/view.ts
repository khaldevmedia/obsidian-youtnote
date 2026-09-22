import { TextFileView, WorkspaceLeaf, Notice, TFile, ViewState } from 'obsidian';
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { YoutubePluginView } from './ui/YoutnoteView';
import { AlertModal, ExportOptionsModal } from './ui/MessageBoxes';
import { Video, Note, VideoId, ExportOptions } from './types';
import type { AIGenerationDialogOptions } from './types';
import {
    CURRENT_FORMAT_VERSION,
    LEGACY_FORMAT_VERSION,
    detectYoutnoteFormat,
    migrateLegacyYoutnote,
    parseYoutnoteDocument,
    ParseYoutnoteResult,
    serializeYoutnoteDocument,
    updateYoutnoteDocument,
    YoutnoteDocument,
} from './youtnote-format';
import { exportToMarkdown, exportSingleVideoToMarkdown } from './youtnote-format/export';
import { extractYouTubeId } from './utils';
import YoutnotePlugin from './main';

export const VIEW_TYPE = 'youtnote-view';

function describeFormatFailure(result: ParseYoutnoteResult): { title: string; message: string } {
    if (result.ok) {
        return { title: '', message: '' };
    }
    if (result.reason === 'unsupported-version') {
        return {
            title: 'Unsupported Youtnote file-format version',
            message: `This file declares Youtnote file-format version ${result.version}, but this version of the plugin supports up to version ${result.maxSupported}. ` +
                'Update Youtnote and reopen the file. If Youtnote is already up to date, check whether the "youtnote-format-version" frontmatter property was changed manually. ' +
                'The file has not been modified and will be opened as Markdown.',
        };
    }
    if (result.reason === 'malformed-version') {
        return {
            title: 'Invalid Youtnote file-format version',
            message: `This file has an invalid "youtnote-format-version" frontmatter value ("${result.rawValue}"). ` +
                `The Youtnote file-format version must be a positive integer, such as ${CURRENT_FORMAT_VERSION}. ` +
                'The file has not been modified and will be opened as Markdown.',
        };
    }
    return {
        title: 'Invalid Youtnote file structure',
        message: `This file's content does not match a Youtnote file-format structure supported by this version of the plugin (${result.message}). ` +
            'The file has not been modified and will be opened as Markdown.',
    };
}

export class YoutnoteView extends TextFileView {
    root: ReactDOM.Root | null = null;
    plugin: YoutnotePlugin;
    activeEditor: object | null = null;
    
    // State
    videos: Video[] = [];
    notes: Note[] = [];
    activeVideoId: VideoId | null = null;
    private document: YoutnoteDocument | null = null;

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

    async onLoadFile(file: TFile): Promise<void> {
        if (!(await this.plugin.isYoutnoteFile(file))) {
            // Not a Youtnote, switch this leaf back to the regular markdown view
            this.switchToMarkdown(file);
            return;
        }

        const source = await this.app.vault.cachedRead(file);
        const detection = detectYoutnoteFormat(source);

        if (detection.kind === 'unsupported-version') {
            this.failToMarkdown(file, describeFormatFailure({
                ok: false,
                reason: 'unsupported-version',
                version: detection.version,
                maxSupported: detection.maxSupported,
            }));
            return;
        }
        if (detection.kind === 'malformed-version') {
            this.failToMarkdown(file, describeFormatFailure({
                ok: false,
                reason: 'malformed-version',
                rawValue: detection.rawValue,
            }));
            return;
        }

        if (detection.kind === 'legacy') {
            const migration = await this.migrateLegacyFile(file);
            if (!migration.ok) {
                return;
            }
            if (migration.migration === 'legacy-to-current') {
                new Notice(`Updated this file from legacy Youtnote file-format version ${LEGACY_FORMAT_VERSION} to version ${CURRENT_FORMAT_VERSION}.`, 4000);
            } else if (migration.migration === 'corrected-declaration') {
                new Notice(`Corrected this file's Youtnote file-format declaration to version ${CURRENT_FORMAT_VERSION}.`, 4000);
            }
            return super.onLoadFile(file);
        }

        const parsed = parseYoutnoteDocument(source);
        if (!parsed.ok) {
            this.failToMarkdown(file, describeFormatFailure(parsed));
            return;
        }

        return super.onLoadFile(file);
    }

    private switchToMarkdown(file: TFile): void {
        // Defer to avoid conflicts during the current file loading cycle.
        window.setTimeout(() => {
            void this.leaf.setViewState({
                type: 'markdown',
                state: { file: file.path },
                popstate: true,
            } as ViewState);
        }, 0);
    }

    private failToMarkdown(file: TFile, failure: { title: string; message: string }): void {
        this.plugin.youtnoteFileModes[this.leaf.id ?? file.path] = 'markdown';
        new AlertModal(this.app, failure.title, failure.message).open();
        this.switchToMarkdown(file);
    }

    private async migrateLegacyFile(file: TFile): Promise<{ ok: boolean; migration: 'legacy-to-current' | 'corrected-declaration' | 'none' }> {
        const outcome = {
            failure: null as ParseYoutnoteResult | null,
            migration: 'none' as 'legacy-to-current' | 'corrected-declaration' | 'none',
        };
        await this.app.vault.process(file, (data) => {
            if (detectYoutnoteFormat(data).kind !== 'legacy') {
                return data;
            }
            const result = migrateLegacyYoutnote(data);
            if (!result.ok) {
                outcome.failure = result;
                return data;
            }
            outcome.migration = result.migration;
            return result.markdown;
        });
        if (outcome.failure) {
            this.failToMarkdown(file, describeFormatFailure(outcome.failure));
            return { ok: false, migration: 'none' };
        }

        const latest = await this.app.vault.cachedRead(file);
        const parsed = parseYoutnoteDocument(latest);
        if (!parsed.ok) {
            this.failToMarkdown(file, describeFormatFailure(parsed));
            return { ok: false, migration: 'none' };
        }
        if (parsed.document.sourceFormatVersion !== CURRENT_FORMAT_VERSION) {
            this.failToMarkdown(file, describeFormatFailure({
                ok: false,
                reason: 'invalid-document',
                message: 'The file is still in the legacy format after migration.',
            }));
            return { ok: false, migration: 'none' };
        }
        return { ok: true, migration: outcome.migration };
    }

    getState(): Record<string, unknown> {
        return {
            ...super.getState(),
            file: this.file?.path,
        };
    }

    getViewData(): string {
        if (this.document) {
            return serializeYoutnoteDocument(updateYoutnoteDocument(this.document, this.videos, this.notes));
        }
        return serializeYoutnoteDocument(updateYoutnoteDocument(
            {
                sourceFormatVersion: CURRENT_FORMAT_VERSION,
                frontmatter: { raw: '' },
                videos: [],
                notes: [],
                videoLayouts: [],
            },
            this.videos,
            this.notes,
        ));
    }

    setViewData(data: string): void {
        const parsed = parseYoutnoteDocument(data);
        if (!parsed.ok) {
            this.document = null;
            this.videos = [];
            this.notes = [];
            this.activeVideoId = null;
            this.render();
            if (this.file) {
                this.failToMarkdown(this.file, describeFormatFailure(parsed));
            }
            return;
        }
        this.document = parsed.document;
        this.videos = parsed.document.videos;
        this.notes = parsed.document.notes;

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
        this.document = null;
        this.render();
    }

    onOpen(): Promise<void> {
        this.contentEl.empty();
        this.root = ReactDOM.createRoot(this.contentEl);
        
        // Add a button to export as Markdown
        this.addAction('file-down', 'Export as Markdown', () => {
            void this.handleExportAllVideos();
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
        this.root = null;
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

        this.openExportDialog(false, videoId);
    };

    handleExportAllVideos = async () => {
        if (!this.file) return;

        this.openExportDialog(true);
    };

    handleFetchTranscript = (videoId: VideoId) => {
        this.plugin.startTranscriptFetch(this, videoId);
    };

    handleGenerateAINotes = (videoId: VideoId, options: AIGenerationDialogOptions) => {
        this.plugin.startAINoteGeneration(this, videoId, options);
    };

    handleCancelVideoTasks = (videoId: VideoId, kind?: 'transcript' | 'ai') => {
        this.plugin.cancelVideoTasks(this, videoId, kind);
    };

    private openExportDialog(exportAllVideos: boolean, videoId?: VideoId): void {
        new ExportOptionsModal(
            this.app,
            exportAllVideos,
            {
                includeNotes: this.plugin.settings.exportIncludeNotes,
                includeTranscripts: this.plugin.settings.exportIncludeTranscripts,
            },
            async (options) => {
                this.plugin.settings.exportIncludeNotes = options.includeNotes;
                this.plugin.settings.exportIncludeTranscripts = options.includeTranscripts;
                await this.plugin.saveDataState();
                await this.performExport(exportAllVideos, options, videoId);
            }
        ).open();
    }

    private async performExport(exportAllVideos: boolean, options: ExportOptions, videoId?: VideoId): Promise<void> {
        if (!this.file) return;

        if (exportAllVideos) {
            const exportContent = exportToMarkdown(this.videos, this.notes, options);
            const baseName = this.file.basename;
            await this.createExportFile(`${baseName} - Export`, exportContent);
            return;
        }

        if (!videoId) return;
        const video = this.videos.find(v => v.id === videoId);
        if (!video) return;

        // Generate export content for single video
        const exportContent = exportSingleVideoToMarkdown(video, this.notes, options);

        // Create filename: Youtnote-<video id>
        const ytId = extractYouTubeId(video.url);
        const exportFileName = ytId ? `Youtnote-${ytId}-Export` : `Youtnote-${videoId}-Export`;

        await this.createExportFile(exportFileName, exportContent);
    }

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

        const activeVideo = this.videos.find(v => v.id === this.activeVideoId);
        const activeYoutubeId = activeVideo ? extractYouTubeId(activeVideo.url) : null;

        this.root.render(
            React.createElement(YoutubePluginView, {
                key: this.file?.path ?? 'no-file',
                app: this.plugin.app,
                view: this,
                settings: this.plugin.settings,
                videos: this.videos,
                notes: this.notes,
                activeVideoId: this.activeVideoId,
                videoTaskState: this.plugin.getVideoTaskState(this.file, activeYoutubeId),
                setActiveVideoId: this.handleSetActiveVideoId,
                onUpdateVideos: this.handleUpdateVideos,
                onUpdateNotes: this.handleUpdateNotes,
                onExportSingleVideo: this.handleExportSingleVideo,
                onExportAllVideos: this.handleExportAllVideos,
                onFetchTranscript: this.handleFetchTranscript,
                onGenerateAINotes: this.handleGenerateAINotes,
                onCancelVideoTasks: this.handleCancelVideoTasks,
                onOpenAISettings: this.plugin.openSettings
            })
        );
    }
}
