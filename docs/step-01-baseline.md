# 第01步：工程基础检查记录

检查日期：2026-11-14

## 1. 检查版本与环境

| 项目 | 结果 |
|---|---|
| 代码来源 | `moon-planner-main` 解压目录（`Downloads/moon-planner-main (1)/moon-planner-main`） |
| Git 分支 / 提交 / 未提交改动 | **无法获取**：目录不是 Git 仓库（`git status` 报 `not a git repository`），无分支、提交和改动记录可查 |
| 操作系统 | macOS (Darwin 25.6.0, arm64) |
| Node.js | v24.21.0 |
| npm | 11.19.0 |
| 锁文件 | `package-lock.json`，lockfileVersion 3，与 `package.json` 一致 |

主要依赖实际安装版本：

| 包 | 版本 |
|---|---|
| react / react-dom | 19.3.1 |
| three | 0.187.0 |
| @react-three/fiber | 9.8.2 |
| @react-three/drei | 10.7.9 |
| astronomy-engine | 2.1.19 |
| zustand | 5.1.0 |
| vite | 8.3.8 |
| typescript | 6.0.3 |
| eslint | 10.15.0 |
| vitest | 5.1.0 |

现有运行命令（`package.json` scripts）：

| 命令 | 内容 |
|---|---|
| `npm run dev` | `vite` |
| `npm run build` | `tsc -b && vite build` |
| `npm run lint` | `eslint .` |
| `npm run preview` | `vite preview` |
| `npm test -- --run` | `vitest --run` |

## 2. 依赖安装

执行 `npm ci`：**成功**，安装 235 个包，没有修改锁文件。

安装时的提示（不影响运行，未处理）：

- `npm audit`：7 个 moderate 漏洞，全部来自开发依赖链 `typescript-eslint` → `@typescript-eslint/typescript-estree` → `minimatch`（GHSA-g3hv-75wg-m249，正则 DoS）。只在 Lint 阶段使用，不进入浏览器包。`npm audit fix --force` 会把 `typescript-eslint` 降级到 8.36.0，属于破坏性变更，按本步原则不升级、不降级。
- `fsevents@2.3.3` 的安装脚本未被 npm `allowScripts` 允许。它是 macOS 文件监听的可选依赖，dev server 热更新实测正常。

## 3. 保留的已有实现

以下实现检查后认为正确、清晰，原样保留：

- **工程配置**：`vite.config.ts`、`tsconfig*.json`（app/node 分开配置，strict 级别的未使用变量检查）、`eslint.config.js`（js + typescript-eslint + react-hooks + react-refresh 推荐规则）。没有关闭任何规则。
- **场景组件** `src/scene/`：`Scene`、`Earth`、`Moon`、`Sun`、`SunLight`、`Stars`、`Controls`。在 `useFrame` 中通过 `useTime.getState()` 读取时间，拖动滑块时不会触发 React 重渲染，写法合理。
- **状态** `src/state/`：`appStore`（尺寸夸张 / 视角焦点）、`timeStore`（时间及前后 30 天范围）、`missionStore`。
- **UI**：`App.tsx` 的两个切换按钮、`ui/Timeline.tsx` 时间滑块。
- **物理/模拟层** `src/physics/`、`src/sim/` 及其 10 个测试文件，本步不改动（天文精度留到后续步骤）。
- **文档**：`docs/SIM_API.md`、`sources.md`。项目中没有其他同用途的基线记录，所以新建本文件。

## 4. 修改的文件与原因

| 文件 | 修改 | 原因 |
|---|---|---|
| `src/scene/Sun.tsx` 第27行 | `useMemo(makeGlowTexture, [])` → `useMemo(() => makeGlowTexture(), [])` | `eslint-plugin-react-hooks` 7.x 的 `react-hooks/use-memo` 规则要求第一个参数是内联函数，原写法会报 **error**，导致 `npm run lint` 失败。改后行为不变：纹理仍只在挂载时创建一次。 |
| `docs/step-01-baseline.md` | 新建 | 本步骤要求的检查记录。 |

除此以外没有修改源码、配置、依赖或锁文件。

## 5. 检查结果

### 修改前

| 检查 | 结果 |
|---|---|
| `npm test -- --run` | 通过：10 个测试文件，78 个测试全部通过 |
| `npm run build` | 成功，有 1 条**警告**（包体积，见下） |
| `npm run lint` | **失败**：1 个 error（`src/scene/Sun.tsx:27` `react-hooks/use-memo`），0 个 warning |

### 修改后（最终状态）

| 检查 | 结果 |
|---|---|
| `npm test -- --run` | **通过**：10 个测试文件，78/78 |
| `npm run build` | **成功**：`tsc -b` 无类型错误；`vite build` 有 1 条警告（包体积） |
| `npm run lint` | **通过**：0 error，0 warning |

### 构建包体积警告（已记录，暂不优化）

```
dist/assets/index-*.js   1,213.06 kB │ gzip: 341.27 kB
(!) Some chunks are larger than 500 kB after minification.
```

体积主要来自 three.js、@react-three/drei 和 astronomy-engine。应用目前只有一个 3D 页面，首屏就需要全部这些模块，代码分割无法减少首屏加载量；gzip 后 341 kB，对当前本地使用没有实际影响。本步只记录，不为了消除提示而改构建配置或重构代码。等后续加入详情页等可延迟加载的页面时，再考虑用 `import()` 拆分。

## 6. 页面检查

执行 `npm run dev`：Vite 79 ms 启动，`http://localhost:5173/` 返回 200，`/textures/earth.jpg` 和 `/textures/moon.jpg` 返回 200。

浏览器检查方式：系统 Google Chrome（无头模式，SwiftShader WebGL）+ puppeteer-core。puppeteer-core 装在项目外的临时目录，**没有加入项目依赖**。视口 1280×800。

| 检查项 | 结果 |
|---|---|
| 页面加载 | 正常，canvas 尺寸 1280×800，WebGL2 可用 |
| 地球显示 | 正常：带贴图，有日照明暗面，背景星空正常 |
| 月球显示 | 正常：带贴图，有明暗相位，并显示坐标轴辅助线（`Moon.tsx` 中的 `axesHelper`） |
| Focus 切换 | 正常：`earth` → `moon` 时镜头移到月球近景，切回 `earth` 后回到地球视角 |
| Sizes 切换 | 正常：`exaggerated` ↔ `true scale`，月球大小随之变化 |
| 时间滑块（鼠标点击） | 正常：日期从 2026-11-15 变到 2026-12-03，月相和月球位置随之变化 |
| 时间滑块（键盘方向键） | 正常：每按一次 ← 后退 60 秒（step = 60000 ms） |
| 控制台 error / pageerror | **无** |
| 请求失败 / HTTP ≥400 | **无** |
| 控制台 warning | 1）`THREE.Clock: This module has been deprecated`：由 `@react-three/fiber` 9.8.2 内部调用触发，项目代码没有使用 `Clock`；2）`GPU stall due to ReadPixels`：无头浏览器截图 + SwiftShader 引起，与项目代码无关 |

说明：这一节只确认现有功能能正常运行，没有验证天文位置和相位是否准确（留到后续步骤）。未在有 GPU 的普通窗口模式下手动检查，也未检查移动端尺寸。

## 7. 未解决问题与后续注意事项

1. **不是 Git 仓库**：无法记录分支、提交和改动，后续改动也没有版本追踪。建议用户自行决定是否 `git init` 或从原仓库克隆（本步未操作）。
2. **开发依赖的 moderate 漏洞（7 个）**：只影响 Lint 工具链，等 `typescript-eslint` 发布修复版本后再正常升级。
3. **构建包体积警告**：见第5节，暂不处理。
4. **`THREE.Clock` 弃用警告**：来自上游 `@react-three/fiber`，等上游更新，不在项目内处理。
5. **README 仍是 Vite 模板原文**，没有项目说明。本步不重写，可在后续步骤补充。
6. `Moon.tsx` 中的 `axesHelper` 看起来是调试用的辅助线，是否保留留到后续 UI 步骤决定。
