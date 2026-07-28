# MPP兼容与挣值分析实施记录

## 实施顺序

1. 扩展甘特任务数据模型，保留 Microsoft Project 的持续时间、完成时间、任务模式、里程碑、WBS、日历、约束和基线字段。
2. 将紧前任务关系改为数据库任务主键关联，任务改名不再破坏依赖关系。
3. 重构 MPP/XML/Excel 导入导出，保留依赖类型与延迟，并保存日历、资源和分配等项目级元数据。
4. 新增一级菜单“项目绩效管理”和二级菜单“挣值分析”，实现附件规定的 PV 至 TCPI 指标。
5. 执行数据库增量迁移、样本 MPP 解析、单元测试、类型检查、代码检查、生产构建和浏览器验证。

## MPP字段处理

| Project 数据 | PMS 保存位置 | 处理方式 |
| --- | --- | --- |
| UID、ID、名称、层级 | 甘特任务 | 导入并按当前任务顺序重新生成展示 ID，外部 UID 单独保留 |
| Start、Finish、Duration | 甘特任务 | Finish 独立保存；Duration 按 Project 分钟制解析，不再用自然日差推算 |
| Manual、Milestone、WBS、OutlineNumber | 甘特任务 | 原值保留并可回写 XML |
| ConstraintType、ConstraintDate | 甘特任务 | 原值保留并可回写 XML |
| Baseline、BaselineCost、Cost | 甘特任务 | 用于挣值分析和 Project 数据回写 |
| PredecessorLink | 任务依赖表 | 使用任务数据库主键保存，并保留 Type、LinkLag、LagFormat |
| Calendars、Resources、Assignments | 项目导入元数据 | 结构化保存，导出时重新映射任务 UID |

二进制 `.mpp` 导入由 MPXJ 解析。直接导出二进制 `.mpp` 仍依赖已配置的转换服务；未配置时可导出 Microsoft Project XML，由 Project 直接打开并另存为 `.mpp`。

## 挣值分析边界

挣值分析仅实现附件《计算公式汇总郑房新V1.1》中 PV 至 TCPI 的指标，不包含 EMV、三点估算和关键路径公式。

- `PV = 计划工作量 x 计划单价`
- `EV = 实际工作量 x 计划单价`
- `AC = 实际工作量 x 实际单价`
- `SV = EV - PV`
- `CV = EV - AC`
- `SPI = EV / PV`
- `CPI = EV / AC`
- `ETC(非典型) = BAC - EV`
- `ETC(典型) = (BAC - EV) / CPI`
- `EAC(非典型) = AC + BAC - EV`
- `EAC(典型) = BAC / CPI`
- `VAC = BAC - EAC`
- `TCPI(BAC) = (BAC - EV) / (BAC - AC)`
- `TCPI(EAC) = (BAC - EV) / (EAC - AC)`

系统按状态日期和任务计划区间计算计划进度，再根据任务 BAC 得到 PV；EV 使用当前进度计算，AC 由用户录入。分母为零时显示 `--`，不输出无穷值。

## 数据安全

迁移脚本只新增字段、表、索引和外键，并对唯一匹配的旧紧前任务名称进行主键关系回填，不删除项目业务数据。验证样本只执行内存解析，没有导入数据库，也没有新增示例任务或绩效数据。
