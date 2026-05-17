import { PlayerAdapter } from "./types";

const YT_STATE = {
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2,
    BUFFERING: 3,
    CUED: 5,
} as const;

const NOCOOKIE_ORIGIN = 'https://www.youtube-nocookie.com';

interface YTMessageEvent {
    event?: string;
    info?: number | YTInfoPayload;
}

interface YTInfoPayload {
    currentTime?: number;
    duration?: number;
    playerState?: number;
    muted?: boolean;
}

export class YouTubeIframeAdapter implements PlayerAdapter {
    private iframeElement: HTMLIFrameElement;
    private videoId: string;
    private onReadyCallback: () => void;
    private onErrorCallback: ((errorCode: number) => void) | undefined;
    private destroyed: boolean = false;
    private ready: boolean = false;
    private ownerWindow: Window;

    // Cached state updated via infoDelivery / onStateChange messages
    private cachedCurrentTime: number = 0;
    private cachedDuration: number = 0;
    private cachedPlayerState: number = YT_STATE.UNSTARTED;
    private cachedMuted: boolean = false;

    private boundMessageHandler: (event: MessageEvent) => void;
    private pendingLoadErrorHandler: ((errorCode: number) => void) | null = null;
    private pendingAutoPause: {
        timestamp: number;
        resolve: () => void;
        timeoutId: number;
        restoreMute: boolean;
    } | null = null;

    constructor(iframeElement: HTMLIFrameElement, videoId: string, onReady: () => void, onError?: (errorCode: number) => void) {
        this.iframeElement = iframeElement;
        this.videoId = videoId;
        this.onReadyCallback = onReady;
        this.onErrorCallback = onError;
        this.ownerWindow = iframeElement.ownerDocument.defaultView ?? window;

        this.boundMessageHandler = this.handleMessage.bind(this);
        this.ownerWindow.addEventListener('message', this.boundMessageHandler);

        // Set the src so the iframe actually loads the video
        // Using youtube-nocookie.com prevents doubleclick ad tracking scripts from trying to load and failing in Obsidian
        iframeElement.src = `${NOCOOKIE_ORIGIN}/embed/${videoId}?enablejsapi=1`;

        // The YouTube iframe player requires the parent to register via a
        // "listening" event before it begins dispatching onReady / onStateChange
        // / infoDelivery messages back.  Send it once the iframe document loads.
        iframeElement.addEventListener('load', this.onIframeLoad, { once: true });
    }

    private onIframeLoad = (): void => {
        if (this.destroyed) return;
        const win = this.iframeElement.contentWindow;
        if (!win) return;
        win.postMessage(JSON.stringify({ event: 'listening', id: 1 }), NOCOOKIE_ORIGIN);
    };

    private sendCommand(func: string, args: unknown[] = []): void {
        const win = this.iframeElement.contentWindow;
        if (!win) return;
        win.postMessage(JSON.stringify({ event: 'command', func, args }), NOCOOKIE_ORIGIN);
    }

    private handleMessage(event: MessageEvent): void {
        // event.source may be null for cross-origin iframes in some Electron
        // contexts; fall back to origin check when source is unavailable.
        const sourceOk = event.source != null
            ? event.source === this.iframeElement.contentWindow
            : event.origin === NOCOOKIE_ORIGIN;
        if (!sourceOk) return;
        if (this.destroyed) return;

        let data: YTMessageEvent;
        try {
            data = typeof event.data === 'string'
                ? (JSON.parse(event.data) as YTMessageEvent)
                : (event.data as YTMessageEvent);
        } catch {
            return;
        }

        switch (data.event) {
            case 'onReady':
                console.debug('[PlayerAdapter] Player ready for video:', this.videoId);
                this.ready = true;
                this.onReadyCallback();
                break;

            case 'onStateChange': {
                const state = data.info as number;
                this.cachedPlayerState = state;
                this.handleStateChange(state);
                break;
            }

            case 'infoDelivery':
            case 'initialDelivery': {
                const info = data.info as YTInfoPayload | undefined;
                if (info && typeof info === 'object') {
                    if (typeof info.currentTime === 'number') this.cachedCurrentTime = info.currentTime;
                    if (typeof info.duration === 'number' && info.duration > 0) this.cachedDuration = info.duration;
                    if (typeof info.playerState === 'number') this.cachedPlayerState = info.playerState;
                    if (typeof info.muted === 'boolean') this.cachedMuted = info.muted;
                }
                break;
            }

            case 'onError': {
                const errorCode = typeof data.info === 'number' ? data.info : -1;
                console.error('[PlayerAdapter] Player error for video:', this.videoId, 'Error code:', errorCode);

                if (this.pendingLoadErrorHandler) {
                    const handler = this.pendingLoadErrorHandler;
                    this.pendingLoadErrorHandler = null;
                    handler(errorCode);
                    return;
                }

                // Error codes: 2 = invalid ID, 5 = HTML5 player error, 100 = video not found, 101/150 = embedding not allowed
                if (this.onErrorCallback) {
                    this.onErrorCallback(errorCode);
                }
                break;
            }
        }
    }

    isReady(): boolean {
        return this.ready;
    }

    private async waitForReady(timeoutMs: number = 5000): Promise<boolean> {
        if (this.isReady()) return true;

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isReady()) {
                return true;
            }
            await new Promise(r => window.setTimeout(r, 50));
        }

        return this.isReady();
    }

    async loadVideo(videoId: string): Promise<void> {
        const isReady = await this.waitForReady();
        if (!isReady) {
            console.warn('[PlayerAdapter] Cannot load video - player not ready after waiting');
            return;
        }

        console.debug('[PlayerAdapter] Loading new video:', videoId);
        this.videoId = videoId;
        this.ready = false;
        // Reset to a state not matched by the poll below so we don't finish
        // on a stale value from the previous video.
        this.cachedPlayerState = YT_STATE.CUED;
        this.cachedDuration = 0;

        return new Promise((resolve, reject) => {
            let settled = false;
            const wasMuted = this.cachedMuted;

            const finish = () => {
                if (settled) return;
                settled = true;
                this.pendingLoadErrorHandler = null;
                if (!wasMuted) this.sendCommand('unMute');
                this.ready = true;
                resolve();
            };

            const fail = (errorCode: number) => {
                if (settled) return;
                settled = true;
                this.pendingLoadErrorHandler = null;
                if (!wasMuted) this.sendCommand('unMute');
                this.ready = true;
                reject(new Error(String(errorCode)));
            };

            this.pendingLoadErrorHandler = (errorCode: number) => {
                window.clearInterval(checkReady);
                window.clearTimeout(loadTimeout);
                fail(errorCode);
            };

            // Mute before starting playback to avoid audio flash.
            if (!wasMuted) this.sendCommand('mute');

            // loadVideoById starts playback, which triggers onError (101/150) for
            // embedding-blocked videos via postMessage. cueVideoById does NOT fire
            // that error, so we must use loadVideoById for reliable detection.
            this.sendCommand('loadVideoById', [videoId]);

            const checkReady = window.setInterval(() => {
                const state = this.cachedPlayerState;
                if (state === YT_STATE.PLAYING) {
                    // Video started — not blocked. Pause immediately and finish.
                    this.sendCommand('pauseVideo');
                    window.clearInterval(checkReady);
                    window.clearTimeout(loadTimeout);
                    console.debug('[PlayerAdapter] Video loaded and ready:', videoId);
                    finish();
                } else if (state === YT_STATE.PAUSED || state === YT_STATE.ENDED) {
                    window.clearInterval(checkReady);
                    window.clearTimeout(loadTimeout);
                    console.debug('[PlayerAdapter] Video loaded and ready:', videoId);
                    finish();
                }
            }, 100);

            // Timeout after 5 seconds
            const loadTimeout = window.setTimeout(() => {
                window.clearInterval(checkReady);
                console.warn('[PlayerAdapter] Video load timeout, marking as ready anyway');
                finish();
            }, 5000);
        });
    }

    destroy(): void {
        this.destroyed = true;
        this.pendingLoadErrorHandler = null;
        this.ownerWindow.removeEventListener('message', this.boundMessageHandler);
        this.ready = false;
        console.debug('[PlayerAdapter] Destroyed player for video:', this.videoId);
    }

    async seek(timestampSec: number): Promise<void> {
        // Wait for player to be ready and in a valid state (not buffering)
        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts) {
            if (this.isReady()) {
                const state = await this.getPlayerState();
                // Valid states: -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 5 (cued)
                // Avoid seeking when buffering (3)
                if (state !== YT_STATE.BUFFERING) {
                    break;
                }
            }
            attempts++;
            await new Promise(r => window.setTimeout(r, 100));
        }

        if (!this.isReady()) {
            console.warn('[PlayerAdapter] Player not ready for seek after waiting');
            return;
        }

        try {
            console.debug('[PlayerAdapter] Seeking to:', timestampSec);
            this.sendCommand('seekTo', [timestampSec, true]);
            this.cachedCurrentTime = timestampSec;

            // Verify seek worked by checking current time after a short delay
            await new Promise(r => window.setTimeout(r, 200));
            const currentTime = await this.getCurrentTime();
            const seekDiff = Math.abs(currentTime - timestampSec);

            if (seekDiff > 2) {
                console.warn('[PlayerAdapter] Seek verification failed. Expected:', timestampSec, 'Got:', currentTime, 'Retrying...');
                this.sendCommand('seekTo', [timestampSec, true]);
                this.cachedCurrentTime = timestampSec;
            }
        } catch (err) {
            console.error('[PlayerAdapter] Error seeking to timestamp:', err);
        }
    }

    getCurrentTime(): Promise<number> {
        return Promise.resolve(this.cachedCurrentTime);
    }

    getDuration(): Promise<number> {
        return Promise.resolve(this.cachedDuration);
    }

    play(): Promise<void> {
        try {
            this.sendCommand('playVideo');
        } catch (err) {
            console.error('Error playing video:', err);
        }
        return Promise.resolve();
    }

    pause(): Promise<void> {
        try {
            this.sendCommand('pauseVideo');
        } catch (err) {
            console.error('Error pausing video:', err);
        }
        return Promise.resolve();
    }

    async seekAndPause(timestampSec: number): Promise<void> {
        await this.seek(timestampSec);
        if (!this.isReady()) return;

        const state = this.cachedPlayerState;

        // If video is already playing/buffering, pause immediately.
        if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) {
            this.sendCommand('pauseVideo');
            return;
        }

        // State ended or paused are safe to pause directly as well.
        if (state === YT_STATE.PAUSED || state === YT_STATE.ENDED) {
            this.sendCommand('pauseVideo');
            return;
        }

        // Unstarted / cued: wait for the player to actually start playing before pausing,
        // so we never call pauseVideo() while the iframe is still initializing (which
        // breaks controls on mobile WebViews).
        if (state === YT_STATE.UNSTARTED || state === YT_STATE.CUED) {
            await this.waitForAutoPause(timestampSec);
            return;
        }

        // Fallback
        this.sendCommand('pauseVideo');
    }

    getPlayerState(): Promise<number> {
        return Promise.resolve(this.cachedPlayerState);
    }

    private clearPendingAutoPause(resolve: boolean): void {
        if (!this.pendingAutoPause) return;
        const pending = this.pendingAutoPause;
        this.pendingAutoPause = null;
        window.clearTimeout(pending.timeoutId);
        if (pending.restoreMute) {
            this.sendCommand('unMute');
        }
        if (resolve) {
            pending.resolve();
        }
    }

    private async waitForAutoPause(timestampSec: number): Promise<void> {
        return new Promise<void>((resolve) => {
            this.clearPendingAutoPause(false);

            let restoreMute = false;
            if (!this.cachedMuted) {
                this.sendCommand('mute');
                restoreMute = true;
            }

            const timeoutId = window.setTimeout(() => {
                // If the player never transitioned to PLAYING, just clean up and resolve.
                if (this.pendingAutoPause?.timeoutId === timeoutId) {
                    this.clearPendingAutoPause(true);
                }
            }, 2000);

            this.pendingAutoPause = {
                timestamp: timestampSec,
                resolve,
                timeoutId,
                restoreMute,
            };
        });
    }

    private handleStateChange(state: number): void {
        if (!this.pendingAutoPause) return;

        const isPlayingState = state === YT_STATE.PLAYING;
        const isPausedState = state === YT_STATE.PAUSED || state === YT_STATE.ENDED;

        if (isPlayingState) {
            const target = this.pendingAutoPause;
            this.sendCommand('pauseVideo');
            // Ensure we stay exactly on the requested timestamp.
            this.sendCommand('seekTo', [target.timestamp, true]);
            this.clearPendingAutoPause(true);
        } else if (isPausedState) {
            this.clearPendingAutoPause(true);
        }
    }
}