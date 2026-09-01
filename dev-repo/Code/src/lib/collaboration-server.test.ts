import { describe, expect, it } from "vitest";

import { TodoType } from "@/domain/enums";
import {
  collaborationMentionTodoWhere,
  collaborationNotificationWhere,
} from "@/lib/collaboration-server";

describe("collaboration todo scoping", () => {
  it("marks only the current thread's mention todos as read", () => {
    expect(collaborationMentionTodoWhere("thread-1", "account-1")).toEqual({
      collaborationThreadId: "thread-1",
      targetAccountId: "account-1",
      type: TodoType.COLLABORATION_MENTION,
      status: "OPEN",
    });
  });

  it("marks thread notifications and legacy message notifications as read", () => {
    expect(collaborationNotificationWhere("thread-1", "account-1", ["message-1", "message-2"])).toEqual({
      accountId: "account-1",
      status: "UNREAD",
      OR: [
        { sourceType: "COLLABORATION_THREAD", sourceId: "thread-1" },
        { sourceType: "COLLABORATION_MESSAGE", sourceId: { in: ["message-1", "message-2"] } },
      ],
    });
  });
});
