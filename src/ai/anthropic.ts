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

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 8192;

export interface AnthropicProviderConfig {
    apiKey: string | null;
    model: string;
    timeoutMs: number;
}

type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export class AnthropicProvider implements AIProvider {
    readonly id: ConfiguredAIProviderId = 'anthropic';
    private readonly apiKey: string | null;
    private readonly model: string;
    private readonly timeoutMs: number;

    constructor(config: AnthropicProviderConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.timeoutMs = config.timeoutMs;
    }

    async sendConversation(request: AIConversationRequest): Promise<AIConversationResponse> {
        const key = this.requireApiKey();
        const model = this.model.trim();
        if (!model) {
            throw new AIProviderError('invalid-config', 'Anthropic model is not configured.');
        }

        const requestOptions: AIRequestOptions = {
            url: `${ANTHROPIC_BASE_URL}/messages`,
            method: 'POST',
            headers: this.buildHeaders(key),
            body: JSON.stringify({
                model,
                max_tokens: ANTHROPIC_MAX_TOKENS,
                system: request.systemPrompt,
                messages: this.buildMessages(request),
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
                extractProviderErrorMessage(json, `Anthropic request failed (status ${response.status}).`),
                response.status,
            );
        }
        return this.parseResponse(json);
    }

    async listModels(signal?: AbortSignal): Promise<string[]> {
        const key = this.requireApiKey();

        const requestOptions: AIRequestOptions = {
            url: `${ANTHROPIC_BASE_URL}/models`,
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
                extractProviderErrorMessage(json, `Anthropic request failed (status ${response.status}).`),
                response.status,
            );
        }

        if (!isRecord(json) || !Array.isArray(json.data)) {
            throw new AIProviderError('invalid-response', 'Anthropic returned an unexpected model list.');
        }
        const ids = new Set<string>();
        for (const entry of json.data) {
            if (isRecord(entry) && typeof entry.id === 'string' && entry.id.trim()) {
                ids.add(entry.id.trim());
            }
        }
        if (ids.size === 0) {
            throw new AIProviderError('invalid-response', 'Anthropic returned no usable models.');
        }
        return [...ids].sort();
    }

    private requireApiKey(): string {
        const key = this.apiKey?.trim();
        if (!key) {
            throw new AIProviderError('missing-key', 'Anthropic API key is not configured.');
        }
        return key;
    }

    private buildHeaders(key: string): Record<string, string> {
        return {
            'x-api-key': key,
            'anthropic-version': ANTHROPIC_VERSION,
            'Content-Type': 'application/json',
        };
    }

    private buildMessages(request: AIConversationRequest): AnthropicMessage[] {
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
            if (i === attachIndex && attachments.length > 0) {
                const blocks: AnthropicContentBlock[] = [{ type: 'text', text: message.content }];
                for (const attachment of attachments) {
                    blocks.push(this.toContentBlock(attachment));
                }
                return { role: message.role, content: blocks };
            }
            return { role: message.role, content: message.content };
        });
    }

    private toContentBlock(attachment: AIAttachment): AnthropicContentBlock {
        const mime = attachment.mimeType.trim().toLowerCase();
        if (!attachment.data) {
            throw new AIProviderError(
                'invalid-config',
                `Anthropic requires base64 attachment data; URL attachments are not supported (${attachment.name ?? attachment.mimeType}).`,
            );
        }
        if (mime.startsWith('image/')) {
            return {
                type: 'image',
                source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data },
            };
        }
        if (mime === 'application/pdf') {
            return {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: attachment.data },
            };
        }
        throw new AIProviderError(
            'invalid-config',
            `Anthropic does not support attachments of type '${attachment.mimeType}'; only images and PDFs are supported.`,
        );
    }

    private parseResponse(json: unknown): AIConversationResponse {
        if (!isRecord(json) || !Array.isArray(json.content)) {
            throw new AIProviderError('invalid-response', 'Anthropic returned an unexpected response (missing content).');
        }
        const texts: string[] = [];
        for (const block of json.content) {
            if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
                texts.push(block.text);
            }
        }
        if (texts.length === 0) {
            throw new AIProviderError('invalid-response', 'Anthropic returned an unexpected response (no text content).');
        }

        const metadata: AIResponseMetadata = {};
        if (isRecord(json.usage)) {
            const input = typeof json.usage.input_tokens === 'number' ? json.usage.input_tokens : undefined;
            const output = typeof json.usage.output_tokens === 'number' ? json.usage.output_tokens : undefined;
            if (input !== undefined) {
                metadata.inputTokens = input;
            }
            if (output !== undefined) {
                metadata.outputTokens = output;
            }
            if (input !== undefined && output !== undefined) {
                metadata.totalTokens = input + output;
            }
        }
        if (typeof json.model === 'string' && json.model) {
            metadata.model = json.model;
        }
        if (typeof json.stop_reason === 'string' && json.stop_reason) {
            metadata.finishReason = json.stop_reason;
        }

        const result: AIConversationResponse = { content: texts.join('\n') };
        if (Object.keys(metadata).length > 0) {
            result.metadata = metadata;
        }
        return result;
    }
}
