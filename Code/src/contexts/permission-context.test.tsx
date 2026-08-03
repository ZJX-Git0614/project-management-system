import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider, usePermissionContext } from "@/contexts/permission-context";

const authState = vi.hoisted(() => ({
  user: null as {
    id: string;
    username: string;
    displayName: string;
    assignedRoleNames: string[];
    passwordResetRequired: boolean;
  } | null,
}));

const apiGet = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => authState,
}));

vi.mock("@/lib/api-client", () => ({
  api: { get: apiGet },
}));

function PermissionProbe() {
  const { can } = usePermissionContext();
  return <div data-testid="project-list-permission">{String(can("project-list:view"))}</div>;
}

describe("PermissionProvider", () => {
  beforeEach(() => {
    authState.user = null;
    apiGet.mockReset();
    apiGet.mockResolvedValue({
      data: {
        "外部查看者": ["project-list", "project-list:view"],
      },
    });
  });

  it("reloads the permission tree after login when the provider mounted before a token existed", async () => {
    const view = render(
      <PermissionProvider>
        <PermissionProbe />
      </PermissionProvider>,
    );

    expect(screen.getByTestId("project-list-permission")).toHaveTextContent("false");

    authState.user = {
      id: "user-1",
      username: "viewer",
      displayName: "查看者",
      assignedRoleNames: ["外部查看者"],
      passwordResetRequired: false,
    };
    view.rerender(
      <PermissionProvider>
        <PermissionProbe />
      </PermissionProvider>,
    );

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith("/api/permission-tree");
      expect(screen.getByTestId("project-list-permission")).toHaveTextContent("true");
    });
  });
});
