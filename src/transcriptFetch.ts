import { requestUrl } from 'obsidian';
import { CaptionTrack, TranscriptEntry } from './types';
import {
    buildTranscriptUrl,
    extractCaptionTracks,
    getPlayabilityError,
    parseJson3Transcript,
    sortCaptionTracks,
} from './transcript';

const TRANSCRIPT_REQUEST_TIMEOUT_MS = 15000;
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CLIENT_NAME = '3';
const INNERTUBE_CLIENT_VERSION = '20.10.38';

function withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('Transcript request timed out')), TRANSCRIPT_REQUEST_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]);
}

/**
 * Fetches the caption track list for a video via YouTube's InnerTube API
 * (no API key required). Throws with a user-readable message on failure.
 */
export async function fetchCaptionTracks(ytId: string): Promise<CaptionTrack[]> {
    const response = await withTimeout(requestUrl({
        url: INNERTUBE_PLAYER_URL,
        method: 'POST',
        throw: false,
        headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': INNERTUBE_CLIENT_NAME,
            'X-YouTube-Client-Version': INNERTUBE_CLIENT_VERSION,
        },
        body: JSON.stringify({
            context: {
                client: {
                    clientName: 'ANDROID',
                    clientVersion: INNERTUBE_CLIENT_VERSION,
                    hl: 'en',
                    gl: 'US',
                },
            },
            videoId: ytId,
        }),
    }));

    if (response.status !== 200) {
        throw new Error(`YouTube request failed (status ${response.status})`);
    }

    const playabilityError = getPlayabilityError(response.json);
    if (playabilityError) {
        throw new Error(playabilityError);
    }

    return sortCaptionTracks(extractCaptionTracks(response.json));
}

/** Fetches and parses a single caption track. */
export async function fetchTranscriptEntries(track: CaptionTrack): Promise<TranscriptEntry[]> {
    const response = await withTimeout(requestUrl({
        url: buildTranscriptUrl(track.baseUrl),
        throw: false,
    }));

    if (response.status !== 200) {
        throw new Error(`Caption track request failed (status ${response.status})`);
    }

    return parseJson3Transcript(response.json);
}
