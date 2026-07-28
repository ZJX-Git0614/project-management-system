import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const OPERATION_QUESTION = /怎么|如何|怎样|在哪|哪里|操作|使用|能不能|是否支持|可不可以|怎么做|步骤|教程|手册|说明/u;

export const isAssistantManualQuestion = (message: string) => OPERATION_QUESTION.test(String(message || ""));

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
