"use client";

import { createContext, useContext } from "react";

interface ProjectReadOnlyContextValue {
  isReadOnly: boolean;
  statusLabel: string;
}

const ProjectReadOnlyContext = createContext<ProjectReadOnlyContextValue>({
  isReadOnly: false,
  statusLabel: "",
});

export function ProjectReadOnlyProvider({
  isReadOnly,
  statusLabel,
  children,
}: {
  isReadOnly: boolean;
  statusLabel: string;
  children: React.ReactNode;
}) {
  return (
    <ProjectReadOnlyContext.Provider value={{ isReadOnly, statusLabel }}>
      {children}
    </ProjectReadOnlyContext.Provider>
  );
}

export function useProjectReadOnly(): ProjectReadOnlyContextValue {
  return useContext(ProjectReadOnlyContext);
}
