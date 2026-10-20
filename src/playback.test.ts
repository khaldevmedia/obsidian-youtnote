import { describe, expect, it, vi } from 'vitest';
import { PlaybackPositionMemory, seekToSelection } from './playback';
import type { PlaybackPositionSource } from './playback';
import type { YouTubeIframeAdapter } from './PlayerAdapter';
import type { PluginSettings } from './types';

type AdapterStub = Pick<YouTubeIframeAdapter, 'seek' | 'play' | 'seekAndPause'>;
type AutoplayFlags = Pick<PluginSettings, 'autoplayOnNoteSelect' | 'autoplayOnCaptionSelect'>;

const makeAdapter = () => ({
    seek: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    seekAndPause: vi.fn(async () => {}),
});

const makeSettings = (note: boolean, caption: boolean): AutoplayFlags => ({
    autoplayOnNoteSelect: note,
    autoplayOnCaptionSelect: caption,
});

describe('seekToSelection', () => {
    const cases = ([true, false] as const).flatMap(note =>
        ([true, false] as const).flatMap(caption =>
            (['note', 'caption'] as const).map(selection => ({ note, caption, selection }))));

    it.each(cases)(
        '$selection with note=$note caption=$caption',
        async ({ note, caption, selection }) => {
            const adapter = makeAdapter();
            await seekToSelection(adapter, 42, selection, makeSettings(note, caption));
            const autoplay = selection === 'caption' ? caption : note;
            if (autoplay) {
                expect(adapter.seek).toHaveBeenCalledTimes(1);
                expect(adapter.seek).toHaveBeenCalledWith(42);
                expect(adapter.play).toHaveBeenCalledTimes(1);
                expect(adapter.seekAndPause).not.toHaveBeenCalled();
            } else {
                expect(adapter.seekAndPause).toHaveBeenCalledTimes(1);
                expect(adapter.seekAndPause).toHaveBeenCalledWith(42);
                expect(adapter.seek).not.toHaveBeenCalled();
                expect(adapter.play).not.toHaveBeenCalled();
            }
        }
    );

    it('plays only after the seek resolves', async () => {
        let resolveSeek: (() => void) | undefined;
        const adapter: AdapterStub = {
            seek: vi.fn(() => new Promise<void>(resolve => { resolveSeek = resolve; })),
            play: vi.fn(async () => {}),
            seekAndPause: vi.fn(async () => {}),
        };
        const pending = seekToSelection(adapter, 7, 'note', makeSettings(true, false));
        await Promise.resolve();
        expect(adapter.seek).toHaveBeenCalledTimes(1);
        expect(adapter.play).not.toHaveBeenCalled();
        resolveSeek!();
        await pending;
        expect(adapter.play).toHaveBeenCalledTimes(1);
    });

    it('does nothing without an adapter', async () => {
        await expect(seekToSelection(null, 5, 'note', makeSettings(true, true))).resolves.toBeUndefined();
        await expect(seekToSelection(null, 5, 'caption', makeSettings(true, true))).resolves.toBeUndefined();
    });

    it('does not play and propagates when the seek fails', async () => {
        const adapter = makeAdapter();
        adapter.seek.mockRejectedValue(new Error('seek failed'));
        await expect(seekToSelection(adapter, 9, 'caption', makeSettings(true, true)))
            .rejects.toThrow('seek failed');
        expect(adapter.play).not.toHaveBeenCalled();
        expect(adapter.seekAndPause).not.toHaveBeenCalled();
    });
});

describe('PlaybackPositionMemory', () => {
    interface StubSource extends PlaybackPositionSource {
        emit(time: number): void;
        time: number;
        duration: number;
        state: number;
        deferredTimes: { resolve: (t: number) => void; reject: (e: unknown) => void }[];
        deferNextTime(): void;
        listenerCount(): number;
    }

    const makeSource = (): StubSource => {
        const listeners = new Set<(t: number) => void>();
        const source: StubSource = {
            time: 0,
            duration: 0,
            state: 2,
            deferredTimes: [],
            deferNextTime() {
                const real = () => Promise.resolve(source.time);
                source.getCurrentTime = () => {
                    source.getCurrentTime = real;
                    return new Promise<number>((resolve, reject) => {
                        source.deferredTimes.push({ resolve, reject });
                    });
                };
            },
            emit(time: number) {
                source.time = time;
                listeners.forEach(l => l(time));
            },
            listenerCount: () => listeners.size,
            subscribeToTimeUpdates(listener) {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            getCurrentTime: () => Promise.resolve(source.time),
            getDuration: () => Promise.resolve(source.duration),
            getPlayerState: () => Promise.resolve(source.state),
        };
        return source;
    };

    const flush = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it('captures the position of an already-positioned adapter when tracking starts', async () => {
        const memory = new PlaybackPositionMemory();
        memory.setEnabled(true);
        const source = makeSource();
        source.time = 80;
        memory.startTracking(source, 'ytA');
        await flush();
        expect(memory.get('ytA')).toBe(80);
    });

    it('records a valid zero reached while tracked', async () => {
        const memory = new PlaybackPositionMemory();
        memory.setEnabled(true);
        const source = makeSource();
        memory.startTracking(source, 'ytA');
        source.emit(120);
        memory.stopTracking();
        memory.startTracking(source, 'ytA');
        await flush();
        source.emit(0);
        memory.stopTracking();
        await flush();
        expect(memory.get('ytA')).toBe(0);
    });

    it('ignores NaN and negative time updates', async () => {
        const memory = new PlaybackPositionMemory();
        memory.setEnabled(true);
        const source = makeSource();
        source.emit(60);
        memory.startTracking(source, 'ytA');
        await flush();
        source.emit(Number.NaN);
        source.emit(-5);
        memory.stopTracking();
        await flush();
        expect(memory.get('ytA')).toBe(60);
    });

    it('a late initial snapshot cannot overwrite a newer delivered time', async () => {
        const memory = new PlaybackPositionMemory();
        memory.setEnabled(true);
        const source = makeSource();
        source.deferNextTime();
        memory.startTracking(source, 'ytA');
        source.emit(50);
        memory.stopTracking();
        source.deferredTimes[0].resolve(10);
        await flush();
        expect(memory.get('ytA')).toBe(50);
    });

    it('an earlier stop snapshot cannot overwrite a later stop snapshot for the same video', async () => {
        const memory = new PlaybackPositionMemory();
        memory.setEnabled(true);
        const source = makeSource();
        memory.startTracking(source, 'ytA');
        source.deferNextTime();
        memory.stopTracking();
        memory.startTracking(source, 'ytA');
        source.deferNextTime();
        memory.stopTracking();
        source.deferredTimes[1].resolve(80);
        await flush();
        source.deferredTimes[0].resolve(30);
        await flush();
        expect(memory.get('ytA')).toBe(80);
    });

    it('disabling clears positions and drops pending snapshot writes', async () => {
        const memory = new PlaybackPositionMemory();
        memory.setEnabled(true);
        const source = makeSource();
        memory.startTracking(source, 'ytA');
        source.emit(70);
        source.deferNextTime();
        memory.stopTracking();
        memory.setEnabled(false);
        source.deferredTimes[0].resolve(70);
        await flush();
        expect(memory.get('ytA')).toBeUndefined();
        expect(source.listenerCount()).toBe(0);
    });

    it('stores the duration for an ended video even when the last delivery fell short', async () => {
        const memory = new PlaybackPositionMemory();
        memory.setEnabled(true);
        const source = makeSource();
        source.duration = 600;
        source.state = 0;
        memory.startTracking(source, 'ytA');
        source.emit(595);
        memory.stopTracking();
        await flush();
        expect(memory.get('ytA')).toBe(600);
    });

    it('tracks nothing while disabled', () => {
        const memory = new PlaybackPositionMemory();
        const source = makeSource();
        memory.startTracking(source, 'ytA');
        expect(source.listenerCount()).toBe(0);
    });
});
