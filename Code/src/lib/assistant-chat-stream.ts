import type { AssistantPublicTraceEvent } from "@/lib/assistant-intent-contract";

export type AssistantChatStreamEvent =
  | { type: "trace"; event: AssistantPublicTraceEvent }
  | { type: "answer_delta"; delta: string }
  | { type: "answer_reset" }
  | { type: "result"; data: Record<string, unknown> }
  | { type: "error"; error: string };

export const upsertAssistantTraceEvent = (
  events: AssistantPublicTraceEvent[],
  nextEvent: AssistantPublicTraceEvent,
) => {
  const index = events.findIndex((event) => event.id === nextEvent.id);
  if (index < 0) return [...events, nextEvent];
  const next = [...events];
  next[index] = nextEvent;
  return next;
};

export const encodeAssistantChatStreamEvent = (event: AssistantChatStreamEvent) => (
  `${JSON.stringify(event)}\n`
);
