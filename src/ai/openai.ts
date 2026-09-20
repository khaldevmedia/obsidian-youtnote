import type { RequestUrlResponse } from 'obsidian';
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

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_COMPATIBLE_HINT = 'Check that the base URL points to an OpenAI-compatible API endpoint.';

export interface OpenAIProviderConfig {
    apiKey: string | null;
    model: string;
    timeoutMs: number;
}

export interface CustomOpenAIProviderConfig {
    baseUrl: string;
    apiKey: string | null;
    model: string;
    timeoutMs: number;
}

interface OpenAICompatibleContext {
    providerName: string;
    baseUrl: string;
    apiKey: string | null;
    model: string;
    timeoutMs: number;
    missingKeyMessage: string | null;
    malformedIsIncompatible: boolean;
}

type OpenAIContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

interface OpenAIChatMessage {
    role: string;
    content: string | OpenAIContentPart[];
}

function checkApiKey(ctx: OpenAICompatibleContext): void {
    if (ctx.missingKeyMessage !== null && !ctx.apiKey?.trim()) {
        throw new AIProviderError('missing-key', ctx.missingKeyMessage);
    }
}

function checkBaseUrl(ctx: OpenAICompatibleContext): void {
    let parsed: URL;
    try {
        parsed = new URL(ctx.baseUrl);
    } catch {
        throw new AIProviderError('invalid-config', `${ctx.providerName} base URL is not a valid URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AIProviderError('invalid-config', `${ctx.providerName} base URL must use http or https.`);
    }
}

function buildHeaders(ctx: OpenAICompatibleContext): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = ctx.apiKey?.trim();
    if (key) {
        headers.Authorization = `Bearer ${key}`;
    }
    return headers;
}

function toImagePart(attachment: AIAttachment, ctx: OpenAICompatibleContext): OpenAIContentPart {
    if (!attachment.mimeType.trim().toLowerCase().startsWith('image/')) {
        const name = attachment.name ? ` '${attachment.name}'` : '';
        throw new AIProviderError(
            'invalid-config',
            `${ctx.providerName} does not support attachment${name} of type '${attachment.mimeType}'; only image attachments are supported.`,
        );
    }
    const url = attachment.data
        ? `data:${attachment.mimeType};base64,${attachment.data}`
        : attachment.url;
    if (!url) {
        throw new AIProviderError('invalid-config', 'Attachment has neither base64 data nor a URL.');
    }
    return { type: 'image_url', image_url: { url } };
}

function lastUserMessageIndex(request: AIConversationRequest): number {
    let index = -1;
    request.messages.forEach((message, i) => {
        if (message.role === 'user') {
            index = i;
        }
    });
    return index;
}

function buildMessages(request: AIConversationRequest, ctx: OpenAICompatibleContext): OpenAIChatMessage[] {
    const attachments = request.attachments ?? [];
    const attachIndex = lastUserMessageIndex(request);
    if (attachments.length > 0 && attachIndex === -1) {
        throw new AIProviderError('invalid-config', 'Attachments require a user message to attach to.');
    }

    const messages: OpenAIChatMessage[] = [{ role: 'system', content: request.systemPrompt }];
    request.messages.forEach((message, i) => {
        if (i === attachIndex && attachments.length > 0) {
            const parts: OpenAIContentPart[] = [{ type: 'text', text: message.content }];
            for (const attachment of attachments) {
                parts.push(toImagePart(attachment, ctx));
            }
            messages.push({ role: 'user', content: parts });
        } else {
            messages.push({ role: message.role, content: message.content });
        }
    });
    return messages;
}

function malformedError(ctx: OpenAICompatibleContext, detail: string): AIProviderError {
    if (ctx.malformedIsIncompatible) {
        return new AIProviderError(
            'incompatible',
            `The endpoint returned an unexpected response (${detail}). ${OPENAI_COMPATIBLE_HINT}`,
        );
    }
    return new AIProviderError('invalid-response', `${ctx.providerName} returned an unexpected response (${detail}).`);
}

function extractTextContent(content: unknown): string | null {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const part of content) {
            if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
                texts.push(part.text);
            }
        }
        if (texts.length > 0) {
            return texts.join('\n');
        }
    }
    return null;
}

function parseChatCompletion(json: unknown, ctx: OpenAICompatibleContext): AIConversationResponse {
    if (!isRecord(json) || !Array.isArray(json.choices) || json.choices.length === 0) {
        throw malformedError(ctx, 'missing choices');
    }
    const choice: unknown = json.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message)) {
        throw malformedError(ctx, 'missing message');
    }
    const content = extractTextContent(choice.message.content);
    if (content === null) {
        throw malformedError(ctx, 'missing message content');
    }

    const metadata: AIResponseMetadata = {};
    if (isRecord(json.usage)) {
        if (typeof json.usage.prompt_tokens === 'number') {
            metadata.inputTokens = json.usage.prompt_tokens;
        }
        if (typeof json.usage.completion_tokens === 'number') {
            metadata.outputTokens = json.usage.completion_tokens;
        }
        if (typeof json.usage.total_tokens === 'number') {
            metadata.totalTokens = json.usage.total_tokens;
        }
    }
    if (typeof json.model === 'string' && json.model) {
        metadata.model = json.model;
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        metadata.finishReason = choice.finish_reason;
    }

    const result: AIConversationResponse = { content };
    if (Object.keys(metadata).length > 0) {
        result.metadata = metadata;
    }
    return result;
}

function parseModelList(json: unknown, ctx: OpenAICompatibleContext): string[] {
    if (!isRecord(json) || !Array.isArray(json.data)) {
        throw malformedError(ctx, 'unexpected model list');
    }
    const ids = new Set<string>();
    for (const entry of json.data) {
        if (isRecord(entry) && typeof entry.id === 'string' && entry.id.trim()) {
            ids.add(entry.id.trim());
        }
    }
    if (ids.size === 0) {
        throw malformedError(ctx, 'no usable models');
    }
    return [...ids].sort();
}

function throwForErrorStatus(response: RequestUrlResponse, json: unknown, ctx: OpenAICompatibleContext): void {
    if (ctx.malformedIsIncompatible && (json === undefined || response.status === 404 || response.status === 405)) {
        const detail = extractProviderErrorMessage(json, 'The endpoint returned a non-JSON response.');
        throw new AIProviderError(
            'incompatible',
            `The custom endpoint is not responding like an OpenAI-compatible API (status ${response.status}): ${detail} ${OPENAI_COMPATIBLE_HINT}`,
            response.status,
        );
    }
    throw new AIProviderError(
        'provider',
        extractProviderErrorMessage(json, `${ctx.providerName} request failed (status ${response.status}).`),
        response.status,
    );
}

async function sendConversation(
    ctx: OpenAICompatibleContext,
    request: AIConversationRequest,
): Promise<AIConversationResponse> {
    checkApiKey(ctx);
    checkBaseUrl(ctx);
    const model = ctx.model.trim();
    if (!model) {
        throw new AIProviderError('invalid-config', `${ctx.providerName} model is not configured.`);
    }

    const requestOptions: AIRequestOptions = {
        url: `${ctx.baseUrl}/chat/completions`,
        method: 'POST',
        headers: buildHeaders(ctx),
        body: JSON.stringify({ model, messages: buildMessages(request, ctx) }),
        timeoutMs: ctx.timeoutMs,
    };
    if (request.signal) {
        requestOptions.signal = request.signal;
    }
    const response = await sendAIRequest(requestOptions);
    const json = parseJsonResponse(response);
    if (!isSuccessStatus(response.status)) {
        throwForErrorStatus(response, json, ctx);
    }
    return parseChatCompletion(json, ctx);
}

async function listModels(ctx: OpenAICompatibleContext, signal?: AbortSignal): Promise<string[]> {
    checkApiKey(ctx);
    checkBaseUrl(ctx);

    const requestOptions: AIRequestOptions = {
        url: `${ctx.baseUrl}/models`,
        headers: buildHeaders(ctx),
        timeoutMs: ctx.timeoutMs,
    };
    if (signal) {
        requestOptions.signal = signal;
    }
    const response = await sendAIRequest(requestOptions);
    const json = parseJsonResponse(response);
    if (!isSuccessStatus(response.status)) {
        throwForErrorStatus(response, json, ctx);
    }
    return parseModelList(json, ctx);
}

export class OpenAIProvider implements AIProvider {
    readonly id: ConfiguredAIProviderId = 'openai';
    private readonly ctx: OpenAICompatibleContext;

    constructor(config: OpenAIProviderConfig) {
        this.ctx = {
            providerName: 'OpenAI',
            baseUrl: OPENAI_BASE_URL,
            apiKey: config.apiKey,
            model: config.model,
            timeoutMs: config.timeoutMs,
            missingKeyMessage: 'OpenAI API key is not configured.',
            malformedIsIncompatible: false,
        };
    }

    sendConversation(request: AIConversationRequest): Promise<AIConversationResponse> {
        return sendConversation(this.ctx, request);
    }

    listModels(signal?: AbortSignal): Promise<string[]> {
        return listModels(this.ctx, signal);
    }
}

export class CustomOpenAIProvider implements AIProvider {
    readonly id: ConfiguredAIProviderId = 'custom';
    private readonly ctx: OpenAICompatibleContext;

    constructor(config: CustomOpenAIProviderConfig) {
        this.ctx = {
            providerName: 'The custom provider',
            baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
            apiKey: config.apiKey,
            model: config.model,
            timeoutMs: config.timeoutMs,
            missingKeyMessage: null,
            malformedIsIncompatible: true,
        };
    }

    sendConversation(request: AIConversationRequest): Promise<AIConversationResponse> {
        return sendConversation(this.ctx, request);
    }

    listModels(signal?: AbortSignal): Promise<string[]> {
        return listModels(this.ctx, signal);
    }
}
