import { Prisma } from "@prisma/client";

import { FLAT_PERMISSION_NODES } from "@/lib/permissions";
import { ASSISTANT_TOOL_CATALOG } from "@/lib/assistant-settings";
import { getProjectModuleRegistry } from "@/lib/module-registry";

const sensitiveFieldPattern = /(password|secret|token|apiKey|hash|encrypted|credential)/iu;

export type AssistantCapabilitySnapshot = {
  modules: Array<{ key: string; label: string }>;
  tools: Array<{ id: string; version: number; permissions: readonly string[] }>;
  projectModels: Array<{ name: string; fields: string[]; executable: boolean }>;
};

export const buildAssistantCapabilitySnapshot = (enabledToolIds: ReadonlySet<string>): AssistantCapabilitySnapshot => {
  const tools = ASSISTANT_TOOL_CATALOG
    .filter((tool) => enabledToolIds.has(tool.id))
    .map((tool) => ({ id: tool.id, version: tool.version, permissions: tool.permissions }));
  const executablePermissionPrefixes = new Set(tools
    .flatMap((tool) => tool.permissions)
    .map((permission) => permission.split(":")[0]));
  const registeredModules = getProjectModuleRegistry().map((module) => ({ key: module.key, label: module.label }));
  const permissionModules = FLAT_PERMISSION_NODES
    .filter((node) => node.type === "page" || node.type === "section")
    .map((node) => ({ key: node.key, label: node.label }));
  const modules = Array.from(new Map(
    [...registeredModules, ...permissionModules].map((module) => [module.key, module]),
  ).values());
  const projectModels = Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "projectId"))
    .map((model) => {
      const fields = model.fields
        .filter((field) => field.kind === "scalar" && !sensitiveFieldPattern.test(field.name))
        .map((field) => field.name);
      const normalizedName = model.name.toLocaleLowerCase("en-US");
      const executable = Array.from(executablePermissionPrefixes).some((prefix) => (
        normalizedName.includes(prefix.replaceAll("-", ""))
      ));
      return { name: model.name, fields, executable };
    });
  return { modules, tools, projectModels };
};

export const formatAssistantCapabilitySnapshot = (snapshot: AssistantCapabilitySnapshot) => [
  `当前模块：${snapshot.modules.map((module) => `${module.label}(${module.key})`).join("、") || "无"}`,
  `已注册可执行工具：${snapshot.tools.map((tool) => `${tool.id}@${tool.version}`).join("、") || "无"}`,
  `当前项目数据结构：${snapshot.projectModels.map((model) => `${model.name}(${model.fields.join(",")})`).join("；") || "无"}`,
  "数据结构仅用于理解当前版本字段；只有已注册工具可以执行操作，发现新表或新字段不等于获得查询或写入权限。",
].join("\n");
