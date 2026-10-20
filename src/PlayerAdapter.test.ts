import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeIframeAdapter } from './PlayerAdapter';

interface ScheduledTimer {
    id: number;
    at: number;
    cb: () => void;
    interval: number | null;
}

class ManualTimers {
    private seq = 0;
    private now = 0;
    private pending: ScheduledTimer[] = [];

    setTimeout = (cb: () => void, ms = 0): number => this.schedule(cb, ms, null);
    setInterval = (cb: () => void, ms = 0): number => this.schedule(cb, ms, ms);
    clearTimeout = (id: number): void => {
        this.pending = this.pending.filter(t => t.id !== id);
    };
    clearInterval = this.clearTimeout;

    private schedule(cb: () => void, ms: number, interval: number | null): number {
        const id = ++this.seq;
        this.pending.push({ id, at: this.now + ms, cb, interval });
        return id;
    }

    private advance(ms: number): void {
        const target = this.now + ms;
        for (;;) {
            const due = this.pending
                .filter(t => t.at <= target)
                .sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!due) break;
            this.now = due.at;
            if (due.interval !== null) {
                due.at += due.interval;
            } else {
                this.pending = this.pending.filter(t => t.id !== due.id);
            }
            due.cb();
        }
        this.now = target;
    }

    async pump(ms: number): Promise<void> {
        let elapsed = 0;
        while (elapsed < ms) {
            const step = Math.min(10, ms - elapsed);
            this.advance(step);
            elapsed += step;
            for (let i = 0; i < 3; i++) {
                await Promise.resolve();
            }
        }
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
            this.advance(0);
        }
    }
}

interface FakeIframe {
    src: string;
    contentWindow: { postMessage: ReturnType<typeof vi.fn> };
    ownerDocument: { defaultView: unknown };
    listeners: Record<string, (() => void) | undefined>;
    addEventListener: (event: string, cb: () => void) => void;
}

interface FakeWindow {
    listeners: Map<string, Set<(event: unknown) => void>>;
    addEventListener(type: string, cb: (event: unknown) => void): void;
    removeEventListener(type: string, cb: (event: unknown) => void): void;
    dispatch(type: string, event: unknown): void;
    setTimeout: ManualTimers['setTimeout'];
    clearTimeout: ManualTimers['clearTimeout'];
    setInterval: ManualTimers['setInterval'];
    clearInterval: ManualTimers['clearInterval'];
}

interface Harness {
    win: FakeWindow;
    timers: ManualTimers;
    iframe: FakeIframe;
    adapter: YouTubeIframeAdapter;
    onReady: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    commands(): { func: string; args: unknown[] }[];
    deliver(data: unknown): void;
    fireIframeLoad(): void;
    deliverState(state: number): void;
    deliverInfo(info: Record<string, unknown>): void;
}

function makeHarness(): Harness {
    const timers = new ManualTimers();
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const win: FakeWindow = {
        listeners,
        addEventListener(type, cb) {
            let set = listeners.get(type);
            if (!set) {
                set = new Set();
                listeners.set(type, set);
            }
            set.add(cb);
        },
        removeEventListener(type, cb) {
            listeners.get(type)?.delete(cb);
        },
        dispatch(type, event) {
            listeners.get(type)?.forEach(cb => cb(event));
        },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
    };
    vi.stubGlobal('window', win);
    const contentWindow = { postMessage: vi.fn() };
    const iframe: FakeIframe = {
        src: '',
        contentWindow,
        ownerDocument: { defaultView: win },
        listeners: {},
        addEventListener(event, cb) {
            iframe.listeners[event] = cb;
        },
    };
    const onReady = vi.fn();
    const onError = vi.fn();
    const adapter = new YouTubeIframeAdapter(
        iframe as unknown as HTMLIFrameElement,
        'videoA000000',
        onReady,
        onError,
    );
    const commands = () => contentWindow.postMessage.mock.calls
        .map(call => JSON.parse(call[0] as string) as { event: string; func: string; args: unknown[] })
        .filter(msg => msg.event === 'command')
        .map(msg => ({ func: msg.func, args: msg.args }));
    return {
        win,
        timers,
        iframe,
        adapter,
        onReady,
        onError,
        commands,
        deliver(data) {
            win.dispatch('message', { source: contentWindow, data: JSON.stringify(data) });
        },
        fireIframeLoad() {
            iframe.listeners.load?.();
        },
        deliverState(state) {
            this.deliver({ event: 'onStateChange', info: state });
        },
        deliverInfo(info) {
            this.deliver({ event: 'infoDelivery', info });
        },
    };
}

const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

async function readyAdapter(): Promise<Harness> {
    const h = makeHarness();
    h.fireIframeLoad();
    h.deliver({ event: 'onReady' });
    expect(h.onReady).toHaveBeenCalledTimes(1);
    await h.timers.pump(0);
    return h;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('YouTubeIframeAdapter command dispatch', () => {
    it('does not post commands after destroy', async () => {
        const h = await readyAdapter();
        h.adapter.destroy();
        const before = h.iframe.contentWindow.postMessage.mock.calls.length;
        await h.adapter.play();
        await h.adapter.pause();
        await h.adapter.seek(10);
        expect(h.iframe.contentWindow.postMessage.mock.calls.length).toBe(before);
    });
});

describe('YouTubeIframeAdapter load cancellation', () => {
    it('loads, pauses autoplay, restores mute and resolves', async () => {
        const h = await readyAdapter();
        const pending = h.adapter.loadVideo('videoB000000');
        await h.timers.pump(0);
        h.deliverState(STATE.PLAYING);
        await h.timers.pump(150);
        await expect(pending).resolves.toBeUndefined();
        const funcs = h.commands().map(c => c.func);
        expect(h.commands()).toContainEqual({ func: 'loadVideoById', args: ['videoB000000'] });
        expect(funcs).toContain('mute');
        expect(funcs).toContain('pauseVideo');
        expect(funcs).toContain('unMute');
    });

    it('a newer load settles the earlier load without stale commands', async () => {
        const h = await readyAdapter();
        const first = h.adapter.loadVideo('videoB000000');
        await h.timers.pump(0);
        const second = h.adapter.loadVideo('videoC000000');
        await expect(first).resolves.toBeUndefined();
        await h.timers.pump(0);
        h.deliverState(STATE.PLAYING);
        await h.timers.pump(150);
        await expect(second).resolves.toBeUndefined();
        const loads = h.commands().filter(c => c.func === 'loadVideoById');
        expect(loads).toContainEqual({ func: 'loadVideoById', args: ['videoB000000'] });
        expect(loads).toContainEqual({ func: 'loadVideoById', args: ['videoC000000'] });
        expect(h.commands().filter(c => c.func === 'pauseVideo')).toHaveLength(1);
    });

    it('destroy settles a pending load and suppresses late pause', async () => {
        const h = await readyAdapter();
        const pending = h.adapter.loadVideo('videoB000000');
        h.adapter.destroy();
        await expect(pending).resolves.toBeUndefined();
        const before = h.iframe.contentWindow.postMessage.mock.calls.length;
        await h.timers.pump(200);
        expect(h.iframe.contentWindow.postMessage.mock.calls.length).toBe(before);
    });
});

describe('YouTubeIframeAdapter seek suppression', () => {
    it('retries the seek when verification shows a stale position', async () => {
        const h = await readyAdapter();
        h.deliverState(STATE.PAUSED);
        const pending = h.adapter.seek(30);
        await h.timers.pump(0);
        expect(h.commands().filter(c => c.func === 'seekTo')).toHaveLength(1);
        h.deliverInfo({ currentTime: 99 });
        await h.timers.pump(250);
        await pending;
        expect(h.commands().filter(c => c.func === 'seekTo')).toHaveLength(2);
    });

    it('suppresses the verification retry after destroy', async () => {
        const h = await readyAdapter();
        h.deliverState(STATE.PAUSED);
        const pending = h.adapter.seek(30);
        await h.timers.pump(0);
        h.deliverInfo({ currentTime: 99 });
        h.adapter.destroy();
        await h.timers.pump(250);
        await pending;
        expect(h.commands().filter(c => c.func === 'seekTo')).toHaveLength(1);
    });

    it('suppresses the verification retry after a newer load', async () => {
        const h = await readyAdapter();
        h.deliverState(STATE.PAUSED);
        const pending = h.adapter.seek(30);
        await h.timers.pump(0);
        h.deliverInfo({ currentTime: 99 });
        const load = h.adapter.loadVideo('videoB000000');
        await h.timers.pump(250);
        await pending;
        expect(h.commands().filter(c => c.func === 'seekTo')).toHaveLength(1);
        h.adapter.destroy();
        await load;
    });

    it('a seek whose guard is invalidated mid-wait issues no commands', async () => {
        const h = await readyAdapter();
        h.deliverState(STATE.BUFFERING);
        let valid = true;
        const pending = h.adapter.seek(30, () => valid);
        await h.timers.pump(50);
        valid = false;
        h.deliverState(STATE.PAUSED);
        await h.timers.pump(1200);
        await pending;
        expect(h.commands().filter(c => c.func === 'seekTo')).toHaveLength(0);
    });

    it('a stale seek started before a load issues no commands', async () => {
        const h = await readyAdapter();
        h.deliverState(STATE.BUFFERING);
        const pending = h.adapter.seek(30);
        const load = h.adapter.loadVideo('videoB000000');
        await h.timers.pump(1200);
        await pending;
        expect(h.commands().filter(c => c.func === 'seekTo')).toHaveLength(0);
        h.adapter.destroy();
        await load;
    });
});

describe('YouTubeIframeAdapter seekAndPause auto-pause', () => {
    async function armedAutoPause(h: Harness, isValid?: () => boolean) {
        h.deliverState(STATE.CUED);
        const pending = h.adapter.seekAndPause(42, isValid);
        await h.timers.pump(250);
        return { pending };
    }

    it('pauses and re-seeks when the player reaches PLAYING', async () => {
        const h = await readyAdapter();
        const { pending } = await armedAutoPause(h);
        h.deliverState(STATE.PLAYING);
        await pending;
        const funcs = h.commands().map(c => c.func);
        expect(funcs.filter(f => f === 'pauseVideo')).toHaveLength(1);
        expect(h.commands()).toContainEqual({ func: 'seekTo', args: [42, true] });
        expect(funcs[funcs.length - 1]).toBe('unMute');
    });

    it('destroy resolves the pending auto-pause and stops commands', async () => {
        const h = await readyAdapter();
        const { pending } = await armedAutoPause(h);
        h.adapter.destroy();
        await expect(pending).resolves.toBeUndefined();
        const before = h.iframe.contentWindow.postMessage.mock.calls.length;
        await h.timers.pump(250);
        expect(h.iframe.contentWindow.postMessage.mock.calls.length).toBe(before);
        const funcs = h.commands().map(c => c.func);
        expect(funcs).toContain('mute');
        expect(funcs).not.toContain('pauseVideo');
    });

    it('a newer load resolves the pending auto-pause and late PLAYING pauses nothing extra', async () => {
        const h = await readyAdapter();
        const { pending } = await armedAutoPause(h);
        const load = h.adapter.loadVideo('videoB000000');
        await expect(pending).resolves.toBeUndefined();
        expect(h.commands().map(c => c.func)).toContain('unMute');
        h.deliverState(STATE.PLAYING);
        await h.timers.pump(150);
        await load;
        expect(h.commands().filter(c => c.func === 'pauseVideo')).toHaveLength(1);
    });

    it('a superseding seekAndPause resolves the earlier pending auto-pause', async () => {
        const h = await readyAdapter();
        h.deliverState(STATE.CUED);
        const first = h.adapter.seekAndPause(10);
        await h.timers.pump(250);
        const second = h.adapter.seekAndPause(20);
        await h.timers.pump(250);
        await expect(first).resolves.toBeUndefined();
        h.deliverState(STATE.PLAYING);
        await second;
        const seeks = h.commands().filter(c => c.func === 'seekTo');
        expect(seeks.filter(c => c.args[0] === 10)).toHaveLength(1);
        expect(h.commands().map(c => c.func).filter(f => f === 'pauseVideo')).toHaveLength(1);
    });

    it('an invalidated guard resolves the pending auto-pause without pause commands', async () => {
        const h = await readyAdapter();
        let valid = true;
        const { pending } = await armedAutoPause(h, () => valid);
        valid = false;
        h.deliverState(STATE.PLAYING);
        await pending;
        expect(h.commands().map(c => c.func)).not.toContain('pauseVideo');
    });
});
