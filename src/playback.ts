import type { YouTubeIframeAdapter } from './PlayerAdapter';
import type { PluginSettings } from './types';

export async function seekToSelection(
    adapter: Pick<YouTubeIframeAdapter, 'seek' | 'play' | 'seekAndPause'> | null,
    timestampSec: number,
    selection: 'note' | 'caption',
    settings: Pick<PluginSettings, 'autoplayOnNoteSelect' | 'autoplayOnCaptionSelect'>,
): Promise<void> {
    if (!adapter) return;
    const autoplay = selection === 'caption' ? settings.autoplayOnCaptionSelect : settings.autoplayOnNoteSelect;
    if (autoplay) {
        await adapter.seek(timestampSec);
        await adapter.play();
    } else {
        await adapter.seekAndPause(timestampSec);
    }
}
