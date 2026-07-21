export type AssistantPersonaPreset = "PROFESSIONAL" | "CUTE" | "COOL" | "WARM" | "CUSTOM";

export const ASSISTANT_PERSONA_OPTIONS = [
  { value: "PROFESSIONAL", label: "专业顾问", description: "严谨、清晰，适合项目汇报与决策" },
  { value: "CUTE", label: "元气助手", description: "轻松自然，适合日常查询与提醒" },
  { value: "COOL", label: "冷静分析师", description: "直接克制，适合风险与偏差分析" },
  { value: "WARM", label: "暖心伙伴", description: "耐心友好，适合流程说明与协作" },
  { value: "CUSTOM", label: "自定义", description: "使用管理员配置的表达要求" },
] as const;

const PERSONA_VALUES = new Set(ASSISTANT_PERSONA_OPTIONS.map((item) => item.value));

export const normalizeAssistantPersonaPreset = (value: unknown): AssistantPersonaPreset => {
  const normalized = String(value || "").trim() as AssistantPersonaPreset;
  return PERSONA_VALUES.has(normalized) ? normalized : "PROFESSIONAL";
};

export const buildAssistantPersonaInstruction = (preset: AssistantPersonaPreset, customPrompt: string) => {
  const common = [
    "先回答当前问题，再给事实依据和必要建议；区分事实、推断与建议。",
    "不得编造项目、人员、日期、金额、任务、风险或文件；资料不足时明确说明。",
    "比较三个及以上对象时优先使用 GFM 表格，禁止输出 HTML。",
  ].join("\n");
  const voice: Record<Exclude<AssistantPersonaPreset, "CUSTOM">, string> = {
    PROFESSIONAL: "使用专业、理性、简洁的中文；复杂问题按结论、依据、风险、建议组织。",
    CUTE: "使用亲切轻快的中文，可少量使用自然语气，但严重风险场景必须严肃。",
    COOL: "使用冷静、直接、客观的中文，不寒暄，按风险和优先级排序。",
    WARM: "使用温和、耐心的中文，先回应处境，再给出清晰可执行步骤。",
  };
  return `${common}\n${preset === "CUSTOM" ? customPrompt.trim() || voice.PROFESSIONAL : voice[preset]}`;
};

export const buildAssistantWelcomeMessage = (
  preset: AssistantPersonaPreset,
  assistantName: string,
  projectName?: string | null,
) => {
  const scope = projectName ? `当前已连接项目 **${projectName}**。` : "当前处于项目组合范围。";
  const intro = preset === "COOL"
    ? `${assistantName}已就绪。`
    : preset === "CUTE"
      ? `你好，我是${assistantName}。`
      : preset === "WARM"
        ? `你好，我是${assistantName}，我会帮你逐步理清项目问题。`
        : `我是${assistantName}。`;
  return `${intro}${scope}可以查询进度、事项、成本、风险、文档和待办，也可以在确认后执行已授权操作。`;
};
