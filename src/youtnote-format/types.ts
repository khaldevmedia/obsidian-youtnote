import type { Note, Video, VideoId } from '../types';

export const LEGACY_FORMAT_VERSION = 1;
export const CURRENT_FORMAT_VERSION = 2;
export type LegacyFormatVersion = typeof LEGACY_FORMAT_VERSION;
export type CurrentFormatVersion = typeof CURRENT_FORMAT_VERSION;
export type ReadableFormatVersion = LegacyFormatVersion | CurrentFormatVersion;

export interface PreservedFrontmatter {
    raw: string; // complete `---` block including delimiters
}

export interface OpaqueYoutnoteSection {
    kind: 'opaque';
    type: string;
    openingMarker: string;
    body: string;
    closingMarker: string;
}

export type YoutnoteSectionSlot =
    | { kind: 'source' }
    | { kind: 'notes' }
    | { kind: 'transcript' }
    | OpaqueYoutnoteSection;

export interface YoutnoteVideoLayout {
    videoId: VideoId;
    sections: YoutnoteSectionSlot[];
}

export interface YoutnoteDocument {
    sourceFormatVersion: ReadableFormatVersion;
    frontmatter: PreservedFrontmatter;
    videos: Video[];
    notes: Note[];
    videoLayouts: YoutnoteVideoLayout[];
}

export type FormatDetection =
    | { kind: 'legacy'; version: LegacyFormatVersion }
    | { kind: 'supported'; version: CurrentFormatVersion }
    | { kind: 'unsupported-version'; version: number; maxSupported: CurrentFormatVersion }
    | { kind: 'malformed-version'; rawValue: string };

export type ParseYoutnoteResult =
    | { ok: true; document: YoutnoteDocument }
    | { ok: false; reason: 'unsupported-version'; version: number; maxSupported: CurrentFormatVersion }
    | { ok: false; reason: 'malformed-version'; rawValue: string }
    | { ok: false; reason: 'invalid-document'; message: string };

export type MigrationResult =
    | { ok: true; document: YoutnoteDocument; markdown: string; migration: 'legacy-to-current' | 'corrected-declaration' | 'none' }
    | { ok: false; reason: 'unsupported-version'; version: number; maxSupported: CurrentFormatVersion }
    | { ok: false; reason: 'malformed-version'; rawValue: string }
    | { ok: false; reason: 'invalid-document'; message: string };
