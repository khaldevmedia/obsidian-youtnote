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

export interface AIConversationRequest {
    systemPrompt: string;
    messages: AIMessage[];
    attachments?: AIAttachment[];
    signal?: AbortSignal;
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
    | 'invalid-response';

export class AIProviderError extends Error {
    constructor(
        public readonly kind: AIErrorKind,
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'AIProviderError';
    }
}
