# Sidebar Information Architecture Design

**Goal:** Restructure the left navigation into clearer enterprise-style first-level groups, move 项目列表 under 项目经营驾驶舱, and make the sidebar visually lighter and more hierarchical without changing business routes or permission logic.

**Scope:** `src/components/app-shell.tsx` and any minimal adjacent style/test adjustments required to support the new sidebar hierarchy.

## Approved Information Architecture

The sidebar should present four first-level groups:

1. **项目经营驾驶舱**
   - 项目列表
   - 项目信息管理
2. **项目范围管理**
   - 技术协议管理
   - 选换件管理
   - 交付清单管理
3. **项目采购管理**
   - 必换件采购管理
   - 选换件采购管理
   - 结构件采购管理
4. **系统设置**
   - 项目角色与人员管理
   - 权限矩阵

待办中心继续保留为独立入口，不并入上述四组。

## Permission Behavior

- Do **not** introduce new business permission keys for the first-level groups.
- A first-level group is visible when at least one of its child items is visible.
- Existing child permission keys remain the source of truth.
- Existing routes, todo jumps, and procurement/business logic remain unchanged.

## Visual Direction

Use an enterprise back-office style instead of the current heavy card stack:

- First-level group headers become real visual anchors with stronger typography and clearer spacing.
- Second-level items become lighter, denser navigation rows rather than oversized block buttons.
- Active states should be more explicit and cleaner.
- Groups should feel separated by rhythm and hierarchy instead of repeated large dark cards.
- Overall result should feel more mature, lighter, and easier to scan.

## Implementation Boundaries

Primary file:

- `src/components/app-shell.tsx`

Possible supporting work if required:

- Extract or adjust local class structure in the same component
- Add or update sidebar-focused tests

Out of scope:

- Route changes
- Permission tree model changes
- Todo routing changes
- Service/context/domain changes
- Procurement page behavior changes

## Acceptance Criteria

1. 项目列表 no longer appears as a standalone top-level link.
2. 项目列表 appears under 项目经营驾驶舱.
3. 项目经营驾驶舱 / 项目范围管理 / 项目采购管理 / 系统设置 all render as true first-level menus.
4. 项目采购管理 contains the three procurement pages as second-level items.
5. Visibility still follows existing child permission rules.
6. Sidebar styling is visually lighter and more structured than the current version.
7. No regressions in existing routes or permission-gated access.
