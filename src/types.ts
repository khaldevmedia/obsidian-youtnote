import { App } from 'obsidian';


// Make Typescript compiler happy
declare global {
    interface Window {
        YT?: any;
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

export interface ObsidianEditorProps {
    app: App;
    view: any;
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
    view: any;
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
    onToggleExpand: (e: React.MouseEvent, noteId: NoteId, timestampSec: number) => void;
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
    view: any;
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