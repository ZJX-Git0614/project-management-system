# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-06
- Primary product surfaces: project list, project detail, gantt schedule, weekly items, risk register, budget management, delivery management, procurement management, role/account management, future intake/docs/modules.
- Evidence reviewed: `src/app/globals.css`, `src/components/app-shell.tsx`, `src/components/gantt-timeline.tsx`, `src/components/project-gantt-panel.tsx`, `src/components/item-panel.tsx`, `src/components/project-budget-panel.tsx`, `src/components/system-backup-panel.tsx`, `src/components/system-log-panel.tsx`, `src/components/project-restore-panel.tsx`, `src/components/ui/*`, `.omx/plans/remove-monthly-and-plane-inspired-roadmap.md`.

## Brand
- Personality: compact, professional, operational, project-manager focused.
- Trust signals: clear hierarchy, predictable controls, auditability, dense but readable tables, restrained color.
- Avoid: marketing-style hero pages, decorative cards, oversized text, single-purpose visual effects, broad gradients, visual noise.

## Product goals
- Goals: help project managers track progress, weekly execution, cost, risk, delivery, procurement, and ownership with low friction.
- Non-goals: becoming a generic issue tracker or copying Plane's full workspace/issue hierarchy.
- Success signals: fewer horizontal table conflicts, faster filtering, fewer orphaned items, clearer ownership and status, and no manual re-entry from released BOM data into procurement tracking.

## Personas and jobs
- Primary personas: project manager, delivery lead, procurement coordinator, department manager, project member, administrator.
- User jobs: maintain current project state, spot overdue/high-risk work, update weekly execution, review cost/risk/delivery/procurement status, and keep decisions traceable.
- Key contexts of use: repeated daily/weekly updates, meeting follow-ups, project review meetings, risk/cost checks.

## Information architecture
- Primary navigation: project operations cockpit, project WBS management, project delivery management, project procurement management, project cost management, project risk management, system settings.
- Core routes/screens: projects, project detail, gantt, delivery list, delivery status, procurement, weekly items, budget, risk register, roles/accounts.
- Content hierarchy: selected project first, then module-specific work surfaces.

## Design principles
- Principle 1: Keep operational screens compact and scannable.
- Principle 2: Use tables for comparison, drawers for deep editing, saved views for repeated work.
- Principle 3: Preserve the existing project-management business model over generic issue-tracking vocabulary.
- Tradeoffs: density should not cause cramped controls; complex fields move to detail panels.

## Visual language
- Color: dark neutral operational UI with restrained blue accents, status colors for success/warning/danger.
- Typography: small, stable, no viewport-scaled type, no negative letter spacing.
- Spacing/layout rhythm: 8-12px grid, compact toolbars, fixed-height rows where practical.
- Shape/radius/elevation: 6-8px radius, low elevation, no nested decorative cards.
- Motion: short functional transitions only.
- Imagery/iconography: icons only for recognizable commands; no decorative imagery in app surfaces.

## Components
- Existing components to reuse: Button, Input, Select, Table, Card, Badge, Dialog, Tooltip.
- New/changed components: saved-view bar, detail drawer, intake conversion panel, document action extraction, module summary table, unified table context menu, module-scoped undo/redo controls, transparent data-table surface, borderless table action buttons, borderless table icon buttons, service-status rows, deliverable list, deliverable status editor, BOM revision/import dialog, procurement synchronization preview, procurement status timeline.
- Variants and states: active/saved/default view, sequence-column row selection, contiguous/additive batch selection, inline edit hover, empty/error/loading.
- Token/component ownership: follow `src/app/globals.css` variables and existing UI component sizing.

## Accessibility
- Target standard: keyboard-accessible core workflows and readable contrast.
- Keyboard/focus behavior: clear focus state on toolbar actions, table cells, drawer fields.
- Contrast/readability: status badges must remain legible on dark backgrounds.
- Screen-reader semantics: tables and forms should keep native labels/headers.
- Reduced motion and sensory considerations: no essential information conveyed by animation only.

## Responsive behavior
- Supported breakpoints/devices: desktop first, usable tablet/mobile fallbacks.
- Layout adaptations: side drawers stack below tables on narrow screens; toolbar wraps cleanly.
- Touch/hover differences: hover-only affordances need visible focus/tap equivalents.

## Interaction states
- Loading: compact skeleton/table placeholder.
- Empty: explain what can be created next.
- Error: show actionable retry/correction.
- Success: subtle toast or saved state.
- Disabled: keep reason discoverable when possible.
- Offline/slow network: retain drafts for table edits where feasible.
- Destructive confirmation: name the target and list affected linked records before deletion; explain that those records will become unlinked and that undo restores the recorded links.

## Content voice
- Tone: direct, operational, concise Chinese labels.
- Terminology: use 项目WBS管理、项目事项管理、风险登记册、事项收集池、项目文档、项目阶段/模块、交付物清单、交付物状态管理、BOM版本、线缆清单、项目采购管理；已撤销操作的恢复统一称为“重做”。
- Microcopy rules: avoid explaining UI mechanics in visible product copy unless needed for error/empty states.

## Table interaction conventions
- Project WBS, project items, risk register, and project budget use the same right-click menu visual language and action ordering.
- Project items and risks select rows from the sequence column; do not expose selection as a context-menu command or temporary checkbox mode.
- Right-clicking an unselected item or risk row makes that row the sole action target; right-clicking an already selected row preserves the current batch target.
- Budget tables do not support cross-category batch selection.
- Budget category create/edit/delete buttons remain visible; the context-menu-only rule applies to budget rows, not category management controls.
- Table edits and new rows save on `Enter` or when focus leaves the active editing area; `Escape` cancels without saving.
- Save-on-blur and save-on-Enter must share an idempotent submission guard so one user action cannot create duplicate requests.
- Project budget and project item tables do not reserve a permanent operation column; row commands live in the context menu.
- Auto-save tables do not add floating save/cancel controls; cancellation is provided by `Escape` while the edit remains active.
- An incomplete new row must remain in edit mode instead of creating partial data; mark missing required fields inline and allow `Escape` to discard the draft.
- In multiline table editors, `Enter` saves, `Shift+Enter` inserts a line break, clicking outside saves, and `Escape` cancels.
- Project WBS, budget, item, and risk module headers expose separate equal-sized undo and redo icon buttons with disabled states and action-specific tooltips.
- Outside active editors, `Ctrl/Cmd+Z` undoes and `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` redoes; native input undo remains local to the editor.
- All operational tables reuse the shared table primitives from `src/components/ui/table.tsx`; local raw table markup is reserved for document rendering, not application data lists.
- Table body controls visually merge into the row: transparent background and border by default, with state shown only on hover, focus, validation, selection, or destructive emphasis.
- Row actions use shared borderless table action components. Icon-only actions use familiar Lucide symbols, stable hit areas, tooltips or accessible labels, and no visible square container.
- WBS warning and column-filter icons render as standalone symbols without a square border or filled hover tile. Keyboard focus is indicated by color and underline/outline-free icon emphasis.
- Resource optimization always presents candidate strategy, affected task count, completion date, remaining conflicts, and expected delay before application. Applying a candidate is an explicit, undoable action.
- The assistant may analyze WBS optimization opportunities from authorized schedule data. It may mutate WBS only through a versioned, permission-checked tool proposal that names the selected candidate and waits for the configured confirmation boundary.
- Windows host service controls for Ollama and RAGLite are administrator-only. Browser requests go through the application server to a token-authenticated host bridge; host tokens are never exposed to the browser.

## Implementation constraints
- Framework/styling system: Next.js, React, Tailwind/CSS variables, Prisma/PostgreSQL.
- Design-token constraints: align to existing dark theme variables.
- Performance constraints: avoid heavy table re-rendering and unnecessary client-side broad state.
- Compatibility constraints: standalone prototypes can be static HTML; production should reuse repo components.
- Test/screenshot expectations: verify key screens at desktop and mobile widths before final delivery.
- Undo/redo concurrency: this release assumes one active editor per project module and does not add cross-user or cross-tab conflict detection.

## Open questions
- [ ] Whether historical monthly item data should be exported, migrated, or deleted before model removal.
- [ ] Whether saved views are user-level, role-level, or project-level.
- [ ] Whether project documents need rich text in phase one or structured markdown/plain text is enough.
- [ ] Whether module undo/redo should later reject stale history when another user, assistant action, or browser tab has changed the same module.
- [ ] Whether delivery acceptance and procurement ordering should be enforced by a mandatory workflow or remain configurable by project type and amount threshold.
- [ ] Whether the BOM import template needs supplier part number, tax, currency, and manufacturer fields in the first release.
- [ ] Whether cable-list lines should always synchronize to procurement, or be selected as an optional source at each BOM synchronization.
