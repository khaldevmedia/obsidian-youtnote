import { describe, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import { ActiveVideoTaskRegistry } from './activeVideoTasks';
import type { VideoTaskTarget } from './activeVideoTasks';

function unsafeCast<T>(value: unknown): T {
    return value as T;
}

const fileA = unsafeCast<TFile>({ path: 'a.md' });
const fileB = unsafeCast<TFile>({ path: 'b.md' });

function targetFor(file: TFile, youtubeId = 'yt-1', videoTitle = 'Video'): VideoTaskTarget {
    return { file, youtubeId, videoTitle };
}

describe('ActiveVideoTaskRegistry', () => {
    it('rejects a duplicate task of the same kind and target', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const first = registry.start('transcript', target, 'fetching-tracks');
        const second = registry.start('transcript', target, 'fetching-tracks');
        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    it('lets transcript and ai tasks coexist for one target', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const transcript = registry.start('transcript', target, 'fetching-tracks');
        const ai = registry.start('ai', target, 'generating-notes');
        expect(transcript).not.toBeNull();
        expect(ai).not.toBeNull();
        expect(ai!.id).not.toBe(transcript!.id);
        const state = registry.getVideoState(fileA, 'yt-1');
        expect(state.transcriptPhase).toBe('fetching-tracks');
        expect(state.aiPhase).toBe('generating-notes');
    });

    it('treats the same YouTube ID in different file objects as independent targets', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const first = registry.start('transcript', targetFor(fileA, 'yt-1'), 'fetching-tracks');
        const second = registry.start('transcript', targetFor(fileB, 'yt-1'), 'fetching-tracks');
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        registry.cancelFile(fileA);
        expect(registry.getVideoState(fileA, 'yt-1').transcriptPhase).toBeNull();
        expect(registry.getVideoState(fileB, 'yt-1').transcriptPhase).toBe('fetching-tracks');
    });

    it('requires strict file identity for state and deduplication', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const otherA = unsafeCast<TFile>({ path: 'a.md' });
        registry.start('transcript', targetFor(fileA, 'yt-1'), 'fetching-tracks');
        expect(registry.start('transcript', targetFor(otherA, 'yt-1'), 'fetching-tracks')).not.toBeNull();
        expect(registry.getVideoState(otherA, 'yt-1').transcriptPhase).toBe('fetching-tracks');
    });

    it('updates phases and reports them through getVideoState', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const handle = registry.start('transcript', targetFor(fileA), 'fetching-tracks');
        expect(handle).not.toBeNull();
        expect(registry.update(handle!.id, 'choosing-track')).toBe(true);
        expect(registry.getVideoState(fileA, 'yt-1').transcriptPhase).toBe('choosing-track');
        expect(registry.update(handle!.id, 'fetching-captions')).toBe(true);
        expect(registry.getVideoState(fileA, 'yt-1').transcriptPhase).toBe('fetching-captions');
    });

    it('completes tasks and clears their state', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const handle = registry.start('ai', targetFor(fileA), 'generating-notes');
        expect(handle).not.toBeNull();
        expect(registry.isActive(handle!.id)).toBe(true);
        expect(registry.complete(handle!.id)).toBe(true);
        expect(registry.isActive(handle!.id)).toBe(false);
        expect(registry.getVideoState(fileA, 'yt-1').aiPhase).toBeNull();
        expect(registry.complete(handle!.id)).toBe(false);
    });

    it('cancels a single kind for a target and aborts its signal', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const transcript = registry.start('transcript', target, 'fetching-tracks');
        const ai = registry.start('ai', target, 'generating-notes');
        expect(registry.cancelTarget(fileA, 'yt-1', 'transcript')).toBe(true);
        expect(transcript!.signal.aborted).toBe(true);
        expect(ai!.signal.aborted).toBe(false);
        const state = registry.getVideoState(fileA, 'yt-1');
        expect(state.transcriptPhase).toBeNull();
        expect(state.aiPhase).toBe('generating-notes');
    });

    it('cancels every kind for a target when no kind is given', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const transcript = registry.start('transcript', target, 'fetching-tracks');
        const ai = registry.start('ai', target, 'generating-notes');
        expect(registry.cancelTarget(fileA, 'yt-1')).toBe(true);
        expect(transcript!.signal.aborted).toBe(true);
        expect(ai!.signal.aborted).toBe(true);
        const state = registry.getVideoState(fileA, 'yt-1');
        expect(state.transcriptPhase).toBeNull();
        expect(state.aiPhase).toBeNull();
    });

    it('cancels all tasks for a file', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const a1 = registry.start('transcript', targetFor(fileA, 'yt-1'), 'fetching-tracks');
        const a2 = registry.start('ai', targetFor(fileA, 'yt-2'), 'generating-notes');
        const b1 = registry.start('transcript', targetFor(fileB, 'yt-1'), 'fetching-tracks');
        expect(registry.cancelFile(fileA)).toBe(true);
        expect(a1!.signal.aborted).toBe(true);
        expect(a2!.signal.aborted).toBe(true);
        expect(b1!.signal.aborted).toBe(false);
        expect(registry.getVideoState(fileB, 'yt-1').transcriptPhase).toBe('fetching-tracks');
    });

    it('cancels all tasks and aborts all signals', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const first = registry.start('transcript', targetFor(fileA, 'yt-1'), 'fetching-tracks');
        const second = registry.start('ai', targetFor(fileB, 'yt-2'), 'generating-notes');
        expect(registry.cancelAll()).toBe(true);
        expect(first!.signal.aborted).toBe(true);
        expect(second!.signal.aborted).toBe(true);
        expect(registry.isActive(first!.id)).toBe(false);
        expect(registry.isActive(second!.id)).toBe(false);
        expect(registry.cancelAll()).toBe(false);
    });

    it('makes late update and complete calls harmless after cancellation', () => {
        const onChange = vi.fn();
        const registry = new ActiveVideoTaskRegistry(onChange);
        const handle = registry.start('transcript', targetFor(fileA), 'fetching-tracks');
        expect(handle).not.toBeNull();
        onChange.mockClear();
        expect(registry.cancelTarget(fileA, 'yt-1')).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);
        onChange.mockClear();
        expect(registry.update(handle!.id, 'fetching-captions')).toBe(false);
        expect(registry.complete(handle!.id)).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('does not call onChange for no-op calls', () => {
        const onChange = vi.fn();
        const registry = new ActiveVideoTaskRegistry(onChange);
        expect(registry.cancelTarget(fileA, 'yt-1')).toBe(false);
        expect(registry.cancelFile(fileA)).toBe(false);
        expect(registry.cancelAll()).toBe(false);
        expect(registry.update(999, 'fetching-captions')).toBe(false);
        expect(registry.complete(999)).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('allows a new task of the same kind after the previous one completed', () => {
        const registry = new ActiveVideoTaskRegistry(() => {});
        const target = targetFor(fileA);
        const first = registry.start('transcript', target, 'fetching-tracks');
        registry.complete(first!.id);
        const second = registry.start('transcript', target, 'fetching-tracks');
        expect(second).not.toBeNull();
        expect(second!.id).not.toBe(first!.id);
    });
});
