import type { ProviderAppType } from '../lib/db';

export interface ProviderPreset {
  name: string;
  websiteUrl: string;
  settingsConfig: string;
  category: string;
  appType: ProviderAppType;
}

function claudePreset(
  name: string,
  websiteUrl: string,
  env: Record<string, string | number>,
  category: string,
): ProviderPreset {
  return {
    name,
    websiteUrl,
    settingsConfig: JSON.stringify({ env }, null, 2),
    category,
    appType: 'claude',
  };
}

function codexPreset(
  name: string,
  websiteUrl: string,
  config: string,
  category: string,
  hasAuth = true,
): ProviderPreset {
  const auth = hasAuth ? 'api_key = ""\n' : '';
  return {
    name,
    websiteUrl,
    settingsConfig: JSON.stringify({ auth, config }),
    category,
    appType: 'codex',
  };
}

// ── Claude Presets ──

export const CLAUDE_PRESETS: ProviderPreset[] = [
  claudePreset('Claude Official', 'https://www.anthropic.com/claude-code', {}, 'official'),
  claudePreset('DeepSeek', 'https://platform.deepseek.com', {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'DeepSeek-V3.2',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'DeepSeek-V3.2', ANTHROPIC_DEFAULT_SONNET_MODEL: 'DeepSeek-V3.2', ANTHROPIC_DEFAULT_OPUS_MODEL: 'DeepSeek-V3.2',
  }, 'cn_official'),
  claudePreset('Zhipu GLM', 'https://open.bigmodel.cn', {
    ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'glm-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
  }, 'cn_official'),
  claudePreset('Bailian', 'https://bailian.console.aliyun.com', {
    ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic', ANTHROPIC_AUTH_TOKEN: '',
  }, 'cn_official'),
  claudePreset('Bailian For Coding', 'https://bailian.console.aliyun.com', {
    ANTHROPIC_BASE_URL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', ANTHROPIC_AUTH_TOKEN: '',
  }, 'cn_official'),
  claudePreset('Kimi', 'https://platform.moonshot.cn/console', {
    ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'kimi-k2.5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.5',
  }, 'cn_official'),
  claudePreset('Kimi For Coding', 'https://www.kimi.com/coding/docs/', {
    ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/', ANTHROPIC_AUTH_TOKEN: '',
  }, 'cn_official'),
  claudePreset('StepFun', 'https://platform.stepfun.ai', {
    ANTHROPIC_BASE_URL: 'https://api.stepfun.ai/v1', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'step-3.5-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'step-3.5-flash', ANTHROPIC_DEFAULT_SONNET_MODEL: 'step-3.5-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'step-3.5-flash',
  }, 'cn_official'),
  claudePreset('ModelScope', 'https://modelscope.cn', {
    ANTHROPIC_BASE_URL: 'https://api-inference.modelscope.cn', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'ZhipuAI/GLM-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ZhipuAI/GLM-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'ZhipuAI/GLM-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'ZhipuAI/GLM-5',
  }, 'aggregator'),
  claudePreset('Longcat', 'https://longcat.chat/platform', {
    ANTHROPIC_BASE_URL: 'https://api.longcat.chat/anthropic', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'LongCat-Flash-Chat',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'LongCat-Flash-Chat', ANTHROPIC_DEFAULT_SONNET_MODEL: 'LongCat-Flash-Chat', ANTHROPIC_DEFAULT_OPUS_MODEL: 'LongCat-Flash-Chat',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '6000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
  }, 'cn_official'),
  claudePreset('MiniMax', 'https://platform.minimaxi.com', {
    ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic', ANTHROPIC_AUTH_TOKEN: '',
    API_TIMEOUT_MS: '3000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
    ANTHROPIC_MODEL: 'MiniMax-M2.5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.5',
  }, 'cn_official'),
  claudePreset('DouBaoSeed', 'https://www.volcengine.com/product/doubao', {
    ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding', ANTHROPIC_AUTH_TOKEN: '',
    API_TIMEOUT_MS: '3000000',
    ANTHROPIC_MODEL: 'doubao-seed-2-0-code-preview-latest',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'doubao-seed-2-0-code-preview-latest', ANTHROPIC_DEFAULT_SONNET_MODEL: 'doubao-seed-2-0-code-preview-latest', ANTHROPIC_DEFAULT_OPUS_MODEL: 'doubao-seed-2-0-code-preview-latest',
  }, 'cn_official'),
  claudePreset('BaiLing', 'https://alipaytbox.yuque.com/sxs0ba/ling/get_started', {
    ANTHROPIC_BASE_URL: 'https://api.tbox.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'Ling-2.5-1T',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Ling-2.5-1T', ANTHROPIC_DEFAULT_SONNET_MODEL: 'Ling-2.5-1T', ANTHROPIC_DEFAULT_OPUS_MODEL: 'Ling-2.5-1T',
  }, 'cn_official'),
  claudePreset('Xiaomi MiMo', 'https://platform.xiaomimimo.com', {
    ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'mimo-v2-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2-flash', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2-flash',
  }, 'cn_official'),
  claudePreset('AiHubMix', 'https://aihubmix.com', {
    ANTHROPIC_BASE_URL: 'https://aihubmix.com', ANTHROPIC_API_KEY: '',
  }, 'aggregator'),
  claudePreset('SiliconFlow', 'https://siliconflow.cn', {
    ANTHROPIC_BASE_URL: 'https://api.siliconflow.cn', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.5',
  }, 'aggregator'),
  claudePreset('OpenRouter', 'https://openrouter.ai', {
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4.6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6', ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-4.6',
  }, 'aggregator'),
  claudePreset('Novita AI', 'https://novita.ai', {
    ANTHROPIC_BASE_URL: 'https://api.novita.ai/anthropic', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'zai-org/glm-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'zai-org/glm-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'zai-org/glm-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'zai-org/glm-5',
  }, 'aggregator'),
  claudePreset('Nvidia', 'https://build.nvidia.com', {
    ANTHROPIC_BASE_URL: 'https://integrate.api.nvidia.com', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'moonshotai/kimi-k2.5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'moonshotai/kimi-k2.5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'moonshotai/kimi-k2.5',
  }, 'aggregator'),
  claudePreset('DMXAPI', 'https://www.dmxapi.cn', {
    ANTHROPIC_BASE_URL: 'https://www.dmxapi.cn', ANTHROPIC_AUTH_TOKEN: '',
  }, 'aggregator'),
  claudePreset('Compshare', 'https://www.compshare.cn', {
    ANTHROPIC_BASE_URL: 'https://api.modelverse.cn', ANTHROPIC_AUTH_TOKEN: '',
  }, 'aggregator'),
  claudePreset('PackyCode', 'https://www.packyapi.com', {
    ANTHROPIC_BASE_URL: 'https://www.packyapi.com', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('Cubence', 'https://cubence.com', {
    ANTHROPIC_BASE_URL: 'https://api.cubence.com', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('AIGoCode', 'https://aigocode.com', {
    ANTHROPIC_BASE_URL: 'https://api.aigocode.com', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('RightCode', 'https://www.right.codes', {
    ANTHROPIC_BASE_URL: 'https://www.right.codes/claude', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('AICodeMirror', 'https://www.aicodemirror.com', {
    ANTHROPIC_BASE_URL: 'https://api.aicodemirror.com/api/claudecode', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('AICoding', 'https://aicoding.sh', {
    ANTHROPIC_BASE_URL: 'https://api.aicoding.sh', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('CrazyRouter', 'https://www.crazyrouter.com', {
    ANTHROPIC_BASE_URL: 'https://crazyrouter.com', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('SSSAiCode', 'https://www.sssaicode.com', {
    ANTHROPIC_BASE_URL: 'https://node-hk.sssaicode.com/api', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('Micu', 'https://www.openclaudecode.cn', {
    ANTHROPIC_BASE_URL: 'https://www.openclaudecode.cn', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('X-Code API', 'https://x-code.cc', {
    ANTHROPIC_BASE_URL: 'https://x-code.cc', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('CTok.ai', 'https://ctok.ai', {
    ANTHROPIC_BASE_URL: 'https://api.ctok.ai', ANTHROPIC_AUTH_TOKEN: '',
  }, 'third_party'),
  claudePreset('GitHub Copilot', 'https://github.com/features/copilot', {
    ANTHROPIC_BASE_URL: 'https://api.githubcopilot.com',
    ANTHROPIC_MODEL: 'claude-opus-4.6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4.5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4.6', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4.6',
  }, 'third_party'),
  claudePreset('AWS Bedrock (AKSK)', 'https://aws.amazon.com/bedrock/', {
    ANTHROPIC_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_REGION: 'us-east-1',
    ANTHROPIC_MODEL: 'global.anthropic.claude-opus-4-6-v1',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-4-6',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-4-6-v1',
    CLAUDE_CODE_USE_BEDROCK: '1',
  }, 'cloud_provider'),
];

// ── Codex Presets ──

function codexThirdParty(name: string, websiteUrl: string, providerKey: string, baseUrl: string): ProviderPreset {
  const config = `model_provider = "${providerKey}"
model = "gpt-5.4"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.${providerKey}]
name = "${providerKey}"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true
`;
  return codexPreset(name, websiteUrl, config, 'third_party');
}

export const CODEX_PRESETS: ProviderPreset[] = [
  codexPreset('OpenAI Official', 'https://chatgpt.com/codex', '', 'official', false),
  codexPreset('Azure OpenAI', 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/codex',
    `model_provider = "azure"\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "high"\ndisable_response_storage = true\n\n[model_providers.azure]\nname = "Azure OpenAI"\nbase_url = "https://YOUR_RESOURCE_NAME.openai.azure.com/openai"\nenv_key = "OPENAI_API_KEY"\nquery_params = { "api-version" = "2025-04-01-preview" }\nwire_api = "responses"\nrequires_openai_auth = true\n`,
    'cloud_provider'),
  codexThirdParty('AiHubMix', 'https://aihubmix.com', 'aihubmix', 'https://aihubmix.com/v1'),
  codexThirdParty('DMXAPI', 'https://www.dmxapi.cn', 'dmxapi', 'https://www.dmxapi.cn/v1'),
  codexThirdParty('PackyCode', 'https://www.packyapi.com', 'packycode', 'https://www.packyapi.com/v1'),
  codexThirdParty('Cubence', 'https://cubence.com', 'cubence', 'https://api.cubence.com/v1'),
  codexThirdParty('AIGoCode', 'https://aigocode.com', 'aigocode', 'https://api.aigocode.com'),
  codexThirdParty('RightCode', 'https://www.right.codes', 'rightcode', 'https://right.codes/codex/v1'),
  codexThirdParty('AICodeMirror', 'https://www.aicodemirror.com', 'aicodemirror', 'https://api.aicodemirror.com/api/codex/backend-api/codex'),
  codexThirdParty('AICoding', 'https://aicoding.sh', 'aicoding', 'https://api.aicoding.sh'),
  codexThirdParty('CrazyRouter', 'https://www.crazyrouter.com', 'crazyrouter', 'https://crazyrouter.com/v1'),
  codexThirdParty('SSSAiCode', 'https://www.sssaicode.com', 'sssaicode', 'https://node-hk.sssaicode.com/api/v1'),
  codexThirdParty('Compshare', 'https://www.compshare.cn', 'compshare', 'https://api.modelverse.cn/v1'),
  codexThirdParty('Micu', 'https://www.openclaudecode.cn', 'micu', 'https://www.openclaudecode.cn/v1'),
  codexThirdParty('X-Code API', 'https://x-code.cc', 'x-code', 'https://x-code.cc/v1'),
  codexThirdParty('CTok.ai', 'https://ctok.ai', 'ctok', 'https://api.ctok.ai/v1'),
  codexThirdParty('OpenRouter', 'https://openrouter.ai', 'openrouter', 'https://openrouter.ai/api/v1'),
];

export function getPresets(appType: ProviderAppType): ProviderPreset[] {
  return appType === 'claude' ? CLAUDE_PRESETS : CODEX_PRESETS;
}

const CATEGORY_ORDER: Record<string, number> = {
  official: 0, cn_official: 1, cloud_provider: 2, aggregator: 3, third_party: 4, custom: 5,
};
const CATEGORY_LABELS: Record<string, string> = {
  official: 'Official', cn_official: 'CN Official', cloud_provider: 'Cloud',
  aggregator: 'Aggregator', third_party: 'Third Party', custom: 'Custom',
};

export function getPresetsGrouped(appType: ProviderAppType): { label: string; presets: ProviderPreset[] }[] {
  const all = getPresets(appType);
  const groups = new Map<string, ProviderPreset[]>();
  for (const p of all) {
    const cat = p.category || 'custom';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(p);
  }
  return [...groups.entries()]
    .sort((a, b) => (CATEGORY_ORDER[a[0]] ?? 99) - (CATEGORY_ORDER[b[0]] ?? 99))
    .map(([cat, presets]) => ({ label: CATEGORY_LABELS[cat] || cat, presets }));
}
