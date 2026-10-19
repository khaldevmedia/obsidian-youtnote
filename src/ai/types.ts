export type AIProviderId = 'none' | 'openai' | 'anthropic' | 'google' | 'custom';
export type ConfiguredAIProviderId = Exclude<AIProviderId, 'none'>;

export type AIMessageRole = 'user' | 'assistant';

export interface AIMessage {
    role: AIMessageRole;
    content: string;
}

export interface AIAttachment {
    name?: string;
    mimeType: string;
    data?: string;
    url?: string;
}

export interface AIResponseSchema {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
}

export interface AIConversationRequest {
    systemPrompt: string;
    messages: AIMessage[];
    attachments?: AIAttachment[];
    signal?: AbortSignal;
    responseSchema?: AIResponseSchema;
}

export interface AIResponseMetadata {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    model?: string;
    finishReason?: string;
}

export interface AIConversationResponse {
    content: string;
    metadata?: AIResponseMetadata;
}

export interface AIProvider {
    readonly id: ConfiguredAIProviderId;
    sendConversation(request: AIConversationRequest): Promise<AIConversationResponse>;
    listModels(signal?: AbortSignal): Promise<string[]>;
}

export type AIErrorKind =
    | 'cancelled'
    | 'timeout'
    | 'missing-key'
    | 'invalid-config'
    | 'network'
    | 'provider'
    | 'incompatible'
    | 'invalid-response'
    | 'unsupported-structured-output'
    | 'truncated'
    | 'refused'
    | 'blocked';

export type AIErrorReason =
    | 'ai-disabled'
    | 'provider-unconfigured'
    | 'model-unconfigured'
    | 'invalid-base-url'
    | 'invalid-json'
    | 'not-object'
    | 'missing-segments'
    | 'invalid-segment'
    | 'invalid-timestamp'
    | 'timestamp-out-of-range'
    | 'out-of-order'
    | 'empty-body'
    | 'too-many-notes'
    | 'missing-general-note'
    | 'unrequested-general-note'
    | 'duplicate-general-note'
    | 'general-note-order'
    | 'code-fence'
    | 'malformed-delimiter'
    | 'unexpected-content'
    | 'missing-notes';

export const AI_TRUNCATED_RESPONSE_HINT = 'Try a smaller "Maximum notes" value or ask for shorter notes through "Custom instructions".';

export class AIProviderError extends Error {
    constructor(
        public readonly kind: AIErrorKind,
        message: string,
        public readonly status?: number,
        public readonly code?: string,
        public readonly param?: string,
        public readonly reason?: AIErrorReason,
    ) {
        super(message);
        this.name = 'AIProviderError';
    }
}
