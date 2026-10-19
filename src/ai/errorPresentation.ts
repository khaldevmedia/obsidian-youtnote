import { AIProviderError } from './types';

export type AIGuidanceId = 'none' | 'timeout' | 'network' | 'rate-limit' | 'unavailable' | 'account';

export interface AIErrorPresentation {
    severity: 'warning' | 'error';
    guidance: string;
    guidanceId: AIGuidanceId;
}

const ACCOUNT_ERROR_CODES = /^(authentication_error|permission_error|invalid_api_key|insufficient_quota|billing_error|billing_hard_limit_reached|credit_balance_too_low)$/i;

const QUOTA_ERROR_CODES = /^(insufficient_quota|billing_error|billing_hard_limit_reached|credit_balance_too_low)$/i;

const ACCOUNT_MESSAGE_EVIDENCE = /billing|credit balance|insufficient[_ ]quota|exceeded your current quota|daily (quota|limit)|per[- ]day/i;

const RATE_LIMIT_CODES = /^(rate_limit_error|rate_limit_exceeded|resource_exhausted)$/i;

const UNAVAILABLE_STATUSES = new Set([500, 502, 503, 504, 529]);

const UNAVAILABLE_CODES = /^(overloaded_error|unavailable)$/i;

const ACCOUNT_GUIDANCE = 'Check your provider account, billing, or quota limits before retrying.';
const RATE_LIMIT_GUIDANCE = 'The provider reported a rate or resource limit. Try again later or check the provider’s quota details.';
const UNAVAILABLE_GUIDANCE = 'The AI provider is temporarily unavailable. Try again later or select another model.';
const TIMEOUT_GUIDANCE = 'Increase the request timeout in Youtnote settings and try again.';
const NETWORK_GUIDANCE = 'Check your internet connection and try again.';

export function getAIErrorPresentation(error: unknown): AIErrorPresentation {
    if (!(error instanceof AIProviderError)) {
        return { severity: 'error', guidance: '', guidanceId: 'none' };
    }
    if (error.kind === 'timeout') {
        return { severity: 'warning', guidance: TIMEOUT_GUIDANCE, guidanceId: 'timeout' };
    }
    if (error.kind === 'network') {
        return { severity: 'warning', guidance: NETWORK_GUIDANCE, guidanceId: 'network' };
    }
    if (error.kind !== 'provider') {
        return { severity: 'error', guidance: '', guidanceId: 'none' };
    }
    const code = error.code;
    if (error.status === 401 || error.status === 403 || (code !== undefined && ACCOUNT_ERROR_CODES.test(code))) {
        const advisesAccount = ACCOUNT_MESSAGE_EVIDENCE.test(error.message)
            || (code !== undefined && QUOTA_ERROR_CODES.test(code));
        return advisesAccount
            ? { severity: 'error', guidance: ACCOUNT_GUIDANCE, guidanceId: 'account' }
            : { severity: 'error', guidance: '', guidanceId: 'none' };
    }
    if (ACCOUNT_MESSAGE_EVIDENCE.test(error.message)) {
        return { severity: 'error', guidance: ACCOUNT_GUIDANCE, guidanceId: 'account' };
    }
    if (error.status === 400 || error.status === 404 || error.status === 422) {
        return { severity: 'error', guidance: '', guidanceId: 'none' };
    }
    if (error.status === 429 || (code !== undefined && RATE_LIMIT_CODES.test(code))) {
        return { severity: 'warning', guidance: RATE_LIMIT_GUIDANCE, guidanceId: 'rate-limit' };
    }
    if ((error.status !== undefined && UNAVAILABLE_STATUSES.has(error.status))
        || (code !== undefined && UNAVAILABLE_CODES.test(code))) {
        return { severity: 'warning', guidance: UNAVAILABLE_GUIDANCE, guidanceId: 'unavailable' };
    }
    return { severity: 'error', guidance: '', guidanceId: 'none' };
}
