"use client";

import { type RefObject, useEffect, useRef } from "react";

const INTERACTIVE_PORTAL_SELECTOR = [
  ".gantt-context-menu",
  "[data-slot='dropdown-menu-content']",
  "[data-radix-popper-content-wrapper]",
  "[role='listbox']",
].join(",");

export const useCommitOnOutsidePointer = (
  enabled: boolean,
  containerRef: RefObject<HTMLElement | null>,
  commit: () => void | Promise<void>,
) => {
  const commitRef = useRef(commit);

  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  useEffect(() => {
    if (!enabled) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(INTERACTIVE_PORTAL_SELECTOR)) return;
      void commitRef.current();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [containerRef, enabled]);
};
