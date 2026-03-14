import { App, Component, TFile } from 'obsidian';
import type { MouseEvent } from 'react';

// YouTube IFrame API types
interface YTPlayerOptions {
    events?: {
        onReady?: () => void;
        onError?: (event: { data: number }) => void;
        onStateChange?: (event: { data: number }) => void;
    };
}

export interface YTPlayer {
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    getCurrentTime(): number;
    getDuration(): number;
    playVideo(): void;
    pauseVideo(): void;
    getPlayerState(): number;
    isMuted(): boolean;
    mute(): void;
    unMute(): void;
    cueVideoById(videoId: string): void;
    destroy(): void;
}

interface YTPlayerStateConstants {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
}

interface YTNamespace {
    Player: new (element: HTMLIFrameElement, options: YTPlayerOptions) => YTPlayer;
    PlayerState?: YTPlayerStateConstants;
}

/** Minimal abstract constructor shape of Obsidian's internal MarkdownEditor class. */
export type MarkdownEditorClass = abstract new (...args: unknown[]) => Component & {
    onUpdate(update: unknown, changed: boolean): void;
    buildLocalExtensions(): unknown[];
    get(): string;
    set(value: string): void;
    readonly editor?: { focus(): void };
};

/** Context for instantiating Obsidian's internal embed registry factory. */
export interface EmbedContext {
    app: App;
    containerEl: HTMLElement;
    state: Record<string, unknown>;
}

/** Shape of the object returned by Obsidian's markdown embed factory. */
export interface MarkdownEmbedInstance {
    editable?: boolean;
    editMode?: object;
    showEditor?: () => void;
    load(): void;
    unload(): void;
}

/** Controller object that Obsidian's MarkdownEditor expects as its owner. */
export interface MarkdownController {
    app: App;
    showSearch: () => void;
    toggleMode: () => void;
    onMarkdownScroll: () => void;
    getMode: () => string;
    scroll: number;
    editMode: object | null;
    readonly editor: { focus(): void } | undefined;
    readonly file: TFile | null;
    readonly path: string;
}

// Obsidian internal API augmentations
declare module 'obsidian' {
    interface App {
        commands: { executeCommandById(id: string): void };
        mobileToolbar?: { update(): void };
        loadLocalStorage(key: string): string | null;
        saveLocalStorage(key: string, value: string): void;
        embedRegistry?: {
            embedByExtension: {
                md: (context: EmbedContext, file: null, path: string) => MarkdownEmbedInstance;
            };
        };
    }
    interface WorkspaceLeaf {
        id?: string;
    }
    interface MarkdownView {
        youtnoteActionEl?: HTMLElement | null;
        youtnoteActionFilePath?: string | null;
    }
}

// Make TypeScript compiler happy
declare global {
    interface Window {
        YT?: YTNamespace;
        youtubeAPIPromise?: Promise<void>;
        onYouTubeIframeAPIReady?: () => void;
    }
}


// Types
export type VideoId = string & {
    readonly __brand: unique symbol

};
export type NoteId = string & {
    readonly __brand: unique symbol

};


// Interfaces
export interface PluginSettings {
	pinOnPhone: boolean;
	autoplayOnNoteSelect: boolean;
	singleExpandMode: boolean;
	persistExpandedState: boolean;
	newLineTrigger: 'shift+enter' | 'enter';
	openExportedFile: boolean;
	showNoteStats: boolean;
}

export interface PluginData {
    settings: PluginSettings;
}

/**
 * Minimal view context passed from YoutnoteView into React components.
 * Avoids circular imports while giving components typed access to app internals.
 */
export interface YoutnoteViewContext {
    app: App;
    file: TFile | null;
    /** Tracks the active CodeMirror editor instance for mobile toolbar support. */
    activeEditor: object | null;
    plugin: Component & { MarkdownEditor: MarkdownEditorClass | null };
}

export interface ObsidianEditorProps {
    app: App;
    view: YoutnoteViewContext;
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
    onBlur?: () => void;
    newLineTrigger: 'shift+enter' | 'enter';
}

export interface VideoListItemProps {
    app: App;
    video: Video;
    isActive: boolean;
    onSelect: (id: VideoId) => void;
    onDelete: (id: VideoId) => void;
}

export interface NoteListItemProps {
    app: App;
    view: YoutnoteViewContext;
    note: Note;
    isExpanded: boolean;
    isActive: boolean;
    isEditing: boolean;
    editingTimestampId: NoteId | null;
    editTimestampValue: string;
    timestampError: string | null;
    editNoteBody: string;
    maxDuration: number;
    newLineTrigger: PluginSettings['newLineTrigger'];
    onToggleExpand: (e: MouseEvent, noteId: NoteId, timestampSec: number) => void;
    onSelect: (noteId: NoteId, timestampSec: number) => void;
    onStartEdit: (noteId: NoteId, body: string) => void;
    onSaveEdit: () => void;
    onBodyChange: (value: string) => void;
    onStartTimestampEdit: (noteId: NoteId, currentValue: string) => void;
    onSaveTimestampEdit: (noteId: NoteId) => void;
    onCancelTimestampEdit: () => void;
    onTimestampChange: (value: string) => void;
    onDelete: (noteId: NoteId) => void;
}

export interface Video {
    id: VideoId;
    url: string;
    title?: string;
    thumbnail?: string;
    durationSec?: number;
    pinned?: boolean;
}

export interface Note {
    id: NoteId;
    videoId: VideoId;
    timestampSec: number;
    bodyMarkdown: string;
    createdAt: string;
    updatedAt: string;
}

export interface YoutubePluginViewProps {
    app: App;
    view: YoutnoteViewContext;
    settings: PluginSettings;
    videos: Video[];
    notes: Note[];
    activeVideoId: VideoId | null;
    setActiveVideoId: (id: VideoId | null) => void;
    onUpdateVideos: (videos: Video[]) => void;
    onUpdateNotes: (notes: Note[]) => void;
    onExportSingleVideo: (videoId: VideoId) => Promise<void>;
    onExportAllVideos: () => Promise<void>;
}

export interface PlayerAdapter {
    seek(timestampSec: number): Promise<void>;
    getCurrentTime(): Promise<number>;
    getDuration(): Promise<number>;
    play(): Promise<void>;
    pause(): Promise<void>;
    isReady(): boolean;
    getPlayerState(): Promise<number>;
    loadVideo(videoId: string): Promise<void>;
    destroy(): void;
}