import { Video, Note } from './types';
import {
    createEmptyYoutnoteMarkdown,
    parseYoutnoteArrays,
    serializeYoutnoteDocument,
    updateYoutnoteDocument,
} from './youtnote-format';
import { CURRENT_FORMAT_VERSION } from './youtnote-format/types';
import { exportSingleVideoToMarkdown, exportToMarkdown } from './youtnote-format/export';

export function parseMarkdownToData(markdown: string): { videos: Video[], notes: Note[] } {
    return parseYoutnoteArrays(markdown);
}

export function serializeDataToMarkdown(videos: Video[], notes: Note[]): string {
    return serializeYoutnoteDocument(updateYoutnoteDocument(
        {
            sourceFormatVersion: CURRENT_FORMAT_VERSION,
            frontmatter: { raw: '' },
            videos: [],
            notes: [],
            videoLayouts: [],
        },
        videos,
        notes,
    ));
}

export { exportToMarkdown, exportSingleVideoToMarkdown, createEmptyYoutnoteMarkdown };
