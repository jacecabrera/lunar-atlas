# 第03步：数据契约、单位、状态含义与模块接口

记录日期：2026-11-14
起点：分支 `Frank`，HEAD `6b9b80f`（第02步提交）。本步的改动尚未提交。`docs/reference/Lunar_Navigator_Step_by_Step_Plan_v1.0.md` 中有用户未提交的修改（加入了作者 API 说明的采纳记录），已原样保留。

依据：v0.7 需求、设备与候选参考 v0.1、25步计划（含第9节 API-01～API-15）、`docs/step-02-requirements-map.md`、`docs/SIM_API.md` 及全部源码和测试。作者提供的 `Pasted markdown.md` 在本机找不到（已在项目、上级目录、`~/Downloads` 中查找，并用 Spotlight 搜索）。它的内容以计划第9节的逐条摘录和仓库中的 `docs/SIM_API.md` 为准，本步没有据此新增任何需求。

## 1. 本步范围

已做：

- 核心类型：任务输入（草稿 / 校验后输入）、高级设置与设备配置、候选登记、条件评估与汇总、指标契约、可序列化地平线、任务生命周期与结果身份、详情快照、来源元数据。
- 统一单位和时间基准，旧功率模型改为 W/Wh，并提供显式的 kW 适配函数。
- 拆除 `power.ts` 与 `sim/index.ts` 的循环导入；场景组件改为只通过 `src/sim` 取数据。
- 扩展 `useMission`，不再另建任务 store。
- 共用的 UTC 日历工具。

不在本步范围（按25步计划推进）：新的科学模型（可见性、发电、储能、地形足迹）、推荐算法、候选数据与 ILN 预设（第05步）、Worker 和调度（第15步）、快照存储与新标签页（第21步）、任何业务页面。

## 2. 模块与依赖方向

```
src/ui, src/scene, src/state  ──►  src/sim/index.ts（只做重新导出）
                                         │
              ┌──────────────────────────┴───────────────────────────┐
  契约（无运行时依赖，或只依赖 units）          计算
  units  provenance  mission  assessment       site ─► terrain ─► physics/dem, horizon
  horizonData  task  snapshot                  power ─► site, mission, units
                                               scene ─► physics/ephemeris, moonFrame, earthFrame
src/time/utcCalendar.ts（独立，第16、23步共用）
```

规则：

- 领域模块之间直接导入，**不通过** `sim/index.ts`。运行时的 sim 内部导入只有 power→mission/site/units、site→terrain、mission→units，没有环。其余跨模块引用都是 `import type`。
- 计算函数只接收普通参数，不读取 Zustand store。store 只把校验后的值传给计算层。
- `src/scene`、`src/ui`、`src/state` 不直接导入 `src/physics`（已用 grep 确认）。

| 文件 | 职责 |
|---|---|
| `src/sim/units.ts` | 单位常量与换算（W↔kW、Wh↔kWh、天/小时↔ms）、日期范围上限 |
| `src/sim/provenance.ts` | `SourceRef`、`ParameterProvenance`（来源值 / 计算值 / 项目假设 / 数据集 / 模型） |
| `src/sim/mission.ts` | `MissionDraft`、`MissionInput`、`MissionWindow`、`validateMissionDraft`、`missionInputStatus`、`validateMissionWindow`；`DeviceConfig`、`PanelSpec`、`ScoringWeights`、`AdvancedSettings`（只有类型） |
| `src/sim/assessment.ts` | `CandidateRecord`；`ConditionStatus/Result`、`summarizeConditions`、`assessSite`、`notEvaluated`；可见性策略、`SolarSample`、`NextSetResult`、`MissionMetrics`、`Recommendation`（契约） |
| `src/sim/horizonData.ts` | `HorizonData`、`HorizonSamples`、`validateHorizonSamples`、`runtimeHorizon`、`requireHorizon`、`SerializableSite`、`toRuntimeSite` |
| `src/sim/task.ts` | `ModelVersions`、`CURRENT_MODEL_VERSIONS`、`createRequestId`、`taskFingerprint`、`TaskState` 及纯状态转换函数 |
| `src/sim/snapshot.ts` | `DetailSnapshot`、`serializeSnapshot`、`parseSnapshot` |
| `src/sim/site.ts` | `Site`、`siteAt`、`skyAt`、`windows`、`nextEvent`、`compareSites`、`panelFactor`（从 index.ts 迁来，行为不变） |
| `src/sim/scene.ts` | `sceneState`，以及转出的 `moonPosition`、`sunDirection` |
| `src/sim/terrain.ts` | 新增 `horizonDataAt`；`azimuthStepDeg` 必须整除 360 |
| `src/sim/power.ts` | 旧二元模型，接口迁移到 W/Wh 和 `MissionWindow` |
| `src/time/utcCalendar.ts` | `addUtcMonths`、`addUtcYears` |

## 3. 单位与时间基准

| 量 | 约定 | 命名 |
|---|---|---|
| 绝对时间 | UTC 毫秒（Unix 纪元起） | 后缀 `Ms`：`landingTimeMs`、`tMs`、`startMs` |
| 任务内相对时间 | 自着陆时刻起的毫秒数 | 后缀 `OffsetMs`：`PowerSegment.startOffsetMs` |
| 时长 | 毫秒；界面以 Earth day（24 h）输入，在 `validateMissionDraft` 边界换算 | `durationDays`（草稿）→ `durationMs`（输入） |
| 角度 | 度；纬度北为正，经度东为正（输入范围 −180～180）；方位角从北顺时针 | `lat`、`lon`、`...Deg` |
| 距离 | km | `...Km` |
| 功率 | W | `...W` |
| 能量 | Wh，定义在电池内部储能端 | `...Wh` |
| 积分时间 | 小时（Wh = W × h） | `msToHours` |
| 效率 | 0–1 的小数（界面可以显示为 %） | `...Efficiency` |

旧的 kW/kWh 数值只能通过 `legacyPowerConfigFromKw` 进入计算。该函数换算数值（×1000），不是只改字段名。

## 4. 任务输入

- `MissionDraft`：四个字段 `landingTimeMs`、`durationDays`、`launchLat`、`launchLon`，类型都是 `number | null`，初始值 `EMPTY_MISSION_DRAFT` 全部为 `null`。不自动填入当前时间、14 天或 0/0。第18步负责把文本框内容解析成这些数值；解析得到的 NaN 会被校验拒绝。
- `validateMissionDraft(draft)` 是产生 `MissionInput` 的唯一途径，检查以下各项：
  - 必填（`required`）。
  - 有限值（`not-finite`）。
  - 时长大于 0（`not-positive`）。
  - 纬度在 [−90, 90]、经度在 [−180, 180]，都含端点（`out-of-range`）。
  - 着陆时刻和任务结束时刻都在 JavaScript Date 的表示范围内。

  错误信息为英文界面文案。一个字段出错时只报这一条，不连带报其他字段。
- `missionInputStatus(draft)` 返回：`empty`（完全未填）、`invalid`（部分填写或有非法值）、`valid`。
- `MissionWindow = { startMs, endMs }` 由 `missionWindow(input)` 给出，即 [着陆, 着陆 + 时长]，不额外等待日出或部署。
- 任务时长不进入任何设备配置。第14步估算飞行时间时，不能读取它。

## 5. 设备配置与旧占位配置的隔离

- `DeviceConfig` 和 `AdvancedSettings` 按 v0.7 和补充文件定义字段：
  - PV 效率只有一个；母线效率、充电效率、放电效率分别命名。
  - 功率限值、保留线、面板几何、有效速度、地球最低仰角、足迹和阈值、评分权重各有字段。
  - `provenance` 记录每个参数的来源类型。

  **目前没有任何实例**。ILN-inspired 预设在第05步建立，同时加上高级设置的校验。
- 旧模型使用独立的 `LegacyPowerConfig`（W/Wh），占位值为 `LEGACY_PLACEHOLDER_POWER_CONFIG`。数值与原 `DEFAULT_POWER_CONFIG` 相同，已经冻结，注释写明是任意值、不是新预设。`useMission` 中对应字段名为 `legacyPower`，避免与将来的设备预设混淆。

## 6. 评估状态与汇总规则

候选登记 `CandidateRecord`（坐标、框架、来源、硬件提示）只描述点位，不含任何合格性信息。每次任务的评估结果放在 `SiteAssessment` 中。

四项条件为 `terrain`、`power`、`communication`、`dataCompleteness`，每项一个 `ConditionResult`：

- `status`：`pass | fail | unknown | error`。
- `reasons`：`{code, message}[]`，非 pass 时必须填写。
- `values`：`Quantity`，可以是“数值 + 单位”，或 `null` + 原因。合法的 0 保持为 0。
- `sources`、`limitations`。

`summarizeConditions` 的规则（见 `assessment.test.ts`）：

| 情况 | `landingAllowed` | `eligibleForRecommendation` |
|---|---|---|
| 任一物理条件（terrain / power / communication）为 `fail` | `false`，即使其他条件为 unknown 或 error | `false` |
| 四项都为 `pass` | `true` | `true` |
| 其余情况（有 unknown、error，或 dataCompleteness 为 fail） | `null` | `false` |

- `dataCompleteness: fail` 表示“已知数据不足”，归入 `undetermined`，**不是**物理危险。
- `error` 归入 `errored`，**不是**物理不满足。
- `reasons` 按条件顺序保留**全部**非 pass 原因。已知的失败不会被其他 unknown 覆盖或丢弃。
- `notEvaluated()` 是尚未计算时的默认值，状态为 `unknown`。
- 旧模型的 `LegacyPowerResult.viable` 和 `compareSites().sunAndEarthVisible`（原名 `operational`）都**不能**映射成 `pass` 或推荐资格。源码注释和 SIM_API 中都已写明。

## 7. 可序列化地平线与快照（序列化边界）

- `HorizonData` 有两种状态：
  - `available`：
    - `samples`：`elevationsDeg[]`、`startAzimuthDeg`、`stepDeg`、`angleUnit`，要求样本数 × 步长 = 360°。不假定 360 个样本，也支持非零的起始方位。
    - `source`：产品名、栅格间距、垂直精度（未知时为 `null`）、参考半径、坐标框架。
    - `model`：射线范围、观测桅杆高度、射线步长、观测点高程。
  - `unavailable`：带 `code`（`not-loaded | no-coverage | insufficient-resolution | service-error`）和 `message`。
- `runtimeHorizon(data)` 用 `horizonFromSamples` 重建运行时的 `Horizon` 函数；数据不可用时返回 `null`。保留原有的 `horizonFromProfile`，它现在调用 `horizonFromSamples`。
- `requireHorizon(data)` 是新评估流程的入口：缺数据或分辨率不足返回 `unknown`，服务失败返回 `error`，**不会**退回到平滑球面。
- `terrain.horizonDataAt(lat, lon, opts)` 在没有加载地形时返回 `unavailable / not-loaded`，坐标非法时仍然抛出异常。
- `SerializableSite` 带 `horizon: HorizonData | null`。`toRuntimeSite` 在没有可用地平线时生成平滑球面的 `Site`，只能用于标注过的预览和低层测试，不能作为合格依据。
- `DetailSnapshot` 只含纯数据，包括：
  - schema 名和版本、`snapshotId`、创建时刻
  - `requestId`、`fingerprint`、`versions`
  - `MissionInput`、设置（第05步前为 `{ legacyPower }`）
  - 各点的 `CandidateRecord` + `SiteAssessment` + `HorizonData`
  - 推荐和来源

  `serializeSnapshot` / `parseSnapshot` 负责 JSON 转换，并检查信封字段（schema、版本、必需的顶层字段）。存储、跨标签读取和页面都在第21步。
- 不能进入 Worker 消息或快照的内容：`Horizon` 函数、React 对象、Worker 句柄。`taskFingerprint` 遇到函数或非有限数值时会抛出异常；对象中值为 `undefined` 的键会被忽略。

## 8. 任务生命周期、结果身份与版本

- 输入状态由 `missionInputStatus` 给出（empty / invalid / valid）。任务状态 `TaskState` 有：
  - `idle`
  - `running {request}`
  - `done {request, result}`
  - `stale {request, result}`（保留旧结果，但标为已失效）
  - `error {request, error}`
- 零推荐是 `done`，此时 `outcome: 'no-eligible-sites'`，**不是** error。`TaskError.kind` 只有 `service` 和 `internal` 两种。单个点的数据缺失记在条件里，不算任务错误。
- **requestId 与 fingerprint 是两种不同的身份**：
  - `createRequestId()` 每次计算生成一个新 ID。即使输入完全相同，ID 也不同。没有用 `crypto.randomUUID`，因为普通 http 来源下不可用。
  - `taskFingerprint({input, settings, siteIds, versions})` 是规范化后的 JSON：对象键排序，数组保持顺序。它是精确字符串而不是哈希，所以不会碰撞。相同的指纹表示相同的输入。
  - `completeTask` 和 `failTask` 只接受正在运行的那个 requestId 的结果，迟到或不匹配的结果会被丢弃（即使指纹相同）。
  - `markStaleIfChanged(state, currentFingerprint)`：输入变化或变为无效（传入 `null`）时，`done` 转为 `stale`。
- `ModelVersions`：`contract`（当前为 1），`models` 分 visibility、power、terrain、scoring、transit，`data` 分 terrain、candidates。`CURRENT_MODEL_VERSIONS` 如实标注现状：可见性和能源仍是旧模型，scoring 和 transit 尚未实现（`null`），候选数据尚未接入（`null`）。替换某个模型的那一步要同时更新对应标签。
- `useMission.task` 初始为 `IDLE_TASK`。驱动状态转换的调度器在第15步实现。

## 9. 指标契约（只有形状，没有实现）

- 可见性策略分开定义：
  - 太阳 `SUN_VISIBILITY_POLICY`：圆盘任意部分高于地形地平线，不额外加仰角遮罩。
  - 地球 `earthVisibilityPolicy(minElevationDeg = 0)`：圆盘中心高于 max(地形, 最低仰角)。

  **现有代码仍对两者都用圆盘边缘规则，修正在第09步。**
- `SolarSample` 中，`sunUp` 与 `visibleDiscFraction` 是两个独立字段。后者在第09步实现之前为 `null`，不会填入占位数值。
- `NextSetResult` 带 `eventKind: 'set'`、`queryMs`、`searchStartMs/EndMs`；`found: false` 时 `eventMs` 和 `msUntil` 为 `null`。**现有的 `nextEvent` 仍返回下一个任意事件，修正在第10步。**
- `MissionMetrics` 的各项指标都是 `Quantity`：无法计算或不适用时为 `null` 并附原因（例如全程黑暗时太阳平均高度），不用 0 代替。所有指标都只在任务窗口内计算。

## 10. 旧接口的兼容方式与后续迁移

| 旧接口 | 现状 | 迁移步骤 |
|---|---|---|
| `PowerConfig`（kW/kWh，含 `stayMs`）、`DEFAULT_POWER_CONFIG` | 改名为 `LegacyPowerConfig`（W/Wh，不含时长）和 `LEGACY_PLACEHOLDER_POWER_CONFIG`；kW 数值通过 `legacyPowerConfigFromKw` 传入 | 第11、12步换成基于 `DeviceConfig` 的新模型后删除；`essentialLoadW` 在第12步移除或隔离 |
| `simulatePower(config, sunIntervals, startMs)`、`assessViability(site, landingMs, config)` | 改为 `(config, window, sunIntervals)` 和 `(site, window, config)`；`simulatePower` 也做输入校验 | 第12步 |
| `PowerSegment {startMs, endMs, loadKw}` | `{startOffsetMs, endOffsetMs, loadW}` | 第12步决定是否保留日程 |
| `isViable` | 保留，注释说明它仍跑完整模拟，不是快速预筛 | 第15、24步按实测决定 |
| `compareSites().operational` | 改名为 `sunAndEarthVisible`，语义不变 | 地球规则在第09步修正 |
| `nextEvent` / `statusAt` | 未改；新契约是 `NextSetResult` | 第10步 |
| `skyAt` / `windows` 在缺地形时按平滑球面计算 | 保留给低层测试和标注过的预览；新流程必须经过 `requireHorizon` | 第07、15步 |
| `useMission.power` / `setPower` / `resetPower` | 改为 `legacyPower` / `setLegacyPower` / `resetLegacyPower`，新增 `draft`、`setDraft`、`task`（没有界面调用这些旧名） | `AdvancedSettings` 在第05步，Clear 在第23步 |
| `horizonAt` 遇到不能整除 360 的步长时样本方位映射错误 | 改为抛出 `RangeError` | 已修复 |

## 11. 验证结果（实际执行）

| 检查 | 结果 |
|---|---|
| 重构前基准 | 在旧代码上记录 `assessViability`（20°N 30°E，2026-11-13，20 天，初始 60 kWh）和 `compareSites` 的结果，写成回归测试 |
| `npm test -- --run` | **15 个测试文件，126/126 通过**（原 10 个文件 78 项；本步迁移 `power.test.ts` 和 `sim.test.ts`，并新增 mission、assessment、horizonData、task、utcCalendar 测试）。旧算法回归与重构前完全一致：步数 5761、日照区间相同、亏欠 91 kWh、最低能量出现时刻相同 |
| `npx tsc -b` | 无输出（通过） |
| `npm run build` | 成功。仍只有第01步记录过的包体积警告（主 JS 1,213 kB，gzip 341 kB） |
| `npm run lint` / `npx eslint .` | 通过，退出码 0 |
| 页面检查 | Vite dev server + 系统 Chrome 无头模式 + puppeteer-core（临时安装在项目外，没有加入项目依赖）。地球和月球视角渲染正常，Focus 和 Sizes 切换正常，时间滑块可以改变日期；没有 pageerror、请求失败或 HTTP ≥400。只有已知警告：`THREE.Clock` 弃用（上游库）和 SwiftShader 截图造成的 ReadPixels 提示。另外，Chrome `--screenshot` 命令行截图在重构前后都是黑画布，确认是截图方式抓不到 WebGL，与改动无关 |

本步失败过一次的测试是 `mission.test.ts` 的日期范围用例。它发现着陆时间越界时会连带报时长错误，已修正校验逻辑，没有修改断言。

没有执行的检查：普通窗口和其他浏览器、Windows 平台（第24步）。

## 12. 仍未实现的能力（不在本步勾选）

- 地球圆盘中心规则、可见圆盘比例、月食（第09步）。
- 下一次 set 的查询、事件发现收敛、任务指标的计算（第10步）。
- 面板几何发电、效率和功率限值、W/Wh 新储能模型（第11、12步）。
- 候选数据、ILN-inspired 预设、高级设置的校验（第05步）。
- 地形足迹评估、数据判定能力（第04、07、08步）。
- 合格性过滤与评分（第13步）、飞行估时（第14步）、调度和缓存（第15步）。
- 时间轴 ±10 年、播放与锁定（第16步，届时使用 `utcCalendar`）。
- 真实尺寸场景（第17步）、所有业务界面（第18–22步）、Clear（第23步，使用 `utcCalendar`）。
