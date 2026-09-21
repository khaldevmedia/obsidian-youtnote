import { App, SuggestModal } from 'obsidian';
import { CaptionTrack } from '../types';

export class CaptionTrackModal extends SuggestModal<CaptionTrack> {
    private tracks: CaptionTrack[];
    private onChoose: (track: CaptionTrack | null) => void;
    private chosen: CaptionTrack | null = null;
    private resolved = false;

    constructor(
        app: App,
        tracks: CaptionTrack[],
        onChoose: (track: CaptionTrack | null) => void,
        contextLabel?: string,
    ) {
        super(app);
        this.tracks = tracks;
        this.onChoose = onChoose;
        this.setPlaceholder('Choose a caption track...');
        if (contextLabel) {
            this.titleEl.setText(`Choose captions for ${contextLabel}`);
        }
    }

    getSuggestions(query: string): CaptionTrack[] {
        const q = query.trim().toLowerCase();
        if (!q) {
            return this.tracks;
        }
        return this.tracks.filter(track =>
            track.name.toLowerCase().includes(q) || track.languageCode.toLowerCase().includes(q)
        );
    }

    renderSuggestion(track: CaptionTrack, el: HTMLElement): void {
        el.createDiv({ text: track.name });
        el.createDiv({
            cls: 'youtnote-plugin__caption-track-meta',
            text: track.isDefault ? `${track.languageCode} · Default` : track.languageCode,
        });
    }

    // Obsidian's selectSuggestion calls close() (and thus onClose) before
    // onChooseSuggestion, so remember the choice here before delegating.
    selectSuggestion(value: CaptionTrack, evt: MouseEvent | KeyboardEvent): void {
        this.chosen = value;
        super.selectSuggestion(value, evt);
    }

    onChooseSuggestion(track: CaptionTrack): void {
        this.chosen = track;
    }

    onClose(): void {
        this.resolve(this.chosen);
    }

    private resolve(track: CaptionTrack | null): void {
        if (this.resolved) {
            return;
        }
        this.resolved = true;
        this.onChoose(track);
    }
}

export function pickCaptionTrack(app: App, tracks: CaptionTrack[], contextLabel?: string): Promise<CaptionTrack | null> {
    return new Promise(resolve => {
        new CaptionTrackModal(app, tracks, resolve, contextLabel).open();
    });
}
