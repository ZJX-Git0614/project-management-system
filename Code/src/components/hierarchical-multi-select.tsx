"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Minus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface HierarchicalSelectOption {
  id: string;
  label: string;
  secondaryLabel?: string;
  searchText?: string;
  parentId?: string | null;
  disabled?: boolean;
}

export interface HierarchicalSelectionState {
  checked: boolean;
  indeterminate: boolean;
}

export const getHierarchicalSelectionState = (
  optionId: string,
  descendantsById: ReadonlyMap<string, readonly string[]>,
  selectedIds: ReadonlySet<string>,
): HierarchicalSelectionState => {
  const subtree = descendantsById.get(optionId) ?? [optionId];
  const selectedCount = subtree.filter((id) => selectedIds.has(id)).length;
  return {
    checked: subtree.length > 0 && selectedCount === subtree.length,
    indeterminate: selectedCount > 0 && selectedCount < subtree.length,
  };
};

const highlightText = (text: string, query: string) => {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = normalizedQuery.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = lowerText.indexOf(lowerQuery, cursor);
  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex));
    parts.push(
      <mark key={`${matchIndex}-${cursor}`} className="rounded bg-primary/25 px-0.5 text-primary-foreground">
        {text.slice(matchIndex, matchIndex + normalizedQuery.length)}
      </mark>,
    );
    cursor = matchIndex + normalizedQuery.length;
    matchIndex = lowerText.indexOf(lowerQuery, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
};

const TriStateCheckbox = ({
  checked,
  indeterminate,
  disabled,
  onChange,
  ariaLabel,
}: HierarchicalSelectionState & {
  disabled?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={onChange}
        className={cn(
          "peer size-4 appearance-none rounded-[3px] border border-border bg-background transition-colors",
          "checked:border-primary checked:bg-primary disabled:cursor-not-allowed disabled:opacity-45",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
        )}
      />
      {checked && <Check className="pointer-events-none absolute size-3 text-primary-foreground" strokeWidth={2.5} />}
      {indeterminate && !checked && <Minus className="pointer-events-none absolute size-3 text-primary" strokeWidth={2.5} />}
    </span>
  );
};

const buildChildrenByParent = (options: readonly HierarchicalSelectOption[]) => {
  const children = new Map<string | null, string[]>();
  options.forEach((option) => {
    const parentId = option.parentId ?? null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(option.id);
    children.set(parentId, siblings);
  });
  return children;
};

const buildDescendantsById = (options: readonly HierarchicalSelectOption[]) => {
  const children = buildChildrenByParent(options);
  const descendants = new Map<string, string[]>();
  const collect = (id: string, stack = new Set<string>()): string[] => {
    if (descendants.has(id)) return descendants.get(id)!;
    if (stack.has(id)) return [id];
    const nextStack = new Set(stack).add(id);
    const result = [id];
    (children.get(id) ?? []).forEach((childId) => {
      result.push(...collect(childId, nextStack));
    });
    const unique = [...new Set(result)];
    descendants.set(id, unique);
    return unique;
  };
  options.forEach((option) => collect(option.id));
  return descendants;
};

const getDepth = (
  option: HierarchicalSelectOption,
  optionById: ReadonlyMap<string, HierarchicalSelectOption>,
) => {
  let depth = 0;
  let parentId = option.parentId ?? null;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = optionById.get(parentId)?.parentId ?? null;
  }
  return depth;
};

export interface HierarchicalMultiSelectProps {
  options: readonly HierarchicalSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  multiple?: boolean;
  applyOnClose?: boolean;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  ariaLabel?: string;
  className?: string;
  contentClassName?: string;
  portalContainer?: HTMLElement | null;
  title?: string;
  defaultOpen?: boolean;
}

export function HierarchicalMultiSelect({
  options,
  value,
  onChange,
  multiple = true,
  applyOnClose = false,
  disabled = false,
  placeholder = "请选择",
  searchPlaceholder = "搜索关键字",
  emptyText = "没有可选择的内容",
  ariaLabel = "分级选择",
  className,
  contentClassName,
  portalContainer,
  title,
  defaultOpen = false,
}: HierarchicalMultiSelectProps) {
  const [open, setOpen] = useState(() => defaultOpen && !disabled);
  const [query, setQuery] = useState("");
  const [pendingValue, setPendingValue] = useState<string[]>(value);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const optionById = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);
  const childrenByParent = useMemo(() => buildChildrenByParent(options), [options]);
  const descendantsById = useMemo(() => buildDescendantsById(options), [options]);
  const selectableOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const selectableIds = useMemo(() => new Set(selectableOptions.map((option) => option.id)), [selectableOptions]);
  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = normalizedQuery
      ? options.filter((option) => [option.label, option.secondaryLabel, option.searchText].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedQuery))
      : options.filter((option) => {
          let parentId = option.parentId ?? null;
          while (parentId) {
            if (!expandedIds.has(parentId)) return false;
            parentId = optionById.get(parentId)?.parentId ?? null;
          }
          return true;
        });
    return matches;
  }, [expandedIds, optionById, options, query]);

  useEffect(() => {
    const validValue = value.filter((id) => selectableIds.has(id));
    setPendingValue((current) => (open ? current : validValue));
  }, [open, selectableIds, value]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const selectableValue = useMemo(() => value.filter((id) => optionById.has(id)), [optionById, value]);
  const pendingSet = useMemo(() => new Set(pendingValue), [pendingValue]);
  const allState = useMemo(() => {
    const selectedCount = selectableOptions.filter((option) => pendingSet.has(option.id)).length;
    return {
      checked: selectableOptions.length > 0 && selectedCount === selectableOptions.length,
      indeterminate: selectedCount > 0 && selectedCount < selectableOptions.length,
    };
  }, [pendingSet, selectableOptions]);
  const valuesChanged = pendingValue.length !== selectableValue.length
    || pendingValue.some((id, index) => id !== selectableValue[index]);
  const selectedLabels = selectableValue
    .map((id) => optionById.get(id))
    .filter((option): option is HierarchicalSelectOption => Boolean(option))
    .map((option) => [option.label, option.secondaryLabel].filter(Boolean).join(" · "));
  const triggerText = selectedLabels.length === 0
    ? placeholder
    : selectedLabels.length === 1
      ? selectedLabels[0]
      : `${selectedLabels[0]} +${selectedLabels.length - 1}`;
  const triggerTitle = title ?? (selectedLabels.length > 0 ? selectedLabels.join("\n") : placeholder);

  const openChange = (nextOpen: boolean) => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (nextOpen) {
      setPendingValue(value.filter((id) => selectableIds.has(id)));
      setQuery("");
      setExpandedIds(new Set());
    } else {
      setQuery("");
      if (applyOnClose) setPendingValue(value.filter((id) => selectableIds.has(id)));
    }
    setOpen(nextOpen);
  };

  const updateSelection = (nextValue: string[]) => {
    if (disabled) return;
    const normalized = options.map((option) => option.id).filter((id) => nextValue.includes(id));
    setPendingValue(normalized);
    if (!applyOnClose) onChange(normalized);
  };

  const toggleOption = (optionId: string) => {
    const option = optionById.get(optionId);
    if (!option || option.disabled) return;
    if (!multiple) {
      onChange([optionId]);
      setOpen(false);
      return;
    }
    const subtree = (descendantsById.get(optionId) ?? [optionId]).filter((id) => selectableIds.has(id));
    const subtreeSelected = subtree.every((id) => pendingSet.has(id));
    const next = new Set(pendingSet);
    subtree.forEach((id) => (subtreeSelected ? next.delete(id) : next.add(id)));
    updateSelection([...next]);
  };

  const toggleAll = () => {
    if (!multiple) return;
    const next = allState.checked ? [] : selectableOptions.map((option) => option.id);
    updateSelection(next);
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <DropdownMenu open={open} onOpenChange={openChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={triggerTitle}
          disabled={disabled}
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-1 rounded border border-transparent bg-transparent px-2 text-left text-xs text-foreground transition-colors",
            "hover:border-border/60 hover:bg-muted/20 focus-visible:border-primary/50 focus-visible:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/20",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{triggerText}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={portalContainer}
        align="start"
        className={cn("w-[380px] max-w-[calc(100vw-24px)] p-0", contentClassName)}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="border-b border-border p-2" onKeyDown={(event) => event.stopPropagation()}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={`${ariaLabel}搜索`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 pl-8 text-xs"
              placeholder={searchPlaceholder}
            />
          </div>
        </div>
        {multiple && (
          <div className="flex items-center justify-between border-b border-border px-2 py-1.5 text-xs">
            <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-accent">
              <TriStateCheckbox
                {...allState}
                ariaLabel="全选"
                onChange={toggleAll}
              />
              <span>全选</span>
            </label>
            <span className="text-muted-foreground">已选 {pendingValue.length} 项</span>
          </div>
        )}
        <div className="max-h-80 overflow-y-auto p-1">
          {visibleOptions.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">{emptyText}</p>
          ) : visibleOptions.map((option) => {
            const childIds = childrenByParent.get(option.id) ?? [];
            const state = multiple
              ? getHierarchicalSelectionState(option.id, descendantsById, pendingSet)
              : { checked: pendingSet.has(option.id), indeterminate: false };
            const depth = getDepth(option, optionById);
            const expanded = expandedIds.has(option.id);
            return (
              <div
                key={option.id}
                className="flex min-h-9 items-center gap-1 rounded px-1 pr-2 text-xs transition-colors hover:bg-accent"
                style={{ paddingLeft: `${6 + depth * 16}px` }}
              >
                {childIds.length > 0 ? (
                  <button
                    type="button"
                    aria-label={`${expanded ? "折叠" : "展开"} ${option.label}`}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => toggleExpanded(option.id)}
                  >
                    {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                ) : <span className="size-5 shrink-0" aria-hidden="true" />}
                <TriStateCheckbox
                  {...state}
                  disabled={option.disabled}
                  ariaLabel={`选择 ${option.label}`}
                  onChange={() => toggleOption(option.id)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate py-1 text-left text-foreground"
                  onClick={() => toggleOption(option.id)}
                  title={[option.label, option.secondaryLabel].filter(Boolean).join(" · ")}
                >
                  <span className="font-mono text-[11px]">{highlightText(option.label, query)}</span>
                  {option.secondaryLabel && <span className="ml-1 text-foreground"> {"· "}{highlightText(option.secondaryLabel, query)}</span>}
                </button>
              </div>
            );
          })}
        </div>
        {multiple && applyOnClose && (
          <div className="flex items-center justify-end gap-1.5 border-t border-border px-2 py-2">
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openChange(false)}>
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              aria-label={`应用${ariaLabel}`}
              disabled={!valuesChanged}
              onClick={() => {
                onChange(pendingValue);
                setOpen(false);
              }}
            >
              应用
            </Button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
