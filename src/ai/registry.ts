import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { CustomOpenAIProvider, OpenAIProvider } from './openai';
import { AIProviderError } from './types';
import type { AIProvider, ConfiguredAIProviderId } from './types';

export interface AIProviderFactoryConfig {
    provider: ConfiguredAIProviderId;
    apiKey: string | null;
    model: string;
    timeoutMs: number;
    customBaseUrl?: string;
}

export function createAIProvider(config: AIProviderFactoryConfig): AIProvider {
    switch (config.provider) {
        case 'openai':
            return new OpenAIProvider({
                apiKey: config.apiKey,
                model: config.model,
                timeoutMs: config.timeoutMs,
            });
        case 'anthropic':
            return new AnthropicProvider({
                apiKey: config.apiKey,
                model: config.model,
                timeoutMs: config.timeoutMs,
            });
        case 'google':
            return new GeminiProvider({
                apiKey: config.apiKey,
                model: config.model,
                timeoutMs: config.timeoutMs,
            });
        case 'custom': {
            const baseUrl = config.customBaseUrl?.trim();
            if (!baseUrl) {
                throw new AIProviderError(
                    'invalid-config',
                    'A custom OpenAI-compatible provider requires a base URL.',
                );
            }
            return new CustomOpenAIProvider({
                baseUrl,
                apiKey: config.apiKey,
                model: config.model,
                timeoutMs: config.timeoutMs,
            });
        }
        default: {
            const exhaustive: never = config.provider;
            throw new AIProviderError('invalid-config', `Unknown AI provider: ${String(exhaustive)}`);
        }
    }
}
