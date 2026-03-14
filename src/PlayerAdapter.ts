import { PlayerAdapter, YTPlayer } from "./types";


export class YouTubeIframeAdapter implements PlayerAdapter {
    private player: YTPlayer | null = null;
    private ready: boolean = false;
    private destroyed: boolean = false;
    private iframeElement: HTMLIFrameElement;
    private videoId: string;
    private onReadyCallback: () => void;
    private onErrorCallback: ((errorCode: number) => void) | undefined;
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

        // Set the src so the iframe actually loads the video
        // Using youtube-nocookie.com prevents doubleclick ad tracking scripts from trying to load and failing in Obsidian
        iframeElement.src = `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1`;

        void this.initPlayer();
    }

    private async initPlayer(): Promise<void> {
        // Wait for the YouTube API to be ready, but don't hang forever if the
        // script never loads (e.g. no internet).  The view-level timeout will
        // surface the error; on the next video click a fresh adapter gets
        // another chance once the script has (hopefully) loaded.
        const apiReady = await Promise.race([
            window.youtubeAPIPromise,
            new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 10000)),
        ]);
        if (this.destroyed) return;
        if (apiReady === 'timeout') {
            console.warn('[PlayerAdapter] Timed out waiting for YouTube API');
            return;
        }
        this.createPlayer();
    }

    private createPlayer(): void {
        if (!window.YT || typeof window.YT.Player !== 'function') {
            console.error('[PlayerAdapter] YouTube API not available');
            return;
        }
        console.debug('[PlayerAdapter] Creating YouTube player for video:', this.videoId);
        this.player = new window.YT.Player(this.iframeElement, {
            events: { 
                'onReady': () => {
                    console.debug('[PlayerAdapter] Player ready for video:', this.videoId);
                    this.ready = true;
                    this.onReadyCallback();
                },
                'onError': (event: { data: number }) => {
                    const rawErrorCode = event?.data;
                    const parsedErrorCode = typeof rawErrorCode === 'number' ? rawErrorCode : Number(rawErrorCode);
                    const errorCode = Number.isFinite(parsedErrorCode) ? parsedErrorCode : -1;
                    console.error('[PlayerAdapter] Player error for video:', this.videoId, 'Error code:', errorCode);

                    if (this.pendingLoadErrorHandler) {
                        const handlePendingError = this.pendingLoadErrorHandler;
                        this.pendingLoadErrorHandler = null;
                        handlePendingError(errorCode);
                        return;
                    }

                    // Error codes: 2 = invalid ID, 5 = HTML5 player error, 100 = video not found, 101/150 = embedding not allowed
                    if (this.onErrorCallback) {
                        this.onErrorCallback(errorCode);
                    }
                },
                'onStateChange': (event: { data: number }) => {
                    this.handleStateChange(event?.data);
                }
            }
        });
    }

    isReady(): boolean {
        return this.ready && this.player !== null && typeof this.player.seekTo === 'function';
    }

    private async waitForReady(timeoutMs: number = 5000): Promise<boolean> {
        if (this.isReady()) return true;

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isReady()) {
                return true;
            }
            await new Promise(r => setTimeout(r, 50));
        }

        return this.isReady();
    }

    async loadVideo(videoId: string): Promise<void> {
        const isReady = await this.waitForReady();
        if (!this.player || !isReady) {
            console.warn('[PlayerAdapter] Cannot load video - player not ready after waiting');
            return;
        }
        
        console.debug('[PlayerAdapter] Loading new video:', videoId);
        this.videoId = videoId;
        this.ready = false;
        
        return new Promise((resolve, reject) => {
            let settled = false;

            const finish = () => {
                if (settled) return;
                settled = true;
                this.pendingLoadErrorHandler = null;
                this.ready = true;
                resolve();
            };

            const fail = (errorCode: number) => {
                if (settled) return;
                settled = true;
                this.pendingLoadErrorHandler = null;
                this.ready = true;
                reject(new Error(String(errorCode)));
            };

            this.pendingLoadErrorHandler = (errorCode: number) => {
                clearInterval(checkReady);
                clearTimeout(loadTimeout);
                fail(errorCode);
            };

            // Use cueVideoById to load without autoplay
            this.player!.cueVideoById(videoId);
            
            // Wait for the video to be cued and ready
            const checkReady = setInterval(() => {
                if (this.player && typeof this.player.getPlayerState === 'function') {
                    const state = this.player.getPlayerState();
                    // State 5 = video cued, -1 = unstarted (both mean ready)
                    if (state === 5 || state === -1 || state === 2) {
                        clearInterval(checkReady);
                        clearTimeout(loadTimeout);
                        console.debug('[PlayerAdapter] Video loaded and ready:', videoId);
                        finish();
                    }
                }
            }, 100);
            
            // Timeout after 5 seconds
            const loadTimeout = setTimeout(() => {
                clearInterval(checkReady);
                console.warn('[PlayerAdapter] Video load timeout, marking as ready anyway');
                finish();
            }, 5000);
        });
    }

    destroy(): void {
        this.destroyed = true;
        this.pendingLoadErrorHandler = null;
        if (this.player && typeof this.player.destroy === 'function') {
            console.debug('[PlayerAdapter] Destroying player for video:', this.videoId);
            try {
                this.player.destroy();
            } catch (err) {
                console.warn('[PlayerAdapter] Error destroying player:', err);
            }
        }
        this.player = null;
        this.ready = false;
    }

    async seek(timestampSec: number): Promise<void> {
        // Wait for player to be ready and in a valid state (not buffering)
        let attempts = 0;
        const maxAttempts = 10;
        
        while (attempts < maxAttempts) {
            if (this.isReady()) {
                const state = await this.getPlayerState();
                // Valid states: -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 5 (cued)
                // Avoid seeking when buffering (3) or video cued but not ready
                if (state !== 3) {
                    break;
                }
            }
            attempts++;
            await new Promise(r => setTimeout(r, 100));
        }

        if (!this.isReady()) {
            console.warn('[PlayerAdapter] Player not ready for seek after waiting');
            return;
        }

        try {
            console.debug('[PlayerAdapter] Seeking to:', timestampSec);
            this.player!.seekTo(timestampSec, true);
            
            // Verify seek worked by checking current time after a short delay
            await new Promise(r => setTimeout(r, 200));
            const currentTime = await this.getCurrentTime();
            const seekDiff = Math.abs(currentTime - timestampSec);
            
            if (seekDiff > 2) {
                console.warn('[PlayerAdapter] Seek verification failed. Expected:', timestampSec, 'Got:', currentTime, 'Retrying...');
                // Retry once
                this.player!.seekTo(timestampSec, true);
            }
        } catch (err) {
            console.error('[PlayerAdapter] Error seeking to timestamp:', err);
        }
    }
    getCurrentTime(): Promise<number> {
        if (!this.isReady()) return Promise.resolve(0);
        try {
            return Promise.resolve(this.player!.getCurrentTime() || 0);
        } catch (err) {
            console.warn('Error getting current time:', err);
            return Promise.resolve(0);
        }
    }
    getDuration(): Promise<number> {
        if (!this.isReady()) return Promise.resolve(0);
        try {
            return Promise.resolve(this.player!.getDuration() || 0);
        } catch (err) {
            console.warn('Error getting duration:', err);
            return Promise.resolve(0);
        }
    }
    play(): Promise<void> {
        if (!this.isReady()) return Promise.resolve();
        try {
            this.player!.playVideo();
        } catch (err) {
            console.error('Error playing video:', err);
        }
        return Promise.resolve();
    }
    pause(): Promise<void> {
        if (!this.isReady()) return Promise.resolve();
        try {
            this.player!.pauseVideo();
        } catch (err) {
            console.error('Error pausing video:', err);
        }
        return Promise.resolve();
    }
    async seekAndPause(timestampSec: number): Promise<void> {
        await this.seek(timestampSec);
        if (!this.isReady()) return;

        const state = this.safeGetPlayerState();

        // If video is already playing/buffering, pause immediately.
        if (state === window.YT?.PlayerState?.PLAYING || state === window.YT?.PlayerState?.BUFFERING || state === 1 || state === 3) {
            this.player!.pauseVideo();
            return;
        }

        // State 0 (ended) or 2 (paused) are safe to pause directly as well.
        if (state === window.YT?.PlayerState?.PAUSED || state === window.YT?.PlayerState?.ENDED || state === 0 || state === 2) {
            this.player!.pauseVideo();
            return;
        }

        // Unstarted / cued: wait for the player to actually start playing before pausing,
        // so we never call pauseVideo() while the iframe is still initializing (which
        // breaks controls on mobile WebViews).
        if (state === window.YT?.PlayerState?.UNSTARTED || state === window.YT?.PlayerState?.CUED || state === -1 || state === 5) {
            await this.waitForAutoPause(timestampSec);
            return;
        }

        // Fallback
        this.player!.pauseVideo();
    }
    
    getPlayerState(): Promise<number> {
        if (!this.isReady()) return Promise.resolve(-1);
        try {
            return Promise.resolve(this.player!.getPlayerState());
        } catch (err) {
            console.error('Error getting player state:', err);
            return Promise.resolve(-1);
        }
    }

    private safeGetPlayerState(): number {
        try {
            if (this.player && typeof this.player.getPlayerState === 'function') {
                return this.player.getPlayerState();
            }
        } catch (err) {
            console.error('Error getting player state:', err);
        }
        return -1;
    }

    private clearPendingAutoPause(resolve: boolean): void {
        if (!this.pendingAutoPause) return;
        const pending = this.pendingAutoPause;
        this.pendingAutoPause = null;
        if (pending.timeoutId) {
            window.clearTimeout(pending.timeoutId);
        }
        if (pending.restoreMute && this.player && typeof this.player.unMute === 'function') {
            this.player.unMute();
        }
        if (resolve) {
            pending.resolve();
        }
    }

    private async waitForAutoPause(timestampSec: number): Promise<void> {
        return new Promise<void>((resolve) => {
            this.clearPendingAutoPause(false);

            let restoreMute = false;
            if (typeof this.player?.isMuted === 'function' && typeof this.player?.mute === 'function') {
                try {
                    if (!this.player.isMuted()) {
                        this.player.mute();
                        restoreMute = true;
                    }
                } catch (err) {
                    console.error('Error muting player:', err);
                    restoreMute = false;
                }
            }

            const timeoutId = window.setTimeout(() => {
                // If the player never transitioned to PLAYING, just clean up and resolve.
                if (this.pendingAutoPause && this.pendingAutoPause.timeoutId === timeoutId) {
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

        const yt = window.YT?.PlayerState;
        const isPlayingState = state === yt?.PLAYING || state === 1;
        const isPausedState = state === yt?.PAUSED || state === yt?.ENDED || state === 0 || state === 2;

        if (isPlayingState) {
            const target = this.pendingAutoPause;
            this.player!.pauseVideo();
            // Ensure we stay exactly on the requested timestamp.
            this.player!.seekTo(target.timestamp, true);
            this.clearPendingAutoPause(true);
        } else if (isPausedState) {
            this.clearPendingAutoPause(true);
        }
    }
}