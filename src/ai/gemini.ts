import { AIProviderError } from './types';
import type {
    AIAttachment,
    AIConversationRequest,
    AIConversationResponse,
    AIProvider,
    AIResponseMetadata,
    ConfiguredAIProviderId,
} from './types';
import {
    extractProviderErrorMessage,
    isRecord,
    isSuccessStatus,
    parseJsonResponse,
    sendAIRequest,
} from './request';
import type { AIRequestOptions } from './request';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MAX_OUTPUT_TOKENS = 8192;

export interface GeminiProviderConfig {
    apiKey: string | null;
    model: string;
    timeoutMs: number;
}

type GeminiPart =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } };

interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

export class GeminiProvider implements AIProvider {
    readonly id: ConfiguredAIProviderId = 'google';
    private readonly apiKey: string | null;
    private readonly model: string;
    private readonly timeoutMs: number;

    constructor(config: GeminiProviderConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.timeoutMs = config.timeoutMs;
    }

    async sendConversation(request: AIConversationRequest): Promise<AIConversationResponse> {
        const key = this.requireApiKey();
        const model = this.model.trim();
        if (!model) {
            throw new AIProviderError('invalid-config', 'Gemini model is not configured.');
        }

        const requestOptions: AIRequestOptions = {
            url: `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
            method: 'POST',
            headers: this.buildHeaders(key),
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: request.systemPrompt }] },
                contents: this.buildContents(request),
                generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
            }),
            timeoutMs: this.timeoutMs,
        };
        if (request.signal) {
            requestOptions.signal = request.signal;
        }
        const response = await sendAIRequest(requestOptions);
        const json = parseJsonResponse(response);
        if (!isSuccessStatus(response.status)) {
            throw new AIProviderError(
                'provider',
                extractProviderErrorMessage(json, `Gemini request failed (status ${response.status}).`),
                response.status,
            );
        }
        return this.parseResponse(json, model);
    }

    async listModels(signal?: AbortSignal): Promise<string[]> {
        const key = this.requireApiKey();

        const requestOptions: AIRequestOptions = {
            url: `${GEMINI_BASE_URL}/models`,
            headers: this.buildHeaders(key),
            timeoutMs: this.timeoutMs,
        };
        if (signal) {
            requestOptions.signal = signal;
        }
        const response = await sendAIRequest(requestOptions);
        const json = parseJsonResponse(response);
        if (!isSuccessStatus(response.status)) {
            throw new AIProviderError(
                'provider',
                extractProviderErrorMessage(json, `Gemini request failed (status ${response.status}).`),
                response.status,
            );
        }

        if (!isRecord(json) || !Array.isArray(json.models)) {
            throw new AIProviderError('invalid-response', 'Gemini returned an unexpected model list.');
        }
        const ids = new Set<string>();
        for (const entry of json.models) {
            if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) {
                continue;
            }
            const methods = entry.supportedGenerationMethods;
            if (!Array.isArray(methods) || !methods.includes('generateContent')) {
                continue;
            }
            ids.add(entry.name.replace(/^models\//, ''));
        }
        if (ids.size === 0) {
            throw new AIProviderError('invalid-response', 'Gemini returned no usable models.');
        }
        return [...ids].sort();
    }

    private requireApiKey(): string {
        const key = this.apiKey?.trim();
        if (!key) {
            throw new AIProviderError('missing-key', 'Gemini API key is not configured.');
        }
        return key;
    }

    private buildHeaders(key: string): Record<string, string> {
        return {
            'x-goog-api-key': key,
            'Content-Type': 'application/json',
        };
    }

    private buildContents(request: AIConversationRequest): GeminiContent[] {
        const attachments = request.attachments ?? [];
        let attachIndex = -1;
        request.messages.forEach((message, i) => {
            if (message.role === 'user') {
                attachIndex = i;
            }
        });
        if (attachments.length > 0 && attachIndex === -1) {
            throw new AIProviderError('invalid-config', 'Attachments require a user message to attach to.');
        }

        return request.messages.map((message, i) => {
            const parts: GeminiPart[] = [{ text: message.content }];
            if (i === attachIndex) {
                for (const attachment of attachments) {
                    parts.push(this.toInlineDataPart(attachment));
                }
            }
            return {
                role: message.role === 'assistant' ? 'model' : 'user',
                parts,
            };
        });
    }

    private toInlineDataPart(attachment: AIAttachment): GeminiPart {
        const mime = attachment.mimeType.trim().toLowerCase();
        if (!attachment.data) {
            throw new AIProviderError(
                'invalid-config',
                `Gemini requires base64 attachment data; URL attachments are not supported (${attachment.name ?? attachment.mimeType}).`,
            );
        }
        if (!mime.startsWith('image/') && mime !== 'application/pdf') {
            throw new AIProviderError(
                'invalid-config',
                `Gemini does not support attachments of type '${attachment.mimeType}'; only images and PDFs are supported.`,
            );
        }
        return { inlineData: { mimeType: attachment.mimeType, data: attachment.data } };
    }

    private parseResponse(json: unknown, model: string): AIConversationResponse {
        if (!isRecord(json) || !Array.isArray(json.candidates) || json.candidates.length === 0) {
            throw new AIProviderError('invalid-response', 'Gemini returned an unexpected response (missing candidates).');
        }
        const candidate: unknown = json.candidates[0];
        if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
            throw new AIProviderError('invalid-response', 'Gemini returned an unexpected response (missing content).');
        }
        const texts: string[] = [];
        for (const part of candidate.content.parts) {
            if (isRecord(part) && typeof part.text === 'string') {
                texts.push(part.text);
            }
        }
        if (texts.length === 0) {
            throw new AIProviderError('invalid-response', 'Gemini returned an unexpected response (no text content).');
        }

        const metadata: AIResponseMetadata = { model };
        if (isRecord(json.usageMetadata)) {
            if (typeof json.usageMetadata.promptTokenCount === 'number') {
                metadata.inputTokens = json.usageMetadata.promptTokenCount;
            }
            if (typeof json.usageMetadata.candidatesTokenCount === 'number') {
                metadata.outputTokens = json.usageMetadata.candidatesTokenCount;
            }
            if (typeof json.usageMetadata.totalTokenCount === 'number') {
                metadata.totalTokens = json.usageMetadata.totalTokenCount;
            }
        }
        if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
            metadata.finishReason = candidate.finishReason;
        }

        return { content: texts.join('\n'), metadata };
    }
}
