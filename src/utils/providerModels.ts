/*
 * File: providerModels.ts
 * Static model definitions for third-party providers.
 *
 * These models are merged with Qwen's dynamic model list in the /v1/models response.
 * Update this file when adding or removing GLM models.
 */

export interface ProviderModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  description?: string;
}

// Base created timestamp — used so models sort consistently
const CREATED = 1_782_414_000; // 2026-06-25

export const PROVIDER_MODELS: ProviderModelEntry[] = [
  // ── DeepSeek ────────────────────────────────────────────
  // chat.deepseek.com's web API has no GET /models endpoint. Model selection
  // is done via the `model_type` field on chat/completion, and the catalog is
  // served dynamically by the remote feature store (`model_configs`, verified
  // live 2026-08): model_type default ("Instant"), expert ("Expert"),
  // vision ("Vision"). The entries below expose the real three plus legacy
  // aliases (deepseek-chat/reasoner/vl2) and common client names
  // (deepseek-v4-flash / deepseek-v4-pro), all mapped in pipeline.ts.
  {
    id: 'deepseek/deepseek-instant',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Instant — fast responses for daily conversations (model_type default)',
  },
  {
    id: 'deepseek/deepseek-expert',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Expert — deep reasoning for complex problems (model_type expert)',
  },
  {
    id: 'deepseek/deepseek-vision',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Vision — image understanding (Beta, model_type vision)',
  },
  {
    id: 'deepseek/deepseek-chat',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Chat — alias for Instant (model_type default)',
  },
  {
    id: 'deepseek/deepseek-reasoner',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Reasoner — alias for Expert / DeepThink (model_type expert)',
  },
  {
    id: 'deepseek/deepseek-vl2',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek VL2 — alias for Vision (model_type vision)',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek V4 Flash — alias for Instant (model_type default)',
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek V4 Pro — alias for Expert (model_type expert)',
  },
  // ── GLM (Zhipu) ──────────────────────────────────────────
  {
    id: 'glm/glm-5.2',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-5.2 — flagship model, excels at coding and long-horizon tasks',
  },
  {
    id: 'glm/glm-5.1',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-5.1',
  },
  {
    id: 'glm/glm-5',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-5',
  },
  {
    id: 'glm/glm-4.7-flash',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.7 Flash — fast and efficient',
  },
  {
    id: 'glm/glm-4.7',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.7',
  },
  {
    id: 'glm/glm-4.6',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.6',
  },
  {
    id: 'glm/glm-4.5-air',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.5 Air — lightweight',
  },
  {
    id: 'glm/glm-4.5',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.5',
  },
];

export const PROVIDER_MODEL_SPECS: Record<string, { max_context: number; max_output: number; modalities: string[] }> = {
  // Context window is MEASURED against the chat.deepseek.com WEB endpoint we
  // actually proxy (2026-08 live test): prompts over ~163,840 chars (~160 KiB)
  // are rejected with "Content is too long. Please shorten it and try again."
  // (an SSE hint event, char-based — a 100K-char base64 prompt ≈ 100K tokens
  // passes, 164K chars fails). api-docs.deepseek.com advertises 1M tokens for
  // the API models, but the web endpoint does NOT honor that — advertising 1M
  // made Hermes never compact, so sessions grew until the web API rejected
  // them.
  //
  // Advertise 64K tokens — the LOWEST window Hermes accepts (it hard-refuses
  // models with an advertised context below 64,000, verified live 2026-08).
  // This still keeps clients compacting before the real wall: Hermes's
  // compression triggers at 50% of the window = 32K tokens ≈ ~128K chars of
  // English at 4 chars/token, comfortably under the ~164K char cap. (36K was
  // even safer but blocks Hermes from starting at all.)
  'deepseek/deepseek-instant': { max_context: 65536, max_output: 16384, modalities: ['text'] },
  'deepseek/deepseek-expert': { max_context: 65536, max_output: 16384, modalities: ['text'] },
  'deepseek/deepseek-vision': { max_context: 65536, max_output: 8192, modalities: ['text', 'image'] },
  'deepseek/deepseek-chat': { max_context: 65536, max_output: 16384, modalities: ['text'] },
  'deepseek/deepseek-reasoner': { max_context: 65536, max_output: 16384, modalities: ['text'] },
  'deepseek/deepseek-vl2': { max_context: 65536, max_output: 8192, modalities: ['text', 'image'] },
  'deepseek/deepseek-v4-flash': { max_context: 65536, max_output: 16384, modalities: ['text'] },
  'deepseek/deepseek-v4-pro': { max_context: 65536, max_output: 16384, modalities: ['text'] },
  'glm/glm-5.2': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-5.1': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-5': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.7-flash': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.7': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.6': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.5-air': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.5': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
};
