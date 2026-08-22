/**
 * Provider catalog templates for the Add Provider workflow.
 */

export interface ProviderTemplate {
  id: string
  name: string
  description: string
  category: 'popular' | 'fast' | 'open-source' | 'custom'
  api: 'openai-completions' | 'anthropic-messages'
  defaultBaseURL?: string
  defaultKeyEnv?: string
  helpUrl?: string
  icon?: string
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-4o, o1, o3, o4 and GPT-4.5 official endpoints',
    category: 'popular',
    api: 'openai-completions',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultKeyEnv: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude 3.5 Sonnet, Claude 3.7 Sonnet, Claude 3.5 Haiku, Opus',
    category: 'popular',
    api: 'anthropic-messages',
    defaultBaseURL: 'https://api.anthropic.com/v1',
    defaultKeyEnv: 'ANTHROPIC_API_KEY',
    helpUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Gemini 2.5 Pro, 2.5 Flash, 3.1 Pro, 3.7 Flash Thinking',
    category: 'popular',
    api: 'openai-completions',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultKeyEnv: 'GEMINI_API_KEY',
    helpUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Universal gateway to over 400+ frontier and open-source models',
    category: 'popular',
    api: 'openai-completions',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    defaultKeyEnv: 'OPENROUTER_API_KEY',
    helpUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Official',
    description: 'DeepSeek-V3, DeepSeek-R1 official fast API',
    category: 'popular',
    api: 'openai-completions',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    defaultKeyEnv: 'DEEPSEEK_API_KEY',
    helpUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'minimax',
    name: 'MiniMax Coding Plan',
    description: 'MiniMax M3, M2.7 with high-speed coding optimization',
    category: 'popular',
    api: 'openai-completions',
    defaultBaseURL: 'https://api.minimaxi.chat/v1',
    defaultKeyEnv: 'MINIMAX_API_KEY',
    helpUrl: 'https://platform.minimaxi.com/',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Inference Providers & Serverless Endpoints router',
    category: 'open-source',
    api: 'openai-completions',
    defaultBaseURL: 'https://router.huggingface.co/v1',
    defaultKeyEnv: 'HF_TOKEN',
    helpUrl: 'https://huggingface.co/settings/tokens',
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    description: 'Run open LLMs locally (Llama 3.3, Qwen 2.5, DeepSeek R1)',
    category: 'open-source',
    api: 'openai-completions',
    defaultBaseURL: 'http://127.0.0.1:11434/v1',
    defaultKeyEnv: 'OLLAMA_API_KEY',
    helpUrl: 'https://ollama.com',
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Ultra-low latency LPU inference for Llama 3.3 and DeepSeek',
    category: 'fast',
    api: 'openai-completions',
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    defaultKeyEnv: 'GROQ_API_KEY',
    helpUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Wafer-scale engine with 2000+ tokens/sec throughput',
    category: 'fast',
    api: 'openai-completions',
    defaultBaseURL: 'https://api.cerebras.ai/v1',
    defaultKeyEnv: 'CEREBRAS_API_KEY',
    helpUrl: 'https://cloud.cerebras.ai',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Mistral Large, Codestral, Pixtral, Devral',
    category: 'popular',
    api: 'openai-completions',
    defaultBaseURL: 'https://api.mistral.ai/v1',
    defaultKeyEnv: 'MISTRAL_API_KEY',
    helpUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    description: 'Grok-2, Grok-2 Vision, Grok Beta endpoints',
    category: 'popular',
    api: 'openai-completions',
    defaultBaseURL: 'https://api.x.ai/v1',
    defaultKeyEnv: 'XAI_API_KEY',
    helpUrl: 'https://console.x.ai',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen Direct',
    description: 'OpenCode Zen unified model gateway',
    category: 'popular',
    api: 'openai-completions',
    defaultBaseURL: 'https://opencode.ai/zen/v1',
    defaultKeyEnv: 'OPENCODE_ZEN_KEY',
  },
]
