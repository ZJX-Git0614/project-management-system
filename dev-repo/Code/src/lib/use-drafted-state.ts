"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// 把任意 JSON-safe state 同步到 localStorage，组件挂载时回填（SSR-safe）。
// - key 形如 "pmms.draft.item.monthly" / "pmms.draft.gantt.<projectId>"
// - 返回 [value, setValue, clear, isHydrated] 四个 API
// - 写入防抖 200ms，避免高频输入反复写盘
// - 只有"激活"(enabled)状态下的更改才写盘；初始/null 状态不会污染 localStorage
export function useDraftedState<T>(
  key: string,
  initial: T
): [T, (next: T | ((prev: T) => T)) => void, () => void, boolean] {
  const [value, setValueInternal] = useState<T>(initial);
  const valueRef = useRef<T>(initial);
  const enabledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  // 挂载时从 localStorage 回填
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as T;
        valueRef.current = parsed;
        setValueInternal(parsed);
        enabledRef.current = true;
      }
    } catch {
      // ignore parse error
    } finally {
      setIsHydrated(true);
    }
  }, [key]);

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValueInternal((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        valueRef.current = resolved;
        // 任何非 initial 的更新都视为激活草稿
        if (resolved !== null && resolved !== undefined) {
          enabledRef.current = true;
        }
        return resolved;
      });
    },
    []
  );

  // 写盘
  useEffect(() => {
    if (!isHydrated) return;
    if (typeof window === "undefined") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        if (!enabledRef.current || value === null) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, JSON.stringify(value));
        }
      } catch {
        // ignore quota error
      }
    }, 200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, value, isHydrated]);

  const clear = useCallback(() => {
    setValueInternal(initial);
    valueRef.current = initial;
    enabledRef.current = false;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  }, [key, initial]);

  return [value, setValue, clear, isHydrated];
}
