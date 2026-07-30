import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { ASSISTANT_TOOL_CATALOG, type AssistantRuntimeConfig } from "@/lib/assistant-settings";

const MANUAL_PATH = resolve(process.cwd(), "docs/佳佳智能助手使用手册.md");

let cachedManual = "";

export const loadAssistantManual = () => {
  if (cachedManual) return cachedManual;
  try {
    cachedManual = readFileSync(MANUAL_PATH, "utf8").trim();
  } catch {
    cachedManual = "佳佳只能执行系统白名单内且当前账号有权限的操作；不支持的操作必须明确说明。";
  }
  return cachedManual;
};

const OPERATION_QUESTION = /怎么|如何|怎样|在哪|哪里|操作|使用|能否|能不能|你能|是否支持|可否|可不可以|可以吗|怎么做|步骤|教程|手册|说明/u;

const SCHEDULE_CONVERSION_CAPABILITY_QUESTION = /(mpp|project\s*xml|\.xml|\.xlsx|excel|甘特|进度计划).{0,40}(输出|导出|下载|转换|转成|转为|整理成|做成|生成|制作|格式|支持|可以|能)|(?:输出|导出|下载|转换|转成|转为|整理成|做成|生成|制作).{0,40}(mpp|project\s*xml|\.xml|\.xlsx|excel|甘特|进度计划)/iu;

export const isAssistantManualQuestion = (message: string) => OPERATION_QUESTION.test(String(message || ""));

export const buildAssistantCapabilityAnswer = (params: {
  message: string;
  runtime: Pick<AssistantRuntimeConfig, "agentEnabled" | "agentEnabledToolIds">;
  attachments: Array<{ fileName: string }>;
}) => {
  if (!SCHEDULE_CONVERSION_CAPABILITY_QUESTION.test(params.message)) return "";
  const conversionTool = ASSISTANT_TOOL_CATALOG.find((tool) => tool.id === "schedule.convert.file");
  const supportedExtensions = conversionTool?.attachments?.extensions ?? [];
  const formatNames = supportedExtensions.map((extension) => ({
    ".mpp": "MPP",
    ".xml": "Microsoft Project XML",
    ".xlsx": "系统 Excel",
  }[extension] ?? extension));
  const formatLabel = formatNames.join("、");
  const conversionEnabled = params.runtime.agentEnabled
    && params.runtime.agentEnabledToolIds.includes("schedule.convert.file");
  if (!conversionEnabled) {
    return `系统的项目进度管理支持导入 ${formatLabel}，但当前管理员没有启用佳佳的“转换进度计划”工具。您仍可在项目进度管理中手动导入，或联系管理员启用该工具。`;
  }
  if (params.attachments.length === 1 && supportedExtensions.includes(extname(params.attachments[0].fileName).toLocaleLowerCase("en-US"))) {
    return `可以。我会把当前 ${formatLabel} 附件转换为系统可导入 Excel，重新校验任务数量后提供下载；转换过程不会直接修改项目进度。`;
  }
  if (params.attachments.length > 0) {
    return `单文件进度计划转换仅支持 ${formatLabel}。请只保留一个受支持的附件后重试；转换不会直接写入项目进度。`;
  }
  return `可以。请上传一个 ${formatLabel} 文件，然后说明“转换为系统甘特任务格式”。佳佳会生成经过任务数量校验的系统可导入 Excel，并提供下载，不会直接写入项目进度。`;
};

export const searchAssistantManual = (message: string) => {
  if (!isAssistantManualQuestion(message)) return "";
  const manual = loadAssistantManual();
  const sections = manual.split(/(?=^##\s)/m);
  const tokens = String(message || "")
    .replace(/[，。！？、,.!?：:；;（）()]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const ranked = sections
    .map((section) => ({
      section,
      score: tokens.reduce((score, token) => score + (section.includes(token) ? 2 : 0), 0)
        + (/任务|甘特|层级|子任务|全屏|进度/u.test(message) && /项目进度管理/u.test(section) ? 6 : 0)
        + (/事项/u.test(message) && /项目事项管理/u.test(section) ? 6 : 0)
        + (/风险/u.test(message) && /风险登记册/u.test(section) ? 6 : 0)
        + (/权限|批准|访问/u.test(message) && /Agent 授权模式/u.test(section) ? 6 : 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((item) => item.section.trim());
  return ranked.length > 0 ? ranked.join("\n\n") : sections.slice(0, 2).join("\n\n").trim();
};
