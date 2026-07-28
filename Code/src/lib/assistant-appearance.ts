export type AssistantAvatarPalette = "ICE" | "VIOLET" | "MINT" | "AMBER" | "ROSE";
export type AssistantAvatarStyle = "ROUNDED" | "CABIN" | "MINIMAL";

export const ASSISTANT_AVATAR_PALETTE_OPTIONS = [
  { value: "ICE", label: "冰晶青", swatchClassName: "bg-cyan-300" },
  { value: "VIOLET", label: "星云紫", swatchClassName: "bg-violet-300" },
  { value: "MINT", label: "薄荷绿", swatchClassName: "bg-emerald-300" },
  { value: "AMBER", label: "晨光金", swatchClassName: "bg-amber-300" },
  { value: "ROSE", label: "珊瑚粉", swatchClassName: "bg-rose-300" },
] as const;

export const ASSISTANT_AVATAR_STYLE_OPTIONS = [
  { value: "ROUNDED", label: "星核伙伴", description: "圆润亲和的陪伴型机体" },
  { value: "CABIN", label: "领航方舱", description: "利落可靠的任务型机体" },
  { value: "MINIMAL", label: "光环智体", description: "轻盈克制的悬浮型机体" },
] as const;

const PALETTES = new Set(ASSISTANT_AVATAR_PALETTE_OPTIONS.map((item) => item.value));
const STYLES = new Set(ASSISTANT_AVATAR_STYLE_OPTIONS.map((item) => item.value));

export const normalizeAssistantAvatarPalette = (value: unknown): AssistantAvatarPalette => {
  const normalized = String(value || "").trim() as AssistantAvatarPalette;
  return PALETTES.has(normalized) ? normalized : "ICE";
};

export const normalizeAssistantAvatarStyle = (value: unknown): AssistantAvatarStyle => {
  const normalized = String(value || "").trim() as AssistantAvatarStyle;
  return STYLES.has(normalized) ? normalized : "ROUNDED";
};
