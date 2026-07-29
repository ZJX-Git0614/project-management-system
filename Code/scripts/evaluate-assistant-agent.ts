import {
  ASSISTANT_AGENT_EVALUATION_CASES,
  scoreAssistantAgentEvaluation,
  type AssistantAgentEvaluationPrediction,
} from "../src/lib/assistant-agent-evaluation";
import { ASSISTANT_TOOL_CATALOG } from "../src/lib/assistant-settings";

const baseUrl = (process.env.ASSISTANT_EVAL_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const useOllamaNative = process.env.ASSISTANT_EVAL_USE_OLLAMA_NATIVE !== "false";
const models = (process.env.ASSISTANT_EVAL_MODELS || "qwen3.5:4b,qwen3.5:9b").split(",").map((item) => item.trim()).filter(Boolean);
const allowed = new Set(ASSISTANT_TOOL_CATALOG.map((tool) => tool.id));
const catalog = ASSISTANT_TOOL_CATALOG.map((tool) => `${tool.id}: ${tool.description}${tool.routingHints?.length ? `；${tool.routingHints.join("；")}` : ""}`).join("\n");

const parsePrediction = (content: string): AssistantAgentEvaluationPrediction => {
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return { toolId: null, command: "" };
  try {
    const parsed = JSON.parse(json) as { toolId?: unknown; command?: unknown };
    return {
      toolId: typeof parsed.toolId === "string" && parsed.toolId.trim() ? parsed.toolId.trim() : null,
      command: typeof parsed.command === "string" ? parsed.command.trim() : "",
    };
  } catch {
    return { toolId: null, command: "" };
  }
};

const main = async () => {
  for (const model of models) {
    const predictions = new Map<string, AssistantAgentEvaluationPrediction>();
    for (const [caseIndex, item] of ASSISTANT_AGENT_EVALUATION_CASES.entries()) {
      process.stderr.write(`[${model}] ${caseIndex + 1}/${ASSISTANT_AGENT_EVALUATION_CASES.length} ${item.id}\n`);
      const messages = [
        { role: "system", content: `你是项目管理 Agent 规划器。只选择白名单工具。若只是问问题、输入含糊或没有明确执行意图，toolId 返回 null。command 必须保留用户给出的编号、百分比、名称和动作，不得复制工具描述代替命令。只输出 JSON {"toolId":string|null,"command":string}。\n${catalog}` },
        { role: "user", content: `指令：${item.message}\n附件：${JSON.stringify(item.attachmentNames ?? [])}` },
      ];
      const response = await fetch(useOllamaNative ? `${baseUrl.replace(/\/v1$/u, "")}/api/chat` : `${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.ASSISTANT_EVAL_API_KEY || "ollama"}` },
        body: JSON.stringify(useOllamaNative
          ? { model, think: false, stream: false, options: { temperature: 0, num_predict: 180 }, messages }
          : { model, temperature: 0, max_tokens: 180, messages }),
      });
      if (!response.ok) throw new Error(`${model} 评测请求失败：HTTP ${response.status} ${await response.text()}`);
      const payload = await response.json() as { message?: { content?: string }; choices?: Array<{ message?: { content?: string } }> };
      predictions.set(item.id, parsePrediction(payload.message?.content || payload.choices?.[0]?.message?.content || ""));
    }
    const metrics = scoreAssistantAgentEvaluation(predictions, allowed);
    process.stdout.write(`${JSON.stringify({ model, metrics, predictions: Object.fromEntries(predictions) }, null, 2)}\n`);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
