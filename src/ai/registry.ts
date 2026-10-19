import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { CustomOpenAIProvider, OpenAIProvider } from './openai';
import { AIProviderError } from './types';
import type { AIProvider, ConfiguredAIProviderId } from './types';
import type { AISettings } from '../types';

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

const HOSTED_MISSING_KEY_MESSAGES: Record<Exclude<ConfiguredAIProviderId, 'custom'>, string> = {
    openai: 'OpenAI API key is not configured.',
    anthropic: 'Anthropic API key is not configured.',
    google: 'Gemini API key is not configured.',
};

export function getAINoteGenerationSetupError(
    settings: AISettings,
    getSecret: (name: string) => string | null,
): AIProviderError | null {
    if (!settings.enabled) {
        return new AIProviderError(
            'invalid-config',
            'AI integration is turned off. Open Youtnote settings to enable AI and configure a provider.',
            undefined,
            undefined,
            undefined,
            'ai-disabled',
        );
    }
    const provider = settings.provider;
    if (provider === 'none') {
        return new AIProviderError(
            'invalid-config',
            'No AI provider is configured. Select one in Youtnote settings.',
            undefined,
            undefined,
            undefined,
            'provider-unconfigured',
        );
    }
    if (provider !== 'custom') {
        const secretName = settings.secretNames[provider].trim();
        const apiKey = secretName ? getSecret(secretName) : null;
        if (!apiKey?.trim()) {
            return new AIProviderError('missing-key', HOSTED_MISSING_KEY_MESSAGES[provider]);
        }
    }
    if (!settings.models[provider].trim()) {
        return new AIProviderError(
            'invalid-config',
            'No AI model is configured. Select a model in Youtnote settings.',
            undefined,
            undefined,
            undefined,
            'model-unconfigured',
        );
    }
    if (provider === 'custom') {
        const baseUrl = settings.customBaseUrl.trim();
        let valid = false;
        if (baseUrl) {
            try {
                const parsed = new URL(baseUrl);
                valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
            } catch {
                valid = false;
            }
        }
        if (!valid) {
            return new AIProviderError(
                'invalid-config',
                'The custom AI base URL is not valid. Configure an http or https OpenAI-compatible base URL in Youtnote settings.',
                undefined,
                undefined,
                undefined,
                'invalid-base-url',
            );
        }
    }
    return null;
}
