import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse, RequestUrlResponsePromise } from 'obsidian';
import { AIProviderError } from './types';
import type { AIConversationRequest } from './types';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { CustomOpenAIProvider, OpenAIProvider } from './openai';
import { createAIProvider } from './registry';

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
            .rejects.toMatchObject({ kind: 'missing-key', message: 'OpenAI API key is not configured.' });
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
                schema: TEST_RESPONSE_SCHEMA.schema,
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
            choices: [{ message: { content: 'local answer' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }));
        const result = await makeProvider('optional-key').sendConversation(CHAT_REQUEST);
        expect(result.content).toBe('local answer');
        expect(result.metadata?.finishReason).toBe('length');
        expect(lastRequest().headers?.Authorization).toBe('Bearer optional-key');
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
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toThrow(/OpenAI-compatible/);
    });

    it('flags JSON 404 chat responses as incompatible with the provider detail', async () => {
        respond(jsonResponse(404, { error: { message: 'route not found' } }));
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toMatchObject({ kind: 'incompatible', status: 404 });
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toThrow(/route not found/);
        await expect(makeProvider().sendConversation(CHAT_REQUEST))
            .rejects.toThrow(/OpenAI-compatible/);
    });

    it('flags JSON 404 model-list responses as incompatible with the provider detail', async () => {
        respond(jsonResponse(404, { error: { message: 'route not found' } }));
        await expect(makeProvider().listModels())
            .rejects.toMatchObject({ kind: 'incompatible', status: 404 });
        await expect(makeProvider().listModels())
            .rejects.toThrow(/route not found/);
        await expect(makeProvider().listModels())
            .rejects.toThrow(/OpenAI-compatible/);
    });

    it('sends the same strict json_schema response_format as native OpenAI', async () => {
        respond(jsonResponse(200, { choices: [{ message: { content: '{"segments":[]}' } }] }));
        await makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA });
        expect(lastRequestBody().response_format).toEqual({
            type: 'json_schema',
            json_schema: {
                name: 'youtnote_segments',
                strict: true,
                schema: TEST_RESPONSE_SCHEMA.schema,
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

    it('uses a forced strict tool schema and extracts the tool_use input', async () => {
        const input = { segments: [{ timestamp_seconds: 5, markdown: 'note' }] };
        respond(jsonResponse(200, {
            content: [{ type: 'tool_use', name: 'youtnote_segments', input }],
            usage: { input_tokens: 1, output_tokens: 2 },
            stop_reason: 'tool_use',
        }));
        const result = await makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA });

        expect(result.content).toBe(JSON.stringify(input));

        const body = lastRequestBody();
        expect(body.tools).toEqual([{
            name: 'youtnote_segments',
            description: TEST_RESPONSE_SCHEMA.description,
            strict: true,
            input_schema: TEST_RESPONSE_SCHEMA.schema,
        }]);
        expect(body.tool_choice).toEqual({
            type: 'tool',
            name: 'youtnote_segments',
            disable_parallel_tool_use: true,
        });
    });

    it('throws invalid-response when the structured tool call is missing or malformed', async () => {
        respond(jsonResponse(200, { content: [{ type: 'text', text: 'no tool call' }] }));
        await expect(makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA }))
            .rejects.toMatchObject({ kind: 'invalid-response' });

        respond(jsonResponse(200, { content: [{ type: 'tool_use', name: 'youtnote_segments', input: 'not-an-object' }] }));
        await expect(makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA }))
            .rejects.toMatchObject({ kind: 'invalid-response' });
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

    it('adds responseMimeType and responseSchema to generationConfig for structured requests', async () => {
        respond(jsonResponse(200, {
            candidates: [{ content: { parts: [{ text: '{"segments":[]}' }] } }],
        }));
        await makeProvider().sendConversation({ ...CHAT_REQUEST, responseSchema: TEST_RESPONSE_SCHEMA });
        expect(lastRequestBody().generationConfig).toEqual({
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseSchema: TEST_RESPONSE_SCHEMA.schema,
        });
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
