import type { Metadata } from "next";
import { Suspense } from "react";
import "@/app/globals.css";
import { AuthProvider } from "@/contexts/auth-context";
import { PermissionProvider } from "@/contexts/permission-context";
import { AppShell } from "@/components/app-shell";
import { ConfirmProvider } from "@/components/confirm-provider";

import { CurrentProjectProvider } from "@/contexts/current-project-context";

export const metadata: Metadata = {
  title: "Ceastar项目管理系统",
  description: "项目管理与进度追踪平台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthProvider>
          <PermissionProvider>
            <ConfirmProvider>
              <CurrentProjectProvider>
                <Suspense>
                  <AppShell>{children}</AppShell>
                </Suspense>
              </CurrentProjectProvider>
            </ConfirmProvider>
          </PermissionProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
