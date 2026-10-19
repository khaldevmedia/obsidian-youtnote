import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse, RequestUrlResponsePromise } from 'obsidian';
import { AIProviderError } from './types';
import type { AIConversationRequest } from './types';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { CustomOpenAIProvider, OpenAIProvider } from './openai';
import { createAIProvider, getAINoteGenerationSetupError } from './registry';
import { createAIProviderError, createCompatibleResponseSchema } from './request';
import {
    createYoutnoteNotesJsonSchema,
    generateNotesFromTranscript,
    YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT,
} from './notes';
import type { GenerateNotesOptions } from './notes';
import type { AISettings, TranscriptEntry } from '../types';

import { requestUrl } from 'obsidian';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

const mockRequestUrl = vi.mocked(requestUrl);

function respond(response: RequestUrlResponse): void {
    mockRequestUrl.mockReturnValue(
        Promise.resolve(response) as unknown as RequestUrlResponsePromise,
    );
}

function respondPending(): void {
    mockRequestUrl.mockReturnValue(
        new Promise<RequestUrlResponse>(() => undefined) as unknown as RequestUrlResponsePromise,
    );
}

function stubWindow(): void {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
}

function jsonResponse(status: number, json: unknown): RequestUrlResponse {
    return {
        status,
        json,
        text: JSON.stringify(json),
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
    };
}

function htmlResponse(status: number, text: string): RequestUrlResponse {
    return {
        status,
        text,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        get json(): unknown {
            throw new Error('not JSON');
        },
    };
}

function lastRequest(): RequestUrlParam {
    const param = mockRequestUrl.mock.calls[0][0];
    if (typeof param === 'string') {
        throw new Error('expected RequestUrlParam');
    }
    return param;
}

function lastRequestBody(): Record<string, unknown> {
    const body = lastRequest().body;
    if (typeof body !== 'string') {
        throw new Error('expected string body');
    }
    return JSON.parse(body) as Record<string, unknown>;
}

const CHAT_REQUEST: AIConversationRequest = {
    systemPrompt: 'Be helpful',
    messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Summarize' },
    ],
};

const TEST_RESPONSE_SCHEMA = {
    name: 'youtnote_segments',
    description: 'Timestamped Obsidian Markdown notes generated from a video transcript.',
    schema: {
        type: 'object',
        properties: { segments: { type: 'array' } },
    },
};

beforeEach(() => {
    mockRequestUrl.mockReset();
    stubWindow();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('OpenAIProvider', () => {
    const makeProvider = (apiKey: string | null = 'sk-test') =>
        new OpenAIProvider({ apiKey, model: 'gpt-4o', timeoutMs: 5000 });

    it('fails with missing-key before any request when the key is absent', async () => {
        const provider = makeProvider(null);
        await expect(provider.sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'missing-key' });
        await expect(provider.listModels())
            .rejects.toMatchObject({ kind: 'missing-key' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('sends a chat completion and parses content plus metadata', async () => {
        respond(jsonResponse(200, {
            model: 'gpt-4o',
            choices: [{ message: { role: 'assistant', content: 'Answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }));

        const result = await makeProvider().sendConversation(CHAT_REQUEST);

        expect(result.content).toBe('Answer');
        expect(result.metadata).toEqual({
            inputTokens: 12,
            outputTokens: 4,
            totalTokens: 16,
            model: 'gpt-4o',
            finishReason: 'stop',
        });

        const request = lastRequest();
        expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(request.method).toBe('POST');
        expect(request.throw).toBe(false);
        expect(request.headers?.Authorization).toBe('Bearer sk-test');
        expect(request.headers?.['Content-Type']).toBe('application/json');

        const body = lastRequestBody();
        expect(body.model).toBe('gpt-4o');
        const messages = body.messages as { role: string; content: unknown }[];
        expect(messages[0]).toEqual({ role: 'system', content: 'Be helpful' });
        expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
        expect(messages[3]).toEqual({ role: 'user', content: 'Summarize' });
    });

    it('rejects finish_reason length as truncated even when content is present', async () => {
        respond(jsonResponse(200, {
            choices: [{ message: { content: 'partial answer' }, finish_reason: 'length' }],
        }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'truncated' });
    });

    it('rejects finish_reason content_filter as blocked', async () => {
        respond(jsonResponse(200, {
            choices: [{ message: { content: 'partial' }, finish_reason: 'content_filter' }],
        }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'blocked' });
    });

    it('rejects a nonempty message.refusal as refused', async () => {
        respond(jsonResponse(200, {
            choices: [{ message: { content: '', refusal: 'cannot help with that' }, finish_reason: 'stop' }],
        }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'refused' });
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toThrow('cannot help with that');
    });

    it('rejects explicit unexpected finish reasons as a terminal provider error', async () => {
        for (const reason of ['tool_calls', 'function_call']) {
            respond(jsonResponse(200, {
                choices: [{ message: { content: 'x' }, finish_reason: reason }],
            }));
            await expect(makeProvider().sendConversation(CHAT_REQUEST))
                .rejects.toMatchObject({ kind: 'provider' });
        }
    });

    it('parses array-form message content parts', async () => {
        respond(jsonResponse(200, {
            choices: [{ message: { content: [{ type: 'text', text: 'Part A' }, { type: 'text', text: 'Part B' }] } }],
        }));
        const result = await makeProvider().sendConversation(CHAT_REQUEST);
        expect(result.content).toBe('Part A\nPart B');
    });

    it('attaches image attachments to the final user message', async () => {
        respond(jsonResponse(200, {
            choices: [{ message: { content: 'ok' } }],
        }));
        await makeProvider().sendConversation({
            ...CHAT_REQUEST,
            attachments: [{ mimeType: 'image/png', data: 'QUJD', name: 'shot.png' }],
        });
        const messages = lastRequestBody().messages as { role: string; content: unknown }[];
        expect(messages[3].content).toEqual([
            { type: 'text', text: 'Summarize' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ]);
    });

    it('rejects non-image attachments with invalid-config', async () => {
        await expect(makeProvider().sendConversation({
            ...CHAT_REQUEST,
            attachments: [{ mimeType: 'application/pdf', data: 'QUJD' }],
        })).rejects.toMatchObject({ kind: 'invalid-config' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('preserves provider error.message on failures', async () => {
        respond(jsonResponse(429, { error: { message: 'Rate limit reached' } }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'provider', status: 429, message: 'Rate limit reached' });
    });

    it('flags a malformed model list as invalid-response', async () => {
        respond(jsonResponse(200, { data: [] }));
        await expect(makeProvider().listModels()).rejects.toMatchObject({ kind: 'invalid-response' });

        respond(jsonResponse(200, { unexpected: true }));
        await expect(makeProvider().listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
    });

    it('requires a nonblank model', async () => {
        const provider = new OpenAIProvider({ apiKey: 'sk', model: '  ', timeoutMs: 5000 });
        await expect(provider.sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'invalid-config' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('sends a strict json_schema response_format when a response schema is provided', async () => {
        respond(jsonResponse(200, { choices: [{ message: { content: '{"segments":[]}' } }] }));
        await makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA });
        expect(lastRequestBody().response_format).toEqual({
            type: 'json_schema',
            json_schema: {
                name: 'youtnote_segments',
                strict: true,
                schema: createCompatibleResponseSchema(TEST_RESPONSE_SCHEMA.schema),
                description: TEST_RESPONSE_SCHEMA.description,
            },
        });
    });

    it('omits response_format without a response schema', async () => {
        respond(jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }));
        await makeProvider().sendConversation(CHAT_REQUEST);
        expect(lastRequestBody()).not.toHaveProperty('response_format');
    });
});

describe('CustomOpenAIProvider', () => {
    const makeProvider = (apiKey: string | null = null) =>
        new CustomOpenAIProvider({ baseUrl: 'http://localhost:1234/v1/', apiKey, model: 'llama', timeoutMs: 5000 });

    it('omits the Authorization header when no key is configured', async () => {
        respond(jsonResponse(200, { choices: [{ message: { content: 'hi' } }] }));
        await makeProvider().sendConversation(CHAT_REQUEST);
        const request = lastRequest();
        expect(request.url).toBe('http://localhost:1234/v1/chat/completions');
        expect(request.headers).not.toHaveProperty('Authorization');
    });

    it('shares the same chat response parsing', async () => {
        respond(jsonResponse(200, {
            choices: [{ message: { content: 'local answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }));
        const result = await makeProvider('optional-key').sendConversation(CHAT_REQUEST);
        expect(result.content).toBe('local answer');
        expect(result.metadata?.finishReason).toBe('stop');
        expect(lastRequest().headers?.Authorization).toBe('Bearer optional-key');
    });

    it('rejects finish_reason length as truncated', async () => {
        respond(jsonResponse(200, {
            choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
        }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'truncated' });
    });

    it('flags explicit unexpected finish reasons as incompatible', async () => {
        respond(jsonResponse(200, {
            choices: [{ message: { content: 'x' }, finish_reason: 'tool_calls' }],
        }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'incompatible' });
    });

    it('flags a malformed success response as incompatible', async () => {
        respond(jsonResponse(200, { unexpected: true }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'incompatible' });
    });

    it('flags an empty or malformed model list as incompatible', async () => {
        respond(jsonResponse(200, { data: [] }));
        await expect(makeProvider().listModels()).rejects.toMatchObject({ kind: 'incompatible' });

        respond(jsonResponse(200, { data: [{ name: 'no-id' }] }));
        await expect(makeProvider().listModels()).rejects.toMatchObject({ kind: 'incompatible' });
    });

    it('returns sorted deduplicated model ids', async () => {
        respond(jsonResponse(200, {
            data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }],
        }));
        await expect(makeProvider().listModels()).resolves.toEqual(['a-model', 'b-model']);
    });

    it('flags non-JSON error responses as incompatible', async () => {
        respond(htmlResponse(404, '<html><body>Not Found</body></html>'));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'incompatible', status: 404 });
    });

    it('flags JSON 404 chat responses as incompatible with the provider detail', async () => {
        respond(jsonResponse(404, { error: { message: 'route not found' } }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'incompatible', status: 404 });
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toThrow(/route not found/);
    });

    it('flags JSON 404 model-list responses as incompatible with the provider detail', async () => {
        respond(jsonResponse(404, { error: { message: 'route not found' } }));
        await expect(makeProvider().listModels())
            .rejects.toMatchObject({ kind: 'incompatible', status: 404 });
        await expect(makeProvider().listModels())
            .rejects.toThrow(/route not found/);
    });

    it('sends the same strict json_schema response_format as native OpenAI', async () => {
        respond(jsonResponse(200, { choices: [{ message: { content: '{"segments":[]}' } }] }));
        await makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA });
        expect(lastRequestBody().response_format).toEqual({
            type: 'json_schema',
            json_schema: {
                name: 'youtnote_segments',
                strict: true,
                schema: createCompatibleResponseSchema(TEST_RESPONSE_SCHEMA.schema),
                description: TEST_RESPONSE_SCHEMA.description,
            },
        });
    });

    it('keeps JSON 401 and 429 errors as provider errors', async () => {
        respond(jsonResponse(401, { error: { message: 'unauthorized' } }));
        await expect(makeProvider('key').sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'provider', status: 401, message: 'unauthorized' });

        respond(jsonResponse(429, { error: { message: 'slow down' } }));
        await expect(makeProvider().listModels())
            .rejects.toMatchObject({ kind: 'provider', status: 429, message: 'slow down' });
    });
});

describe('AnthropicProvider', () => {
    const makeProvider = (apiKey: string | null = 'sk-ant') =>
        new AnthropicProvider({ apiKey, model: 'claude-sonnet-4-5', timeoutMs: 5000 });

    it('fails with missing-key before any request when the key is absent', async () => {
        const provider = makeProvider(null);
        await expect(provider.sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'missing-key' });
        await expect(provider.listModels()).rejects.toMatchObject({ kind: 'missing-key' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('translates the request and parses content blocks plus metadata', async () => {
        respond(jsonResponse(200, {
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'world' }],
            usage: { input_tokens: 9, output_tokens: 7 },
            stop_reason: 'end_turn',
        }));

        const result = await makeProvider().sendConversation(CHAT_REQUEST);
        expect(result.content).toBe('Hello\nworld');
        expect(result.metadata).toEqual({
            inputTokens: 9,
            outputTokens: 7,
            totalTokens: 16,
            model: 'claude-sonnet-4-5',
            finishReason: 'end_turn',
        });

        const request = lastRequest();
        expect(request.url).toBe('https://api.anthropic.com/v1/messages');
        expect(request.headers?.['x-api-key']).toBe('sk-ant');
        expect(request.headers?.['anthropic-version']).toBe('2023-06-01');

        const body = lastRequestBody();
        expect(body.model).toBe('claude-sonnet-4-5');
        expect(body.max_tokens).toBe(8192);
        expect(body.system).toBe('Be helpful');
        expect(body.messages).toEqual([
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'Summarize' },
        ]);
    });

    it('translates base64 image attachments into image blocks', async () => {
        respond(jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }));
        await makeProvider().sendConversation({
            ...CHAT_REQUEST,
            attachments: [{ mimeType: 'image/png', data: 'QUJD' }],
        });
        const messages = lastRequestBody().messages as { role: string; content: unknown }[];
        expect(messages[2].content).toEqual([
            { type: 'text', text: 'Summarize' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        ]);
    });

    it('rejects URL-only attachments with invalid-config', async () => {
        await expect(makeProvider().sendConversation({
            ...CHAT_REQUEST,
            attachments: [{ mimeType: 'image/png', url: 'https://example.com/x.png' }],
        })).rejects.toMatchObject({ kind: 'invalid-config' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('sends a native output_config format and parses structured JSON from text', async () => {
        const input = { segments: [{ timestamp_seconds: 5, markdown: 'note' }] };
        respond(jsonResponse(200, {
            content: [{ type: 'text', text: JSON.stringify(input) }],
            usage: { input_tokens: 1, output_tokens: 2 },
            stop_reason: 'end_turn',
        }));
        const result = await makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA });

        expect(result.content).toBe(JSON.stringify(input));
        expect(result.metadata?.finishReason).toBe('end_turn');

        const body = lastRequestBody();
        expect(body.output_config).toEqual({
            format: {
                type: 'json_schema',
                schema: createCompatibleResponseSchema(TEST_RESPONSE_SCHEMA.schema),
            },
        });
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('tool_choice');
    });

    it('rejects a tool_use-only payload instead of accepting it as native JSON', async () => {
        respond(jsonResponse(200, {
            content: [{ type: 'tool_use', name: 'youtnote_segments', input: { segments: [] } }],
            stop_reason: 'end_turn',
        }));
        await expect(makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA }))
            .rejects.toMatchObject({ kind: 'invalid-response' });
    });

    it('rejects stop_reason max_tokens and model_context_window_exceeded as truncated', async () => {
        for (const stopReason of ['max_tokens', 'model_context_window_exceeded']) {
            respond(jsonResponse(200, {
                content: [{ type: 'text', text: 'partial' }],
                stop_reason: stopReason,
            }));
            await expect(makeProvider().sendConversation(CHAT_REQUEST))
                .rejects.toMatchObject({ kind: 'truncated' });
        }
    });

    it('rejects stop_reason refusal as refused and preserves the text explanation', async () => {
        respond(jsonResponse(200, {
            content: [{ type: 'text', text: 'no' }],
            stop_reason: 'refusal',
        }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'refused' });
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toThrow('no');
    });

    it('rejects other explicit stop reasons as a terminal provider error', async () => {
        for (const stopReason of ['tool_use', 'stop_sequence', 'pause_turn']) {
            respond(jsonResponse(200, {
                content: [{ type: 'text', text: 'answer' }],
                stop_reason: stopReason,
            }));
            await expect(makeProvider().sendConversation(CHAT_REQUEST))
                .rejects.toMatchObject({ kind: 'provider' });
        }
    });

    it('accepts a response without stop_reason', async () => {
        respond(jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }));
        const result = await makeProvider().sendConversation(CHAT_REQUEST);
        expect(result.content).toBe('ok');
    });
});

describe('GeminiProvider', () => {
    const makeProvider = (apiKey: string | null = 'g-key') =>
        new GeminiProvider({ apiKey, model: 'gemini-2.0-flash', timeoutMs: 5000 });

    it('fails with missing-key before any request when the key is absent', async () => {
        const provider = makeProvider(null);
        await expect(provider.sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'missing-key' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('translates the request and parses the response', async () => {
        respond(jsonResponse(200, {
            candidates: [{
                content: { role: 'model', parts: [{ text: 'Gemini ' }, { text: 'answer' }] },
                finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        }));

        const result = await makeProvider().sendConversation(CHAT_REQUEST);
        expect(result.content).toBe('Gemini \nanswer');
        expect(result.metadata).toEqual({
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8,
            model: 'gemini-2.0-flash',
            finishReason: 'STOP',
        });

        const request = lastRequest();
        expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
        expect(request.headers?.['x-goog-api-key']).toBe('g-key');

        const body = lastRequestBody();
        expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be helpful' }] });
        expect(body.generationConfig).toEqual({ maxOutputTokens: 8192 });
        const generationConfig = body.generationConfig as Record<string, unknown>;
        expect(generationConfig).not.toHaveProperty('responseFormat');
        expect(generationConfig).not.toHaveProperty('responseSchema');
        expect(generationConfig).not.toHaveProperty('responseMimeType');
        expect(generationConfig).not.toHaveProperty('responseJsonSchema');
        expect(body.contents).toEqual([
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Hi there' }] },
            { role: 'user', parts: [{ text: 'Summarize' }] },
        ]);
    });

    it('appends inlineData attachments to the final user content', async () => {
        respond(jsonResponse(200, {
            candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        }));
        await makeProvider().sendConversation({
            ...CHAT_REQUEST,
            attachments: [{ mimeType: 'application/pdf', data: 'QUJD' }],
        });
        const contents = lastRequestBody().contents as { role: string; parts: unknown[] }[];
        expect(contents[2].parts).toEqual([
            { text: 'Summarize' },
            { inlineData: { mimeType: 'application/pdf', data: 'QUJD' } },
        ]);
    });

    it('adds generationConfig.responseMimeType and responseJsonSchema for structured requests', async () => {
        respond(jsonResponse(200, {
            candidates: [{ content: { parts: [{ text: '{"segments":[]}' }] }, finishReason: 'STOP' }],
        }));
        await makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA });
        const generationConfig = lastRequestBody().generationConfig as Record<string, unknown>;
        expect(generationConfig).toEqual({
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseJsonSchema: createCompatibleResponseSchema(TEST_RESPONSE_SCHEMA.schema),
        });
        expect(generationConfig).not.toHaveProperty('responseFormat');
        expect(generationConfig).not.toHaveProperty('responseSchema');
    });

    it('rejects promptFeedback.blockReason as blocked even without candidates', async () => {
        respond(jsonResponse(200, {
            promptFeedback: { blockReason: 'SAFETY' },
        }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'blocked' });
    });

    it('rejects candidate finishReason MAX_TOKENS as truncated', async () => {
        respond(jsonResponse(200, {
            candidates: [{
                content: { parts: [{ text: 'partial but valid JSON {}' }] },
                finishReason: 'MAX_TOKENS',
            }],
        }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'truncated' });
    });

    it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])(
        'rejects safety finish reason %s as blocked',
        async (finishReason) => {
            respond(jsonResponse(200, {
                candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }],
            }));
            await expect(makeProvider().sendConversation(CHAT_REQUEST))
                .rejects.toMatchObject({ kind: 'blocked' });
        },
    );

    it('rejects other explicit finish reasons as a terminal provider error', async () => {
        for (const finishReason of ['OTHER', 'MALFORMED_FUNCTION_CALL']) {
            respond(jsonResponse(200, {
                candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }],
            }));
            await expect(makeProvider().sendConversation(CHAT_REQUEST))
                .rejects.toMatchObject({ kind: 'provider' });
        }
    });

    it('ignores thought parts when collecting answer text', async () => {
        respond(jsonResponse(200, {
            candidates: [{
                content: { parts: [{ text: 'hidden reasoning', thought: true }, { text: 'answer' }] },
                finishReason: 'STOP',
            }],
        }));
        const result = await makeProvider().sendConversation(CHAT_REQUEST);
        expect(result.content).toBe('answer');
    });

    it('filters listModels to generateContent and strips the models/ prefix', async () => {
        respond(jsonResponse(200, {
            models: [
                { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            ],
        }));
        const models = await makeProvider().listModels();
        expect(models).toEqual(['gemini-1.5-pro', 'gemini-2.0-flash']);
        expect(lastRequest().url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    });

    it('rejects an empty usable model list with invalid-response', async () => {
        respond(jsonResponse(200, { models: [] }));
        await expect(makeProvider().listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
    });
});

describe('request classification', () => {
    const provider = () => new OpenAIProvider({ apiKey: 'sk', model: 'gpt-4o', timeoutMs: 100 });

    it('classifies an aborted signal as cancelled', async () => {
        respondPending();
        const controller = new AbortController();
        const promise = provider().sendConversation({ ...CHAT_REQUEST, signal: controller.signal });
        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AIProviderError', kind: 'cancelled' });
    });

    it('rejects an already-aborted signal without sending a request', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(provider().sendConversation({ ...CHAT_REQUEST, signal: controller.signal }))
            .rejects.toMatchObject({ kind: 'cancelled' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('classifies a timeout distinctly from cancellation', async () => {
        vi.useFakeTimers();
        stubWindow();
        respondPending();
        const promise = provider().sendConversation(CHAT_REQUEST);
        const assertion = expect(promise).rejects.toMatchObject({ kind: 'timeout' });
        await vi.advanceTimersByTimeAsync(150);
        await assertion;
    });

    it('classifies a requestUrl rejection as a network error', async () => {
        mockRequestUrl.mockRejectedValue(new Error('socket hangup'));
        await expect(provider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'network' });
        await expect(provider().sendConversation(CHAT_REQUEST))
            .rejects.toThrow('socket hangup');
    });

    it('classifies a synchronous requestUrl throw as a network error', async () => {
        mockRequestUrl.mockImplementation(() => {
            throw new Error('sync failure');
        });
        await expect(provider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'network' });
        await expect(provider().sendConversation(CHAT_REQUEST))
            .rejects.toThrow('sync failure');
    });
});

describe('createCompatibleResponseSchema', () => {
    it('strips numeric, string, and array constraints while keeping structure', () => {
        const schema = createYoutnoteNotesJsonSchema(true, 2);
        const converted = createCompatibleResponseSchema(schema);
        expect(converted).toEqual({
            type: 'object',
            additionalProperties: false,
            required: ['general_note', 'segments'],
            properties: {
                general_note: { type: 'string' },
                segments: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['timestamp_seconds', 'markdown'],
                        properties: {
                            timestamp_seconds: { type: 'number' },
                            markdown: { type: 'string' },
                        },
                    },
                },
            },
        });
    });

    it('does not mutate the canonical schema', () => {
        const schema = createYoutnoteNotesJsonSchema(true, 2);
        createCompatibleResponseSchema(schema);
        expect(schema).toEqual(createYoutnoteNotesJsonSchema(true, 2));
        const segments = (schema.properties as Record<string, Record<string, unknown>>).segments;
        expect(segments.minItems).toBe(1);
        expect(segments.maxItems).toBe(2);
    });

    it('preserves property names that collide with unsupported keywords', () => {
        const schema = {
            type: 'object',
            additionalProperties: false,
            required: ['minimum', 'items'],
            properties: {
                minimum: { type: 'number', minimum: 5, multipleOf: 2 },
                items: { type: 'string', minLength: 2, format: 'date-time' },
            },
        };
        expect(createCompatibleResponseSchema(schema)).toEqual({
            type: 'object',
            additionalProperties: false,
            required: ['minimum', 'items'],
            properties: {
                minimum: { type: 'number' },
                items: { type: 'string' },
            },
        });
    });

    it('converts nested schemas inside combinators and arrays', () => {
        const schema = {
            type: 'object',
            properties: {
                any: { anyOf: [{ type: 'string', maxLength: 5 }, { type: 'number', maximum: 3 }] },
                deep: { type: 'object', properties: { n: { type: 'integer', exclusiveMinimum: 0 } } },
            },
        };
        expect(createCompatibleResponseSchema(schema)).toEqual({
            type: 'object',
            properties: {
                any: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                deep: { type: 'object', properties: { n: { type: 'integer' } } },
            },
        });
    });

    it('keeps the segments-only schema shape for the default max', () => {
        const converted = createCompatibleResponseSchema(createYoutnoteNotesJsonSchema(false));
        expect(converted).toEqual({
            type: 'object',
            additionalProperties: false,
            required: ['segments'],
            properties: {
                segments: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['timestamp_seconds', 'markdown'],
                        properties: {
                            timestamp_seconds: { type: 'number' },
                            markdown: { type: 'string' },
                        },
                    },
                },
            },
        });
    });
});

describe('createAIProviderError', () => {
    it.each<[string, unknown, number, boolean, string]>([
        ['structured output rejection', { error: { message: 'Structured output is not supported for this model' } }, 400, true, 'unsupported-structured-output'],
        ['response_format rejection', { error: { message: 'response_format is not supported' } }, 422, true, 'unsupported-structured-output'],
        ['unsupported_parameter code', { error: { code: 'unsupported_parameter', param: 'response_format', message: 'Unsupported parameter' } }, 400, true, 'unsupported-structured-output'],
        ['unsupported_value code', { error: { code: 'unsupported_value', param: 'output_config.format', message: 'Unsupported value' } }, 422, true, 'unsupported-structured-output'],
        ['unsupported gemini responseFormat', { error: { code: 'unsupported_parameter', param: 'generationConfig.responseFormat', message: 'unsupported' } }, 400, true, 'unsupported-structured-output'],
        ['unsupported gemini responseJsonSchema', { error: { code: 'unsupported_parameter', param: 'generationConfig.responseJsonSchema', message: 'unsupported' } }, 400, true, 'unsupported-structured-output'],
        ['unsupported gemini responseMimeType', { error: { code: 'unsupported_parameter', param: 'generationConfig.responseMimeType', message: 'unsupported' } }, 400, true, 'unsupported-structured-output'],
        ['unsupported snake_case response_json_schema', { error: { code: 'unsupported_parameter', param: 'generation_config.response_json_schema', message: 'unsupported' } }, 400, true, 'unsupported-structured-output'],
        ['unsupported snake_case response_mime_type', { error: { code: 'unsupported_parameter', param: 'generation_config.response_mime_type', message: 'unsupported' } }, 400, true, 'unsupported-structured-output'],
        ['gemini unknown responseJsonSchema field', { error: { message: 'Unknown name "responseJsonSchema": Cannot find field.', status: 'INVALID_ARGUMENT' } }, 400, true, 'unsupported-structured-output'],
        ['gemini unknown response_json_schema field', { error: { message: 'Unknown name "response_json_schema": Cannot find field.', status: 'INVALID_ARGUMENT' } }, 400, true, 'unsupported-structured-output'],
        ['stale tool_choice param', { error: { code: 'unsupported_parameter', param: 'tool_choice', message: 'tool_choice is not supported' } }, 400, true, 'provider'],
        ['stale responseSchema param', { error: { code: 'unsupported_parameter', param: 'responseSchema', message: 'responseSchema is not supported' } }, 400, true, 'provider'],
        ['invalid schema for response_format', { error: { message: 'Invalid schema for response_format: additionalProperties is not allowed' } }, 400, true, 'provider'],
        ['billing with capability param', { error: { code: 'unsupported_parameter', param: 'response_format', message: 'billing quota exceeded' } }, 400, true, 'provider'],
        ['gemini unknown field', { error: { message: 'Unknown name "responseFormat": Cannot find field.', status: 'INVALID_ARGUMENT' } }, 400, true, 'unsupported-structured-output'],
        ['plain JSON schema rejection', { error: { message: 'JSON schema is not supported for this model' } }, 400, true, 'unsupported-structured-output'],
        ['feature param via message', { error: { param: 'response_format', message: 'response_format is not supported' } }, 400, true, 'unsupported-structured-output'],
        ['model_not_found code', { error: { code: 'model_not_found', param: 'model', message: 'Model unavailable; request used response_format' } }, 400, true, 'provider'],
        ['billing_error code', { error: { code: 'billing_error', message: 'response_format is not supported' } }, 400, true, 'provider'],
        ['insufficient_quota code', { error: { code: 'insufficient_quota', param: 'response_format', message: 'unsupported' } }, 400, true, 'provider'],
        ['non-feature param messages', { error: { param: 'messages', message: 'response_format is not supported' } }, 400, true, 'provider'],
        ['non-feature param model', { error: { param: 'model', message: 'structured output is not supported' } }, 400, true, 'provider'],
        ['unrelated 400', { error: { message: 'Malformed request body' } }, 400, true, 'provider'],
        ['schema constraint rejection', { error: { message: "json_schema is invalid: 'minimum' is not supported" } }, 400, true, 'provider'],
        ['invalid_json_schema code', { error: { code: 'invalid_json_schema', param: 'response_format.json_schema.schema', message: 'Invalid schema' } }, 400, true, 'provider'],
        ['param path into schema', { error: { code: 'unsupported_parameter', param: 'response_format.json_schema.schema.properties.markdown', message: 'x' } }, 400, true, 'provider'],
        ['param path into responseJsonSchema', { error: { code: 'unsupported_parameter', param: 'generationConfig.responseJsonSchema.properties.markdown', message: 'unsupported parameter' } }, 400, true, 'provider'],
        ['param path into response_json_schema', { error: { code: 'unsupported_parameter', param: 'generation_config.response_json_schema.properties.markdown', message: 'unsupported parameter' } }, 400, true, 'provider'],
        ['invalid schema for responseJsonSchema', { error: { code: 'invalid_json_schema', param: 'generation_config.response_json_schema', message: 'Invalid schema' } }, 400, true, 'provider'],
        ['invalid mime enum value', { error: { status: 'INVALID_ARGUMENT', message: 'Invalid value at \'generation_config.response_format.text.mime_type\' (TYPE_STRING), "application/json"' } }, 400, true, 'provider'],
        ['classification disabled', { error: { message: 'response_format is not supported' } }, 400, false, 'provider'],
        ['wrong status 401', { error: { message: 'response_format is not supported' } }, 401, true, 'provider'],
        ['wrong status 429', { error: { message: 'response_format is not supported' } }, 429, true, 'provider'],
        ['wrong status 500', { error: { message: 'response_format is not supported' } }, 500, true, 'provider'],
        ['unavailable model', { error: { message: 'The model is unavailable' } }, 400, true, 'provider'],
        ['context length', { error: { message: 'maximum context length exceeded' } }, 400, true, 'provider'],
        ['billing', { error: { message: 'billing quota exceeded: structured output not supported' } }, 400, true, 'provider'],
    ])('classifies %s', (_label, json, status, structured, expectedKind) => {
        const error = createAIProviderError(json, status, 'fallback', structured);
        expect(error).toBeInstanceOf(AIProviderError);
        expect(error.kind).toBe(expectedKind);
    });

    it('preserves the provider message, code, and param', () => {
        const error = createAIProviderError(
            { error: { code: 'unsupported_parameter', param: 'response_format', message: 'not supported here' } },
            400,
            'fallback',
            true,
        );
        expect(error.kind).toBe('unsupported-structured-output');
        expect(error.message).toBe('not supported here');
        expect(error.status).toBe(400);
        expect(error.code).toBe('unsupported_parameter');
        expect(error.param).toBe('response_format');
    });

    it('derives code from error.type or error.status when code is absent or non-string', () => {
        const fromType = createAIProviderError(
            { error: { type: 'invalid_request_error', message: 'x' } }, 400, 'fallback',
        );
        expect(fromType.code).toBe('invalid_request_error');
        const fromStatus = createAIProviderError(
            { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'x' } }, 400, 'fallback',
        );
        expect(fromStatus.code).toBe('INVALID_ARGUMENT');
    });

    it('falls back to the generic message and omits code and param', () => {
        const error = createAIProviderError({ unexpected: true }, 503, 'Service failed.');
        expect(error.kind).toBe('provider');
        expect(error.message).toBe('Service failed.');
        expect(error.status).toBe(503);
        expect(error.code).toBeUndefined();
        expect(error.param).toBeUndefined();
    });

    it('keeps the internal reason independent from the provider code and param', () => {
        const error = new AIProviderError('invalid-response', 'fixture', 400, 'external-code', 'schema', 'invalid-json');
        expect(error.code).toBe('external-code');
        expect(error.param).toBe('schema');
        expect(error.status).toBe(400);
        expect(error.reason).toBe('invalid-json');
        expect(error.kind).toBe('invalid-response');
    });
});

describe('createAIProvider', () => {
    const base = { apiKey: 'k', model: 'm', timeoutMs: 1000 };

    it('creates each configured provider', () => {
        expect(createAIProvider({ ...base, provider: 'openai' }).id).toBe('openai');
        expect(createAIProvider({ ...base, provider: 'anthropic' }).id).toBe('anthropic');
        expect(createAIProvider({ ...base, provider: 'google' }).id).toBe('google');
        expect(createAIProvider({ ...base, provider: 'custom', customBaseUrl: 'http://x/v1' }).id).toBe('custom');
    });

    it('preflights a missing custom base URL with invalid-config', () => {
        expect(() => createAIProvider({ ...base, provider: 'custom' }))
            .toThrow(AIProviderError);
        expect(() => createAIProvider({ ...base, provider: 'custom' }))
            .toThrow(expect.objectContaining({ kind: 'invalid-config' }));
    });
});

describe('model list pagination', () => {
    const requestParamAt = (index: number): RequestUrlParam => {
        const param = mockRequestUrl.mock.calls[index][0];
        if (typeof param === 'string') {
            throw new Error('expected RequestUrlParam');
        }
        return param;
    };

    it('collects Anthropic models across after_id pages, deduplicated and sorted', async () => {
        const provider = new AnthropicProvider({ apiKey: 'sk-ant', model: 'claude-sonnet-4-5', timeoutMs: 5000 });
        mockRequestUrl
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {
                data: [{ id: 'b-model' }, { id: 'a-model' }],
                has_more: true,
                last_id: 'cursor-1',
            })) as unknown as RequestUrlResponsePromise)
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {
                data: [{ id: 'a-model' }, { id: 'c-model' }],
                has_more: false,
            })) as unknown as RequestUrlResponsePromise);
        await expect(provider.listModels()).resolves.toEqual(['a-model', 'b-model', 'c-model']);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        expect(requestParamAt(0).url).toBe('https://api.anthropic.com/v1/models');
        expect(requestParamAt(1).url).toBe('https://api.anthropic.com/v1/models?after_id=cursor-1');
    });

    it('rejects malformed or repeated Anthropic pagination cursors', async () => {
        const provider = new AnthropicProvider({ apiKey: 'sk-ant', model: 'claude-sonnet-4-5', timeoutMs: 5000 });
        respond(jsonResponse(200, { data: [{ id: 'x' }], has_more: true }));
        await expect(provider.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });

        respond(jsonResponse(200, { data: [{ id: 'x' }], has_more: 'yes' }));
        await expect(provider.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });

        mockRequestUrl.mockClear();
        mockRequestUrl.mockImplementation(() => Promise.resolve(jsonResponse(200, {
            data: [{ id: 'x' }],
            has_more: true,
            last_id: 'cursor-1',
        })) as unknown as RequestUrlResponsePromise);
        await expect(provider.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('propagates an Anthropic HTTP failure on a later page without a partial list', async () => {
        const provider = new AnthropicProvider({ apiKey: 'sk-ant', model: 'claude-sonnet-4-5', timeoutMs: 5000 });
        mockRequestUrl
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {
                data: [{ id: 'x' }],
                has_more: true,
                last_id: 'cursor-1',
            })) as unknown as RequestUrlResponsePromise)
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(500, {
                error: { message: 'server error' },
            })) as unknown as RequestUrlResponsePromise);
        await expect(provider.listModels()).rejects.toMatchObject({ kind: 'provider', status: 500 });
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('stops Anthropic listModels without further requests when the signal aborts between pages', async () => {
        const controller = new AbortController();
        const provider = new AnthropicProvider({ apiKey: 'sk-ant', model: 'claude-sonnet-4-5', timeoutMs: 5000 });
        mockRequestUrl.mockImplementation(() => {
            controller.abort();
            return Promise.resolve(jsonResponse(200, {
                data: [{ id: 'x' }],
                has_more: true,
                last_id: 'cursor-1',
            })) as unknown as RequestUrlResponsePromise;
        });
        await expect(provider.listModels(controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('collects Gemini models across nextPageToken pages and filters across all pages', async () => {
        const provider = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 });
        mockRequestUrl
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {
                models: [
                    { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
                    { name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] },
                ],
                nextPageToken: 'token-1',
            })) as unknown as RequestUrlResponsePromise)
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {
                models: [
                    { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
                    { name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] },
                ],
            })) as unknown as RequestUrlResponsePromise);
        await expect(provider.listModels()).resolves.toEqual(['gemini-a', 'gemini-b']);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        expect(requestParamAt(0).url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
        expect(requestParamAt(1).url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageToken=token-1');
    });

    it('treats a fully filtered first Gemini page as usable when a later page has models', async () => {
        const provider = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 });
        mockRequestUrl
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {
                models: [{ name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }],
                nextPageToken: 'token-1',
            })) as unknown as RequestUrlResponsePromise)
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {
                models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }],
            })) as unknown as RequestUrlResponsePromise);
        await expect(provider.listModels()).resolves.toEqual(['gemini-a']);
    });

    it.each([42, null, { token: 'x' }])(
        'rejects a present non-string Gemini nextPageToken (%s)',
        async (nextPageToken) => {
            const provider = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 });
            respond(jsonResponse(200, {
                models: [{ name: 'models/x', supportedGenerationMethods: ['generateContent'] }],
                nextPageToken,
            }));
            await expect(provider.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
            expect(mockRequestUrl).toHaveBeenCalledTimes(1);
        },
    );

    it('treats an empty-string Gemini nextPageToken as the end of the list', async () => {
        const provider = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 });
        respond(jsonResponse(200, {
            models: [{ name: 'models/x', supportedGenerationMethods: ['generateContent'] }],
            nextPageToken: '',
        }));
        await expect(provider.listModels()).resolves.toEqual(['x']);
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('rejects a repeated Gemini nextPageToken', async () => {
        const provider = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 });
        mockRequestUrl.mockImplementation(() => Promise.resolve(jsonResponse(200, {
            models: [{ name: 'models/x', supportedGenerationMethods: ['generateContent'] }],
            nextPageToken: 'token-1',
        })) as unknown as RequestUrlResponsePromise);
        await expect(provider.listModels()).rejects.toMatchObject({ kind: 'invalid-response' });
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('propagates a Gemini HTTP failure on a later page without a partial list', async () => {
        const provider = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 });
        mockRequestUrl
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {
                models: [{ name: 'models/x', supportedGenerationMethods: ['generateContent'] }],
                nextPageToken: 'token-1',
            })) as unknown as RequestUrlResponsePromise)
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(403, {
                error: { message: 'denied' },
            })) as unknown as RequestUrlResponsePromise);
        await expect(provider.listModels()).rejects.toMatchObject({ kind: 'provider', status: 403 });
    });

    it('stops listModels without further requests when the signal aborts between pages', async () => {
        const controller = new AbortController();
        const provider = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 });
        mockRequestUrl.mockImplementation(() => {
            controller.abort();
            return Promise.resolve(jsonResponse(200, {
                models: [{ name: 'models/x', supportedGenerationMethods: ['generateContent'] }],
                nextPageToken: 'token-1',
            })) as unknown as RequestUrlResponsePromise;
        });
        await expect(provider.listModels(controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });
});

describe('production schema on the wire', () => {
    const SEGMENTS_ITEM = {
        type: 'object',
        additionalProperties: false,
        required: ['timestamp_seconds', 'markdown'],
        properties: {
            timestamp_seconds: { type: 'number' },
            markdown: { type: 'string' },
        },
    };
    const EXPECTED_WIRE_SEGMENTS_ONLY = {
        type: 'object',
        additionalProperties: false,
        required: ['segments'],
        properties: {
            segments: { type: 'array', items: SEGMENTS_ITEM },
        },
    };
    const EXPECTED_WIRE_WITH_GENERAL = {
        type: 'object',
        additionalProperties: false,
        required: ['general_note', 'segments'],
        properties: {
            segments: { type: 'array', items: SEGMENTS_ITEM },
            general_note: { type: 'string' },
        },
    };

    const productionRequest = (includeGeneralNote: boolean, maxNotes?: number): AIConversationRequest => ({
        ...CHAT_REQUEST,
        responseSchema: {
            name: 'youtnote_segments',
            description: 'production schema',
            schema: createYoutnoteNotesJsonSchema(includeGeneralNote, maxNotes),
        },
    });

    const collectForbiddenKeywords = (value: unknown, found = new Set<string>()): Set<string> => {
        if (Array.isArray(value)) {
            for (const entry of value) {
                collectForbiddenKeywords(entry, found);
            }
            return found;
        }
        if (value !== null && typeof value === 'object') {
            for (const [key, entry] of Object.entries(value)) {
                if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
                    'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems'].includes(key)) {
                    found.add(key);
                }
                collectForbiddenKeywords(entry, found);
            }
        }
        return found;
    };

    const openAISuccess = () => jsonResponse(200, {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    const anthropicSuccess = () => jsonResponse(200, {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
    });
    const geminiSuccess = () => jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    });

    it.each([
        ['segments only', false, undefined, EXPECTED_WIRE_SEGMENTS_ONLY],
        ['general note with max 2', true, 2, EXPECTED_WIRE_WITH_GENERAL],
    ] as const)('OpenAI transmits the %s schema without forbidden constraints', async (_label, general, maxNotes, expected) => {
        respond(openAISuccess());
        const provider = new OpenAIProvider({ apiKey: 'sk', model: 'gpt-4o', timeoutMs: 5000 });
        await provider.sendConversation(productionRequest(general, maxNotes));
        const responseFormat = lastRequestBody().response_format as Record<string, unknown>;
        const jsonSchema = responseFormat.json_schema as Record<string, unknown>;
        expect(responseFormat.type).toBe('json_schema');
        expect(jsonSchema.strict).toBe(true);
        expect(jsonSchema.schema).toEqual(expected);
        expect(collectForbiddenKeywords(jsonSchema.schema).size).toBe(0);
    });

    it.each([
        ['segments only', false, undefined, EXPECTED_WIRE_SEGMENTS_ONLY],
        ['general note with max 2', true, 2, EXPECTED_WIRE_WITH_GENERAL],
    ] as const)('Custom OpenAI-compatible transmits the %s schema without forbidden constraints', async (_label, general, maxNotes, expected) => {
        respond(openAISuccess());
        const provider = new CustomOpenAIProvider({ baseUrl: 'http://localhost:1234/v1', apiKey: null, model: 'llama', timeoutMs: 5000 });
        await provider.sendConversation(productionRequest(general, maxNotes));
        const responseFormat = lastRequestBody().response_format as Record<string, unknown>;
        const jsonSchema = responseFormat.json_schema as Record<string, unknown>;
        expect(jsonSchema.schema).toEqual(expected);
        expect(collectForbiddenKeywords(jsonSchema.schema).size).toBe(0);
    });

    it.each([
        ['segments only', false, undefined, EXPECTED_WIRE_SEGMENTS_ONLY],
        ['general note with max 2', true, 2, EXPECTED_WIRE_WITH_GENERAL],
    ] as const)('Anthropic transmits the %s schema without forbidden constraints', async (_label, general, maxNotes, expected) => {
        respond(anthropicSuccess());
        const provider = new AnthropicProvider({ apiKey: 'sk-ant', model: 'claude-sonnet-4-5', timeoutMs: 5000 });
        await provider.sendConversation(productionRequest(general, maxNotes));
        const body = lastRequestBody();
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('tool_choice');
        const outputConfig = body.output_config as Record<string, unknown>;
        const format = outputConfig.format as Record<string, unknown>;
        expect(format.type).toBe('json_schema');
        expect(format.schema).toEqual(expected);
        expect(collectForbiddenKeywords(format.schema).size).toBe(0);
    });

    it.each([
        ['segments only', false, undefined, EXPECTED_WIRE_SEGMENTS_ONLY],
        ['general note with max 2', true, 2, EXPECTED_WIRE_WITH_GENERAL],
    ] as const)('Gemini transmits the %s schema without forbidden constraints', async (_label, general, maxNotes, expected) => {
        respond(geminiSuccess());
        const provider = new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 });
        await provider.sendConversation(productionRequest(general, maxNotes));
        const generationConfig = lastRequestBody().generationConfig as Record<string, unknown>;
        expect(generationConfig).not.toHaveProperty('responseFormat');
        expect(generationConfig).not.toHaveProperty('responseSchema');
        expect(generationConfig.responseMimeType).toBe('application/json');
        expect(generationConfig.responseJsonSchema).toEqual(expected);
        expect(collectForbiddenKeywords(generationConfig.responseJsonSchema).size).toBe(0);
    });
});

describe('generateNotesFromTranscript provider integration', () => {
    const TRANSCRIPT: TranscriptEntry[] = [
        { startMs: 0, text: 'Welcome' },
        { startMs: 10_000, text: 'First topic' },
    ];
    const LEGACY_MARKDOWN = [
        '[general-note](general-note)',
        'Video summary.',
        '',
        '[00:10](timestamp)',
        'First note.',
    ].join('\n');
    const OPTIONS: GenerateNotesOptions = {
        includeGeneralNote: true,
        maxNotes: 5,
        customInstructions: 'Be brief.',
    };

    const parseBody = (param: RequestUrlParam | string): Record<string, unknown> => {
        if (typeof param === 'string' || typeof param.body !== 'string') {
            throw new Error('expected RequestUrlParam with a string body');
        }
        return JSON.parse(param.body) as Record<string, unknown>;
    };

    const bodyAt = (index: number): Record<string, unknown> => parseBody(mockRequestUrl.mock.calls[index][0]);

    const respondByCapability = (
        isStructured: (body: Record<string, unknown>) => boolean,
        errorJson: unknown,
        successJson: unknown,
    ): void => {
        mockRequestUrl.mockImplementation((param) => {
            const structured = isStructured(parseBody(param));
            return Promise.resolve(jsonResponse(structured ? 400 : 200, structured ? errorJson : successJson)) as unknown as RequestUrlResponsePromise;
        });
    };

    it('falls back to Markdown when OpenAI rejects structured output', async () => {
        respondByCapability(
            body => body.response_format !== undefined,
            { error: { code: 'unsupported_parameter', param: 'response_format', message: 'response_format is not supported' } },
            { choices: [{ message: { content: LEGACY_MARKDOWN }, finish_reason: 'stop' }] },
        );
        const result = await generateNotesFromTranscript(
            new OpenAIProvider({ apiKey: 'sk', model: 'gpt-4o', timeoutMs: 5000 }),
            TRANSCRIPT,
            OPTIONS,
        );
        expect(result.format).toBe('unstructured');
        expect(result.corrected).toBe(true);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        const second = bodyAt(1);
        expect(second).not.toHaveProperty('response_format');
        const messages = second.messages as { role: string; content: string }[];
        expect(messages[0]).toEqual({ role: 'system', content: YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT });
        expect(messages[1].content).toContain('Generate one general-note block');
        expect(messages[1].content).toContain('Additional instructions: Be brief.');
        expect(messages[1].content).toContain('Return at most 5 timestamped notes');
        expect(messages[1].content).toContain('[0] Welcome');
    });

    it('falls back to Markdown when the custom provider rejects structured output', async () => {
        respondByCapability(
            body => body.response_format !== undefined,
            { error: { code: 'unsupported_parameter', param: 'response_format', message: 'response_format is not supported' } },
            { choices: [{ message: { content: LEGACY_MARKDOWN } }] },
        );
        const result = await generateNotesFromTranscript(
            new CustomOpenAIProvider({ baseUrl: 'http://localhost:1234/v1', apiKey: null, model: 'llama', timeoutMs: 5000 }),
            TRANSCRIPT,
            OPTIONS,
        );
        expect(result.format).toBe('unstructured');
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        const second = bodyAt(1);
        expect(second).not.toHaveProperty('response_format');
        const messages = second.messages as { role: string; content: string }[];
        expect(messages[0]).toEqual({ role: 'system', content: YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT });
        expect(messages[1].content).toContain('Generate one general-note block');
        expect(messages[1].content).toContain('Additional instructions: Be brief.');
        expect(messages[1].content).toContain('Return at most 5 timestamped notes');
        expect(messages[1].content).toContain('[0] Welcome');
    });

    it('falls back to Markdown when Anthropic rejects structured output', async () => {
        respondByCapability(
            body => body.output_config !== undefined,
            { error: { type: 'invalid_request_error', message: 'output_config.format is not supported for this model' } },
            { content: [{ type: 'text', text: LEGACY_MARKDOWN }], stop_reason: 'end_turn' },
        );
        const result = await generateNotesFromTranscript(
            new AnthropicProvider({ apiKey: 'sk-ant', model: 'claude-sonnet-4-5', timeoutMs: 5000 }),
            TRANSCRIPT,
            OPTIONS,
        );
        expect(result.format).toBe('unstructured');
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        const second = bodyAt(1);
        expect(second).not.toHaveProperty('output_config');
        expect(second).not.toHaveProperty('tools');
        expect(second.system).toBe(YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT);
        const messages = second.messages as { role: string; content: string }[];
        expect(messages[0].content).toContain('Generate one general-note block');
        expect(messages[0].content).toContain('Additional instructions: Be brief.');
        expect(messages[0].content).toContain('Return at most 5 timestamped notes');
        expect(messages[0].content).toContain('[0] Welcome');
    });

    it('returns structured notes from a successful Gemini response', async () => {
        respond(jsonResponse(200, {
            candidates: [{
                content: { parts: [{ text: JSON.stringify({
                    general_note: 'Video summary.',
                    segments: [{ timestamp_seconds: 10, markdown: 'First note.' }],
                }) }] },
                finishReason: 'STOP',
            }],
        }));
        const result = await generateNotesFromTranscript(
            new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 }),
            TRANSCRIPT,
            OPTIONS,
        );
        expect(result.format).toBe('structured');
        expect(result.corrected).toBe(false);
        expect(result.notes).toEqual([
            { timestampSec: -1, bodyMarkdown: 'Video summary.', isGeneral: true },
            { timestampSec: 10, bodyMarkdown: 'First note.' },
        ]);
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
        const generationConfig = bodyAt(0).generationConfig as Record<string, unknown>;
        expect(generationConfig.responseMimeType).toBe('application/json');
        expect(generationConfig.responseJsonSchema).toEqual(
            createCompatibleResponseSchema(createYoutnoteNotesJsonSchema(true, 5)),
        );
        expect(generationConfig).not.toHaveProperty('responseFormat');
        expect(generationConfig).not.toHaveProperty('responseSchema');
    });

    it('falls back to Markdown when Gemini rejects structured output', async () => {
        const controller = new AbortController();
        respondByCapability(
            body => (body.generationConfig as Record<string, unknown> | undefined)?.responseJsonSchema !== undefined,
            { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unknown name "responseJsonSchema": Cannot find field.' } },
            { candidates: [{ content: { parts: [{ text: LEGACY_MARKDOWN }] }, finishReason: 'STOP' }] },
        );
        const result = await generateNotesFromTranscript(
            new GeminiProvider({ apiKey: 'g-key', model: 'gemini-2.0-flash', timeoutMs: 5000 }),
            TRANSCRIPT,
            { ...OPTIONS, signal: controller.signal },
        );
        expect(result.format).toBe('unstructured');
        expect(controller.signal.aborted).toBe(false);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        const second = bodyAt(1);
        const generationConfig = second.generationConfig as Record<string, unknown>;
        expect(generationConfig).not.toHaveProperty('responseFormat');
        expect(generationConfig).not.toHaveProperty('responseSchema');
        expect(generationConfig).not.toHaveProperty('responseMimeType');
        expect(generationConfig).not.toHaveProperty('responseJsonSchema');
        const systemInstruction = second.systemInstruction as { parts: { text: string }[] };
        expect(systemInstruction.parts[0].text).toBe(YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT);
        const contents = second.contents as { parts: { text: string }[] }[];
        expect(contents[0].parts[0].text).toContain('Generate one general-note block');
        expect(contents[0].parts[0].text).toContain('Additional instructions: Be brief.');
        expect(contents[0].parts[0].text).toContain('Return at most 5 timestamped notes');
        expect(contents[0].parts[0].text).toContain('[0] Welcome');
    });
});

describe('getAINoteGenerationSetupError', () => {
    const makeAI = (mutate?: (ai: AISettings) => void): AISettings => {
        const ai: AISettings = {
            enabled: true,
            provider: 'openai',
            secretNames: { openai: 's1', anthropic: '', google: '', custom: '' },
            models: { openai: 'gpt-4o', anthropic: '', google: '', custom: '' },
            availableModels: { openai: [], anthropic: [], google: [], custom: [] },
            customBaseUrl: '',
            hostedTimeoutSeconds: 120,
            customTimeoutSeconds: 300,
        };
        mutate?.(ai);
        return ai;
    };

    it('returns invalid-config for disabled AI without reading secrets', () => {
        const getSecret = vi.fn(() => null);
        const error = getAINoteGenerationSetupError(makeAI(ai => { ai.enabled = false; }), getSecret);
        expect(error).toMatchObject({ kind: 'invalid-config', reason: 'ai-disabled' });
        expect(getSecret).not.toHaveBeenCalled();
    });

    it('returns invalid-config for provider none without reading secrets', () => {
        const getSecret = vi.fn(() => null);
        const error = getAINoteGenerationSetupError(makeAI(ai => { ai.provider = 'none'; }), getSecret);
        expect(error).toMatchObject({ kind: 'invalid-config', reason: 'provider-unconfigured' });
        expect(getSecret).not.toHaveBeenCalled();
    });

    it('returns missing-key for a hosted provider with a blank secret name', () => {
        const getSecret = vi.fn(() => null);
        const error = getAINoteGenerationSetupError(
            makeAI(ai => { ai.secretNames.openai = '  '; }),
            getSecret,
        );
        expect(error).toMatchObject({ kind: 'missing-key' });
        expect(getSecret).not.toHaveBeenCalled();
    });

    it('returns missing-key when the hosted secret resolves empty', () => {
        const getSecret = vi.fn((_name: string) => '   ');
        const error = getAINoteGenerationSetupError(makeAI(), getSecret);
        expect(error).toMatchObject({ kind: 'missing-key' });
        expect(getSecret).toHaveBeenCalledTimes(1);
        expect(getSecret).toHaveBeenCalledWith('s1');
    });

    it('returns null for a fully configured hosted provider', () => {
        const getSecret = vi.fn(() => 'sk-live');
        expect(getAINoteGenerationSetupError(makeAI(), getSecret)).toBeNull();
        expect(getSecret).toHaveBeenCalledTimes(1);
    });

    it('returns invalid-config when the selected model is blank', () => {
        const getSecret = vi.fn(() => 'sk-live');
        const error = getAINoteGenerationSetupError(
            makeAI(ai => { ai.models.openai = ' '; }),
            getSecret,
        );
        expect(error).toMatchObject({ kind: 'invalid-config', reason: 'model-unconfigured' });
    });

    it.each(['', '   ', 'not a url', 'ftp://x', 'javascript:alert(1)'])(
        'returns invalid-config for invalid custom base URL "%s" without reading secrets',
        (baseUrl) => {
            const getSecret = vi.fn(() => null);
            const error = getAINoteGenerationSetupError(
                makeAI(ai => {
                    ai.provider = 'custom';
                    ai.models.custom = 'llama';
                    ai.customBaseUrl = baseUrl;
                }),
                getSecret,
            );
            expect(error).toMatchObject({ kind: 'invalid-config', reason: 'invalid-base-url' });
            expect(getSecret).not.toHaveBeenCalled();
        },
    );

    it('allows a valid keyless custom provider without reading secrets', () => {
        const getSecret = vi.fn(() => null);
        const error = getAINoteGenerationSetupError(
            makeAI(ai => {
                ai.provider = 'custom';
                ai.models.custom = 'llama';
                ai.customBaseUrl = 'http://localhost:11434/v1';
            }),
            getSecret,
        );
        expect(error).toBeNull();
        expect(getSecret).not.toHaveBeenCalled();
    });
});
