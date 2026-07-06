# Design

## Source of truth
- Status: Draft
- Last refreshed: 2026-07-06
- Primary product surfaces: project list, project detail, gantt schedule, weekly items, risk register, budget management, role/account management, future intake/docs/modules.
- Evidence reviewed: `src/app/globals.css`, `src/components/app-shell.tsx`, `src/components/item-panel.tsx`, `src/components/ui/*`, `.omx/plans/remove-monthly-and-plane-inspired-roadmap.md`.

## Brand
- Personality: compact, professional, operational, project-manager focused.
- Trust signals: clear hierarchy, predictable controls, auditability, dense but readable tables, restrained color.
- Avoid: marketing-style hero pages, decorative cards, oversized text, single-purpose visual effects, broad gradients, visual noise.

## Product goals
- Goals: help project managers track progress, weekly execution, cost, risk, and ownership with low friction.
- Non-goals: becoming a generic issue tracker or copying Plane's full workspace/issue hierarchy.
- Success signals: fewer horizontal table conflicts, faster filtering, fewer orphaned items, clearer ownership and status.

## Personas and jobs
- Primary personas: project manager, delivery lead, department manager, project member, administrator.
- User jobs: maintain current project state, spot overdue/high-risk work, update weekly execution, review cost/risk status, keep decisions traceable.
- Key contexts of use: repeated daily/weekly updates, meeting follow-ups, project review meetings, risk/cost checks.

## Information architecture
- Primary navigation: project operations cockpit, project progress management, project cost management, project risk management, system settings.
- Core routes/screens: projects, project detail, gantt, weekly items, budget, risk register, roles/accounts.
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
- New/changed components: saved-view bar, detail drawer, intake conversion panel, document action extraction, module summary table.
- Variants and states: active/saved/default view, selected row, batch selection, inline edit hover, empty/error/loading.
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

## Content voice
- Tone: direct, operational, concise Chinese labels.
- Terminology: use 项目进度管理、本周事项、风险登记册、事项收集池、项目文档、项目阶段/模块.
- Microcopy rules: avoid explaining UI mechanics in visible product copy unless needed for error/empty states.

## Implementation constraints
- Framework/styling system: Next.js, React, Tailwind/CSS variables, Prisma/PostgreSQL.
- Design-token constraints: align to existing dark theme variables.
- Performance constraints: avoid heavy table re-rendering and unnecessary client-side broad state.
- Compatibility constraints: standalone prototypes can be static HTML; production should reuse repo components.
- Test/screenshot expectations: verify key screens at desktop and mobile widths before final delivery.

## Open questions
- [ ] Whether historical monthly item data should be exported, migrated, or deleted before model removal.
- [ ] Whether saved views are user-level, role-level, or project-level.
- [ ] Whether project documents need rich text in phase one or structured markdown/plain text is enough.
