export const ASSISTANT_SETTINGS_CHANGED_EVENT = "pms:assistant-settings-changed";

export const emitAssistantSettingsChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ASSISTANT_SETTINGS_CHANGED_EVENT));
};
