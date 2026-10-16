import { describe, expect, it, vi } from 'vitest';
import { seekToSelection } from './playback';
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
