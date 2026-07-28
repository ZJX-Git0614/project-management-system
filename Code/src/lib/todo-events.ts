export const TODO_CHANGED_EVENT = "pms:todo-changed";
export const TODO_CHANGED_STORAGE_KEY = "pms:todo-changed-at";

export function emitTodoChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TODO_CHANGED_EVENT));
  try {
    localStorage.setItem(TODO_CHANGED_STORAGE_KEY, String(Date.now()));
  } catch {
    // ignore storage failures
  }
}
