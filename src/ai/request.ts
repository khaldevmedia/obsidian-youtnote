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

const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minItems',
    'maxItems',
]);

const SCHEMA_NAME_MAP_KEYWORDS = new Set([
    'properties',
    'patternProperties',
    'dependentSchemas',
    '$defs',
    'definitions',
]);

export function createCompatibleResponseSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const convert = (value: unknown): unknown => {
        if (Array.isArray(value)) {
            return value.map(convert);
        }
        if (!isRecord(value)) {
            return value;
        }
        const converted: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
                continue;
            }
            if (SCHEMA_NAME_MAP_KEYWORDS.has(key) && isRecord(entry)) {
                const nameMap: Record<string, unknown> = {};
                for (const [name, subSchema] of Object.entries(entry)) {
                    nameMap[name] = convert(subSchema);
                }
                converted[key] = nameMap;
                continue;
            }
            converted[key] = convert(entry);
        }
        return converted;
    };
    return convert(schema) as Record<string, unknown>;
}

const UNSUPPORTED_FEATURE_PARAM_CODES = new Set(['unsupported_parameter', 'unsupported_value']);

const UNSUPPORTED_FEATURE_PARAMS = new Set([
    'response_format',
    'response_format.type',
    'response_format.json_schema',
    'response_format.json_schema.strict',
    'output_config',
    'output_config.format',
    'responseFormat',
    'generationConfig.responseFormat',
    'responseMimeType',
    'responseJsonSchema',
    'generationConfig.responseMimeType',
    'generationConfig.responseJsonSchema',
    'response_mime_type',
    'response_json_schema',
    'generation_config.response_mime_type',
    'generation_config.response_json_schema',
]);

const INVALID_SCHEMA_CODES = /invalid[_-]?json[_-]?schema|invalid[_-]?schema|schema[_-]?validation/i;

const NON_CAPABILITY_CODES = /model_not_found|model_not_available|authentication_error|permission_error|billing_error|context_length_exceeded|insufficient_quota/i;

const SCHEMA_ERROR_EVIDENCE = /invalid schema|schema validation|schema is invalid|not a valid schema|malformed schema|additionalProperties/i;

const SCHEMA_CONSTRAINT_EVIDENCE = /\b(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minLength|maxLength|minItems|maxItems|pattern)\b/i;

const OUTPUT_FEATURE_EVIDENCE = /structured[ _-]?output|response_format|json[_ -]?schema|output_config|responseformat|response_mime_type|response_json_schema|responsemimetype|responsejsonschema/i;

const UNSUPPORTED_FEATURE_EVIDENCE = /not supported|unsupported|not available|unavailable|not allowed|not permitted|does not support|cannot be used|unrecognized|unknown (name|field|parameter|property|argument)/i;

const ACCOUNT_OR_CONTEXT_EVIDENCE = /\bbilling\b|\bquota\b|insufficient_quota|credit (balance|limit)|context (length|window)|maximum (context|token)|token limit/i;

function paramTargetsSchemaContent(param: string): boolean {
    return /(^|\.)(schema|properties|items|required|anyOf|oneOf|allOf|\$defs)(\.|$)/i.test(param)
        || /(^|\.)(responseJsonSchema|response_json_schema)\./.test(param);
}

function isUnsupportedStructuredOutputEvidence(message: string, code: string | undefined, param: string | undefined): boolean {
    if (param && paramTargetsSchemaContent(param)) {
        return false;
    }
    if (code && (INVALID_SCHEMA_CODES.test(code) || NON_CAPABILITY_CODES.test(code))) {
        return false;
    }
    if (SCHEMA_ERROR_EVIDENCE.test(message)
        || SCHEMA_CONSTRAINT_EVIDENCE.test(message)
        || ACCOUNT_OR_CONTEXT_EVIDENCE.test(message)) {
        return false;
    }
    if (param && !UNSUPPORTED_FEATURE_PARAMS.has(param)) {
        return false;
    }
    if (code && param && UNSUPPORTED_FEATURE_PARAM_CODES.has(code) && UNSUPPORTED_FEATURE_PARAMS.has(param)) {
        return true;
    }
    if (!UNSUPPORTED_FEATURE_EVIDENCE.test(message)) {
        return false;
    }
    return OUTPUT_FEATURE_EVIDENCE.test(message);
}

export function createAIProviderError(
    json: unknown,
    status: number,
    fallback: string,
    structured = false,
): AIProviderError {
    let code: string | undefined;
    let param: string | undefined;
    if (isRecord(json) && isRecord(json.error)) {
        const error = json.error;
        for (const field of ['code', 'type', 'status'] as const) {
            const value = error[field];
            if (typeof value === 'string' && value.trim()) {
                code = value;
                break;
            }
        }
        if (typeof error.param === 'string' && error.param.trim()) {
            param = error.param;
        }
    }
    const message = extractProviderErrorMessage(json, fallback);
    if (structured
        && (status === 400 || status === 422)
        && isUnsupportedStructuredOutputEvidence(message, code, param)) {
        return new AIProviderError('unsupported-structured-output', message, status, code, param);
    }
    return new AIProviderError('provider', message, status, code, param);
}

export function isSuccessStatus(status: number): boolean {
    return status >= 200 && status < 300;
}
