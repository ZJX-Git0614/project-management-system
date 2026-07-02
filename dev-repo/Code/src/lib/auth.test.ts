import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";

import { verifyTokenForRefresh, verifyTokenWithReason } from "@/lib/auth";

const secret = process.env.JWT_SECRET || "pmms-dev-jwt-secret-change-in-production";

describe("auth token verification", () => {
  it("keeps expired but signed tokens refreshable", () => {
    const token = jwt.sign(
      { userId: "user-1", username: "user", displayName: "User" },
      secret,
      { expiresIn: "-1s" },
    );

    const normalResult = verifyTokenWithReason(token);
    const refreshPayload = verifyTokenForRefresh(token);

    expect(normalResult).toEqual({ payload: null, error: "TOKEN_EXPIRED" });
    expect(refreshPayload?.userId).toBe("user-1");
  });

  it("rejects forged expired tokens during refresh", () => {
    const token = jwt.sign(
      { userId: "user-1", username: "user", displayName: "User" },
      "wrong-secret",
      { expiresIn: "-1s" },
    );

    expect(verifyTokenWithReason(token)).toEqual({ payload: null, error: "TOKEN_INVALID" });
    expect(verifyTokenForRefresh(token)).toBeNull();
  });
});
