import { describe, expect, it } from "vitest";

import {
  ASSISTANT_AGENT_EVALUATION_CASES,
  scoreAssistantAgentEvaluation,
} from "@/lib/assistant-agent-evaluation";
import { ASSISTANT_TOOL_CATALOG } from "@/lib/assistant-settings";

describe("assistant small-model evaluation", () => {
  it("scores intent, parameter cues, executable output and whitelist violations separately", () => {
    const predictions = new Map(ASSISTANT_AGENT_EVALUATION_CASES.map((item) => [item.id, {
      toolId: item.expectedToolId,
      command: item.expectedToolId ? `${item.message} ${item.expectedCommandCues?.join(" ") || "执行"}` : "",
    }]));
    const metrics = scoreAssistantAgentEvaluation(predictions, new Set(ASSISTANT_TOOL_CATALOG.map((tool) => tool.id)));

    expect(metrics).toMatchObject({
      intentSelectionAccuracy: 1,
      parameterCueAccuracy: 1,
      executablePlanRate: 1,
      whitelistViolations: 0,
      targetPassed: true,
    });
  });
});
