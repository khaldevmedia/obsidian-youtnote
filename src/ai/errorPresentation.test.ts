import { describe, expect, it } from 'vitest';
import { getAIErrorPresentation } from './errorPresentation';
import type { AIGuidanceId } from './errorPresentation';
import { AIProviderError } from './types';

describe('getAIErrorPresentation', () => {
    it.each<[string, unknown, 'warning' | 'error']>([
        ['non-AI error', new Error('boom'), 'error'],
        ['non-error value', 'boom', 'error'],
        ['AI timeout', new AIProviderError('timeout', 'The request timed out after 5 ms.'), 'warning'],
        ['AI network', new AIProviderError('network', 'The request failed: socket hangup'), 'warning'],
        ['AI cancelled', new AIProviderError('cancelled', 'cancelled'), 'error'],
        ['AI missing-key', new AIProviderError('missing-key', 'no key'), 'error'],
        ['AI invalid-config', new AIProviderError('invalid-config', 'bad config'), 'error'],
        ['AI invalid-response', new AIProviderError('invalid-response', 'bad response'), 'error'],
        ['AI truncated', new AIProviderError('truncated', 'truncated'), 'error'],
        ['AI refused', new AIProviderError('refused', 'refused'), 'error'],
        ['Gemini 503 UNAVAILABLE', new AIProviderError('provider', 'The service is currently overloaded.', 503, 'UNAVAILABLE'), 'warning'],
        ['Claude 529 overloaded_error', new AIProviderError('provider', 'Overloaded', 529, 'overloaded_error'), 'warning'],
        ['status-only 503', new AIProviderError('provider', 'unavailable', 503), 'warning'],
        ['code-only UNAVAILABLE', new AIProviderError('provider', 'unavailable', undefined, 'UNAVAILABLE'), 'warning'],
        ['code-only overloaded_error', new AIProviderError('provider', 'overloaded', undefined, 'overloaded_error'), 'warning'],
        ['429 rate limit', new AIProviderError('provider', 'Rate limited', 429), 'warning'],
        ['code rate_limit_error', new AIProviderError('provider', 'Rate limited', 429, 'rate_limit_error'), 'warning'],
        ['code-only rate_limit_exceeded', new AIProviderError('provider', 'limited', undefined, 'rate_limit_exceeded'), 'warning'],
        ['code RESOURCE_EXHAUSTED', new AIProviderError('provider', 'quota exceeded', 429, 'RESOURCE_EXHAUSTED'), 'warning'],
        ['code-only resource_exhausted', new AIProviderError('provider', 'quota exceeded', undefined, 'resource_exhausted'), 'warning'],
        ['429 insufficient_quota', new AIProviderError('provider', 'Quota exceeded', 429, 'insufficient_quota'), 'error'],
        ['daily quota message', new AIProviderError('provider', 'You exceeded your current quota; daily limit reached', 429), 'error'],
        ['billing message', new AIProviderError('provider', 'billing_hard_limit_reached', 400), 'error'],
        ['401 unauthorized', new AIProviderError('provider', 'Invalid API key', 401), 'error'],
        ['403 forbidden', new AIProviderError('provider', 'Forbidden', 403), 'error'],
        ['code authentication_error', new AIProviderError('provider', 'auth failed', undefined, 'authentication_error'), 'error'],
        ['code billing_error', new AIProviderError('provider', 'billing', undefined, 'billing_error'), 'error'],
        ['400 invalid MIME value', new AIProviderError('provider', "Invalid value at 'generation_config.response_format.text.mime_type' (TYPE_STRING), \"application/json\"", 400, 'INVALID_ARGUMENT'), 'error'],
        ['400 bad request', new AIProviderError('provider', 'Malformed request', 400), 'error'],
        ['404 not found', new AIProviderError('provider', 'Model not found', 404), 'error'],
        ['422 unprocessable', new AIProviderError('provider', 'Invalid schema', 422), 'error'],
        ['generic provider error', new AIProviderError('provider', 'Something went wrong'), 'error'],
        ['provider 500', new AIProviderError('provider', 'Internal error', 500), 'warning'],
        ['provider 502', new AIProviderError('provider', 'Bad gateway', 502), 'warning'],
        ['provider 504', new AIProviderError('provider', 'Gateway timeout', 504), 'warning'],
    ])('classifies %s as %s', (_label, error, expectedSeverity) => {
        expect(getAIErrorPresentation(error).severity).toBe(expectedSeverity);
    });

    it.each<[string, unknown, 'warning' | 'error', AIGuidanceId]>([
        ['non-AI error', new Error('boom'), 'error', 'none'],
        ['AI timeout', new AIProviderError('timeout', 'x'), 'warning', 'timeout'],
        ['AI network', new AIProviderError('network', 'x'), 'warning', 'network'],
        ['AI cancelled', new AIProviderError('cancelled', 'x'), 'error', 'none'],
        ['429 rate limit', new AIProviderError('provider', 'x', 429), 'warning', 'rate-limit'],
        ['code rate_limit_error', new AIProviderError('provider', 'x', 429, 'rate_limit_error'), 'warning', 'rate-limit'],
        ['503 unavailable', new AIProviderError('provider', 'x', 503), 'warning', 'unavailable'],
        ['529 overloaded_error', new AIProviderError('provider', 'x', 529, 'overloaded_error'), 'warning', 'unavailable'],
        ['429 insufficient_quota', new AIProviderError('provider', 'insufficient_quota', 429, 'insufficient_quota'), 'error', 'account'],
        ['daily quota message', new AIProviderError('provider', 'You exceeded your current quota; daily limit reached', 429), 'error', 'account'],
        ['401 unauthorized', new AIProviderError('provider', 'x', 401), 'error', 'none'],
        ['400 bad request', new AIProviderError('provider', 'x', 400), 'error', 'none'],
        ['generic provider error', new AIProviderError('provider', 'x'), 'error', 'none'],
    ])('classifies %s as %s with guidance %s', (_label, error, expectedSeverity, expectedId) => {
        const presentation = getAIErrorPresentation(error);
        expect(presentation.severity).toBe(expectedSeverity);
        expect(presentation.guidanceId).toBe(expectedId);
        if (expectedId === 'none') {
            expect(presentation.guidance).toBe('');
        } else {
            expect(presentation.guidance.length).toBeGreaterThan(0);
        }
    });
});
