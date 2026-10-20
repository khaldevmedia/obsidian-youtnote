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

export interface PlaybackPositionSource {
    subscribeToTimeUpdates(listener: (currentTimeSec: number) => void): () => void;
    getCurrentTime(): Promise<number>;
    getDuration(): Promise<number>;
    getPlayerState(): Promise<number>;
}

const YT_ENDED_STATE = 0;

interface TrackedVideo {
    ytId: string;
    adapter: PlaybackPositionSource;
    lastTime: number | null;
    lastSeq: number;
    unsubscribe: () => void;
}

export class PlaybackPositionMemory {
    private positions = new Map<string, number>();
    private writeSeqs = new Map<string, number>();
    private tracked: TrackedVideo | null = null;
    private enabled = false;
    private epoch = 0;
    private seq = 0;

    isEnabled(): boolean {
        return this.enabled;
    }

    get version(): number {
        return this.epoch;
    }

    setEnabled(enabled: boolean): void {
        if (enabled) {
            this.enabled = true;
            return;
        }
        this.epoch++;
        this.stopTracking();
        this.positions.clear();
        this.writeSeqs.clear();
        this.enabled = false;
    }

    get(ytId: string): number | undefined {
        return this.positions.get(ytId);
    }

    startTracking(adapter: PlaybackPositionSource, ytId: string): void {
        this.stopTracking();
        if (!this.enabled) return;
        const epoch = this.epoch;
        const entry: TrackedVideo = {
            ytId,
            adapter,
            lastTime: null,
            lastSeq: -1,
            unsubscribe: adapter.subscribeToTimeUpdates((time) => {
                if (Number.isFinite(time) && time >= 0) {
                    entry.lastTime = time;
                    entry.lastSeq = ++this.seq;
                }
            }),
        };
        this.tracked = entry;
        const snapshotSeq = ++this.seq;
        void adapter.getCurrentTime().then((time) => {
            if (this.tracked !== entry) return;
            this.apply(ytId, time, snapshotSeq, epoch);
        }, () => {});
    }

    stopTracking(): void {
        const entry = this.tracked;
        if (!entry) return;
        this.tracked = null;
        entry.unsubscribe();
        if (entry.lastTime !== null) {
            this.apply(entry.ytId, entry.lastTime, entry.lastSeq, this.epoch);
        }
        if (!this.enabled) return;
        const epoch = this.epoch;
        const seq = ++this.seq;
        void Promise.all([
            entry.adapter.getCurrentTime(),
            entry.adapter.getPlayerState(),
            entry.adapter.getDuration(),
        ]).then(([time, state, duration]) => {
            let value = time;
            if (state === YT_ENDED_STATE && duration > 0) {
                value = duration;
            } else if (Number.isFinite(value) && value >= 0 && duration > 0) {
                value = Math.min(value, duration);
            }
            this.apply(entry.ytId, value, seq, epoch);
        }, () => {});
    }

    private apply(ytId: string, time: number, seq: number, epoch: number): void {
        if (!this.enabled || epoch !== this.epoch) return;
        if (!Number.isFinite(time) || time < 0) return;
        if (seq <= (this.writeSeqs.get(ytId) ?? -1)) return;
        this.writeSeqs.set(ytId, seq);
        this.positions.set(ytId, time);
    }
}
