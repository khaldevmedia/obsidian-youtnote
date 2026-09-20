import { requestUrl } from 'obsidian';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { AIProviderError } from './types';

export interface AIRequestOptions {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

export function sendAIRequest(options: AIRequestOptions): Promise<RequestUrlResponse> {
    const signal = options.signal;
    if (signal?.aborted) {
        return Promise.reject(new AIProviderError('cancelled', 'The request was cancelled.'));
    }

    const request: RequestUrlParam = { url: options.url, throw: false };
    if (options.method) request.method = options.method;
    if (options.headers) request.headers = options.headers;
    if (options.body !== undefined) request.body = options.body;

    return new Promise<RequestUrlResponse>((resolve, reject) => {
        let settled = false;
        let timer: number | null = null;

        function cleanup(): void {
            if (timer !== null) {
                window.clearTimeout(timer);
                timer = null;
            }
            signal?.removeEventListener('abort', onAbort);
        }

        function settle(action: () => void): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            action();
        }

        function onAbort(): void {
            settle(() => reject(new AIProviderError('cancelled', 'The request was cancelled.')));
        }

        function onTimeout(): void {
            settle(() => reject(new AIProviderError('timeout', `The request timed out after ${options.timeoutMs} ms.`)));
        }

        if (options.timeoutMs > 0) {
            timer = window.setTimeout(onTimeout, options.timeoutMs);
        }
        signal?.addEventListener('abort', onAbort);

        let requestPromise: Promise<RequestUrlResponse>;
        try {
            requestPromise = requestUrl(request);
        } catch (error) {
            settle(() => reject(new AIProviderError(
                'network',
                `The request failed: ${error instanceof Error ? error.message : String(error)}`,
            )));
            return;
        }
        requestPromise.then(
            response => settle(() => resolve(response)),
            (error: unknown) => settle(() => reject(new AIProviderError(
                'network',
                `The request failed: ${error instanceof Error ? error.message : String(error)}`,
            ))),
        );
    });
}

export function parseJsonResponse(response: RequestUrlResponse): unknown {
    let json: unknown;
    try {
        json = response.json;
    } catch {
        json = undefined;
    }
    if (json !== undefined) {
        return json;
    }
    const text = typeof response.text === 'string' ? response.text : '';
    if (!text.trim()) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export function extractProviderErrorMessage(json: unknown, fallback: string): string {
    if (isRecord(json)) {
        const error = json.error;
        if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
            return error.message;
        }
        if (typeof error === 'string' && error.trim()) {
            return error;
        }
        if (typeof json.message === 'string' && json.message.trim()) {
            return json.message;
        }
    }
    return fallback;
}

export function isSuccessStatus(status: number): boolean {
    return status >= 200 && status < 300;
}
