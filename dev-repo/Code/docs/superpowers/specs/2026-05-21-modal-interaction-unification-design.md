# Modal Interaction Unification Design

**Goal:** Unify the project so edit/modify interactions and operational actions use modal dialogs instead of inline edit blocks or direct in-table editing, following the existing dark popup interaction style already present in the app.

**Scope:** Shared dialog infrastructure plus the first wave of migrations across account management, project detail management, procurement execution pages, and destructive/operational confirmations directly involved in those flows.

## Approved Direction

Adopt **Scheme A**:

1. Extract one reusable modal shell from the existing dark popup pattern already used in `src/app/role-config/page.tsx`.
2. Standardize **form-based edits** into modal dialogs.
3. Standardize **dangerous or state-changing actions** into confirmation dialogs.
4. Standardize **batch operations** into dedicated batch-action dialogs.
5. Remove long-lived inline edit regions and row-level direct editing where the user is expected to modify business data inside the table.

The user explicitly confirmed two scope rules:

- This is a **project-wide** interaction standard, not a single-page exception.
- The rule applies not only to “编辑/修改” but also to operations such as **停用 / 删除 / 重置密码 / 批量调整** wherever practical.

## Existing Patterns and Chosen Standard

### Existing reusable dialog-related pieces

- `src/components/confirm-dialog.tsx`
- `src/components/confirm-provider.tsx`
- `src/components/create-project-dialog.tsx`

### Existing visual reference to standardize on

- `src/app/role-config/page.tsx`

This page already contains the strongest match to the desired interaction model:

- dark backdrop
- centered floating layer
- larger rounded panel
- stronger focus separation from the page behind it

This visual pattern becomes the canonical modal style for the migration.

### Interaction patterns being replaced

- Inline edit block under the table in `src/app/admin/accounts/page.tsx`
- Full inline project info editing panel in `src/app/projects/[projectId]/page.tsx`
- Direct cell editing in procurement execution tables:
  - `src/app/procurement/required-parts/page.tsx`
  - `src/app/procurement/optional-parts/page.tsx`
  - `src/app/procurement/structural-parts/page.tsx`
- Direct destructive actions without consistent confirmation in project detail subareas

## Target Interaction Rules

### 1. Form edits → form modal

Any interaction where the user edits structured data should open a modal containing the full form. This includes:

- account editing
- project information editing
- procurement execution row editing
- future role/config edit flows that expose editable business fields

Expected behavior:

- user clicks an action button such as `编辑` or `修改`
- modal opens with current row/entity data prefilled
- user confirms or cancels explicitly
- no business data is committed implicitly through field blur alone

### 2. Dangerous/state-changing actions → confirmation modal

Operations that mutate status or can create user anxiety should require explicit confirmation, including:

- 删除
- 停用 / 启用
- 重置密码
- 项目状态切换（启动 / 完成 / 作废 / 恢复）
- 推送类确认

Expected behavior:

- action button opens a confirmation dialog
- dialog states the target object and effect clearly
- confirmation and cancel are explicit

### 3. Batch operations → dedicated batch modal

Batch role adjustment and similar future batch mutations should open a specialized modal rather than living as a persistent page block.

Expected behavior:

- user selects rows first
- user clicks a batch action trigger
- dedicated modal opens and shows affected count
- batch changes are confirmed once, then applied together

### 4. Tables stop being editing canvases

Data tables remain scanning/browsing surfaces. They may host action buttons, but they should no longer be the primary place where users directly type into execution fields and cause save-on-blur updates.

This rule is especially important for the three procurement execution pages.

## Shared Component Design

Create one shared modal shell component, tentatively under:

- `src/components/modal-dialog.tsx`

Responsibilities:

- backdrop
- centering
- panel chrome
- title area
- close affordance
- body slot
- footer slot
- accessibility attributes (`role="dialog"`, `aria-modal`, title association if needed)
- optional size variants for standard form modal vs larger content modal

This component should become the base for:

- new edit forms
- batch operation dialogs
- eventual visual convergence of existing create/confirm dialogs where practical

## Migration Plan by Surface

### A. Account management page

File:

- `src/app/admin/accounts/page.tsx`

Changes:

- Replace inline edit block with edit modal
- Replace direct enable/disable action with confirmation dialog
- Replace reset password action with confirmation dialog
- Replace persistent batch role adjustment block with batch adjustment modal

Notes:

- account creation may remain as page form for now unless implementation naturally benefits from modalization during the same refactor
- current lifecycle behavior added in the previous milestone must remain unchanged

### B. Project detail page

File:

- `src/app/projects/[projectId]/page.tsx`

Changes:

- Move project information editing into modal
- Add consistent confirmation dialogs for member/device/part deletion where missing
- Preserve existing project status confirmation semantics, but align visuals to the unified modal style if touched

### C. Procurement execution pages

Files:

- `src/app/procurement/required-parts/page.tsx`
- `src/app/procurement/optional-parts/page.tsx`
- `src/app/procurement/structural-parts/page.tsx`

Changes:

- Remove direct cell editing for execution fields
- Add row-level `编辑` entry point
- Open row edit modal with execution fields:
  - unit price
  - cycle days
  - vendor
  - purchase date
  - progress status
  - payment status
- Save only through explicit modal confirmation

### D. Role config page

File:

- `src/app/role-config/page.tsx`

Changes:

- Keep existing permission dialogs as-is conceptually
- Use it as the visual reference for the shared modal shell
- Investigate the existing dead `编辑` button and either wire it into the new standard or formally leave it out of this implementation if no editable role payload is defined yet

## Reuse Strategy for Existing Confirm Flow

`src/components/confirm-provider.tsx` and `src/components/confirm-dialog.tsx` already provide a reusable confirmation mechanism.

Recommended direction:

- keep the `useConfirm()` interaction contract if it reduces migration cost
- update its visual shell to match the unified dark modal standard, or wrap it around the new shared modal shell

This avoids reworking every caller’s confirmation logic while still achieving visual consistency.

## Data and Logic Boundaries

This design changes **interaction delivery**, not business rules.

Do not change:

- permission model semantics
- domain model semantics unrelated to dialog state
- service-layer business rules already validated in the previous account lifecycle milestone
- route structure
- persistence model

Allowed supporting work:

- local UI state reshaping
- extracted reusable modal components
- refactoring event handlers from inline-save to explicit submit flows
- targeted test rewrites

## Accessibility and UX Requirements

All new modals should:

- support keyboard focus entering the dialog predictably
- provide explicit close/cancel actions
- not leave the page in a half-edited implicit-save state
- clearly label the object being edited or acted upon
- preserve readability in the current dark-layout environment

For destructive confirmations, the primary question and consequence should be explicit, not generic.

## Testing Impact

Expected test updates:

- page tests currently asserting inline forms or direct table editing will need to assert dialog opening, field prefilling, cancel/confirm behavior, and final table refresh
- account management tests need to shift from inline edit form queries to modal queries
- procurement page tests should validate that data is not mutated until explicit confirm
- existing confirmation-driven tests may need updates if the shared dialog markup changes

Verification target remains:

- `npm run typecheck`
- `npm run lint`
- targeted page tests
- full `npm test`

## Acceptance Criteria

1. A reusable shared modal shell exists and matches the dark popup style used as the approved reference.
2. Account editing no longer happens in an inline block; it opens in a modal dialog.
3. Account enable/disable and password reset use explicit confirmation dialogs.
4. Batch role adjustment is triggered and completed through a dedicated modal dialog.
5. Project information editing opens in a modal dialog instead of an always-visible inline form.
6. Project member/device/part destructive actions use consistent confirmation dialogs.
7. The three procurement execution pages no longer save via direct cell editing; each row is edited through a modal dialog.
8. Existing business logic outcomes remain unchanged after the interaction refactor.
9. Tests and project verification pass after migration.

## Out of Scope for This Spec

- redesigning unrelated page layout or navigation
- changing backend/storage architecture
- inventing new business workflows beyond the existing actions
- broad visual redesign beyond dialog standardization

## Implementation Risk Notes

- The procurement pages carry the highest behavior-change risk because they move from immediate inline persistence to explicit dialog submit.
- Confirmation dialog visual unification may affect many existing tests if done in one sweep.
- The dead edit affordance in role-config should be clarified during implementation rather than silently preserved if it confuses the standardized interaction model.
