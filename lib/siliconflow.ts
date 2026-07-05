const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_SILICONFLOW_MODEL = "deepseek-ai/DeepSeek-V4-Pro";
const DEFAULT_TIMEOUT_MS = 280000;

export type LlmProvider = "deepseek" | "siliconflow";

export type SiliconFlowMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type SiliconFlowResponseFormat =
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
      };
    }
  | {
      type: "json_object";
    };

type ChatCompletionOptions = {
  messages: SiliconFlowMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  responseFormat?: SiliconFlowResponseFormat;
};

type ChatCompletionChoice = {
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
  };
};

type ChatCompletionResponse = {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
  };
};

function getDeepSeekBaseUrl() {
  return process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL;
}

function getSiliconFlowBaseUrl() {
  return process.env.SILICONFLOW_BASE_URL?.trim() || DEFAULT_SILICONFLOW_BASE_URL;
}

function getDeepSeekApiKey() {
  return process.env.DEEPSEEK_API_KEY?.trim() || "";
}

function getSiliconFlowApiKey() {
  return process.env.SILICONFLOW_API_KEY?.trim() || "";
}

export function getDeepSeekModel() {
  return process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
}

export function getSiliconFlowModel() {
  return process.env.SILICONFLOW_MODEL?.trim() || DEFAULT_SILICONFLOW_MODEL;
}

export function isDeepSeekConfigured() {
  return Boolean(getDeepSeekApiKey());
}

export function isSiliconFlowConfigured() {
  return Boolean(getSiliconFlowApiKey());
}

export function getConfiguredLlmProvider(): LlmProvider {
  return isDeepSeekConfigured() ? "deepseek" : "siliconflow";
}

export function isLlmConfigured() {
  return isDeepSeekConfigured() || isSiliconFlowConfigured();
}

export function getConfiguredLlmModel() {
  return getConfiguredLlmProvider() === "deepseek" ? getDeepSeekModel() : getSiliconFlowModel();
}

export async function createLlmChatCompletion(options: ChatCompletionOptions & { provider?: LlmProvider }) {
  const provider = options.provider ?? getConfiguredLlmProvider();
  const apiKey = provider === "deepseek" ? getDeepSeekApiKey() : getSiliconFlowApiKey();
  const baseUrl = provider === "deepseek" ? getDeepSeekBaseUrl() : getSiliconFlowBaseUrl();
  const model = provider === "deepseek" ? getDeepSeekModel() : getSiliconFlowModel();

  if (!apiKey) {
    throw new Error(`${provider === "deepseek" ? "DEEPSEEK_API_KEY" : "SILICONFLOW_API_KEY"} is not configured`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens ?? 2000,
        response_format:
          provider === "deepseek"
            ? { type: "json_object" }
            : options.responseFormat,
        ...(provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: controller.signal,
    });

    const data = (await response.json()) as ChatCompletionResponse;

    if (!response.ok) {
      throw new Error(data.error?.message || "SiliconFlow request failed");
    }

    const message = data.choices?.[0]?.message;
    const content = (message?.content || message?.reasoning_content || "").trim();

    if (!content) {
      throw new Error(`${provider === "deepseek" ? "DeepSeek" : "SiliconFlow"} returned empty content`);
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createSiliconFlowChatCompletion(options: ChatCompletionOptions) {
  return createLlmChatCompletion({ ...options, provider: "siliconflow" });
}
