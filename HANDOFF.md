# HANDOFF — 划词翻译修复 + 全量 Review 整改 + UX 增强

> 更新:2026-08-22 · 分支 `main` · **Review 整改(A-E)与沉浸翻译对标的 UX 增强(F1-F7)全部完成并推送**
> 工作区:`scratch/` 未跟踪(来源不明,处理前先看内容,可删)

---

## 1. 项目一句话

Chrome MV3 扩展,用本地 LLM(LM Studio / Ollama / OpenAI 兼容)做整页翻译 + 划词翻译 + 悬停/输入框翻译。文件:`manifest.json`、`background.js`(service worker)、`popup.*`、`content/content.js`(约 1390 行)、`content/events.js`(document_start 事件特权通道)、`content/content.css`。

## 2. 必读:三条已确认的根因(血泪史,别再走回头路)

1. **"GitHub 划词失效"真因 = `ignoredDomains` 门控过宽**(commit `ce726b6`)。误点小球 × 会把域名写进忽略列表,旧代码用它门控了*所有*初始化。已改为只门控悬浮小球,划词始终初始化。前 6 个 commit 都在改根本没执行的代码。
2. **"X.com 点图标不翻译、重复刷图标"真因 = 敌意页面事件拦截**(commit `716af2c`)。X.com 类 SPA 在页面脚本阶段注册捕获监听并对 mouse/pointer/click 调 `stopImmediatePropagation()`。content script 晚于页面加载 → 后注册的一切监听器被静默,**元素级 onclick 也永远收不到事件**。
3. **调试纪律教训**:每次都先用 DOM 探测/真实浏览器确认"代码到底有没有在跑",再动逻辑。jsdom 模拟曾给出假阳性。

## 3. 核心架构不变量(违反即复发)

- **一切指针处理必须走 `window.__lmtOnEvent`**,由 `content/events.js` 在 `document_start` 注册的捕获监听喂入——它比任何页面脚本早,必然第一个看到原始事件;我们只观察、从不 stop 传播。**键盘事件(keydown/keyup)同样走 tap**,IME 组合事件(isComposing/keyCode 229)一律忽略。
- **UI 激活一律用 `element._lmtActivate()`**,由 hook 遍历 `composedPath()` 调用(最近节点优先:× 在 widget 前、retry 徽标在 widget 前);禁止依赖 onclick/onmousedown 等元素级处理器(敌意页面上是死的)。悬浮球主点击、×、retry 徽标、trigger、气泡关闭/朗读/复制全部走此路由。
- **一切拖拽必须注册进 `_lmtDragControllers`**(模块级 Set),由 hook 在 `__lmtSeen` 去重后、其余分支前分发 `down/move/up/cancel`(仅 pointer 系事件,touch 已被 pointer 覆盖)。控制器内部各自 try/catch 隔离。
- **拖拽防误触**:widget 控制器拖后置 `_lmtSuppressClick=true`,`widget._lmtActivate` 开头吞掉一次;下次 pointerdown 或成功激活时清除。
- **悬停翻译的"单独按 Ctrl"判定**:Control keydown 置位,期间任意其它按键置 combo 标志,Control keyup 时仅无 combo 才触发——保证 Ctrl+C/A/V 不受影响。
- **输入框三连空格检测在第三个空格的 keydown 上,匹配的是值末尾的两个空格**(插入发生在 keydown 默认动作之后)——别"修正"成查三个;响应回来时若值已变(snapshot 对比)则放弃替换。
- **widget 激活不受 `selectionTranslateEnabled` 门控**——该 flag 只管划词(trigger 内部自行检查)。
- events.js 同时 tap window 和 document → **每个事件到达 hook 两次**,靠 `e.__lmtSeen` 去重(现在去重在 hook 最顶部,mousemove 也去重了)。
- popup 的程序化兜底注入顺序必须是 `events.js` → `content.js`(css 最先);Alt+A 命令在 SW 里的兜底注入沿用同一顺序。
- **翻译样式经 storage.onChanged 实时分发**(不走 per-tab 消息),content.js 的 setTranslationStyleClass 应用 body 类。

## 4. E2E 反馈循环(改动后必跑)

```bash
cd /tmp/lmt-e2e            # Playwright + Chromium 已装好;若目录被清:
# cd /tmp && mkdir lmt-e2e && cd lmt-e2e && npm i playwright && npx playwright install chromium
node test.js page.html     # 普通页:选词→点图标→气泡出现+图标隐藏
node test.js hostile.html  # 敌意页:模拟 X.com 在捕获层杀光 mouse/pointer/click
node test-widget.js page.html     # 扩展:小球可见/点击入翻译态/垂直拖拽/防误触/气泡拖拽/× 关闭
node test-widget.js hostile.html  # 同上,敌意页
node test-popup.js         # C5 忽略域名管理列表(经 SW 上下文种数据)
node test-features.js      # F1-F7 全功能:内置 mock LLM 服务器(:8899 good / :8898 bad),验证真实注入、悬停、输入框、自定义指令透传、样式切换、重试闭环、朗读按钮、命令注册
```

六组都必须全 ✓。语法检查:`node --check content/content.js content/events.js background.js popup.js`。

**test-features.js 的 mock LLM 要点**:OpenAI 兼容 `/v1/models` + `/v1/chat/completions`(返回 `[译] <原文>`),`/last` 端点记录最近请求体供断言;必须处理 OPTIONS 预检并只对 `/chat/completions` 走 completions 分支(其它路径 404,否则 favicon 之类的空 body 会炸掉解析)。seed 设置必须"写入→回读校验→重试":全新 profile 下 `chrome.runtime.onInstalled` 的补缺省值会与首次 seed 竞态覆盖。

**测试环境已知怪癖**(勿当产品 bug):
- 合成鼠标事件在此环境**不触发 `:hover`**,而 `.lmt-close-widget` 默认 `pointer-events:none !important`,所以 × 无法被直接点击——test-widget 用 `setProperty(...,'important')` 强制可命中来测路由。真实用户 hover 正常。
- × 中心点落在 widget 圆角切空区(border-radius 22px),hit-test 会穿透到 HTML,这是 hover 不生效的几何原因之一。
- 主世界 evaluate 读不到隔离世界的 expando(`_lmtActivate`/`__lmtOnEvent` 显示 undefined 是正常的),但 classList/DOM 属性跨世界共享。

## 5. 当前进度(GOALS.md 为准,此处是快照)

### 已完成并提交
| 提交 | 内容 |
|---|---|
| `716af2c` | X.com 修复:events.js tap + `__lmtOnEvent` + `_lmtActivate` 路由 |
| `2bce59b` | 复制按钮 ReferenceError + 兜底注入补 events.js |
| `29ac82b` | B1-B3:resolveModel 去重+60s 记忆、错误不再注入页面 |
| `c51594e` | C1-C4:'current' 哨兵、字符串模型、GET_PAGE_STATUS 限主帧、进度按帧聚合 |
| Commit 3(本次) | A4/A5/A6/D1-D4 + 附带项:拖拽控制器注册表、widget/气泡拖拽走 tap、contextmenu 走 tap、删 `_mouseDown`、空 catch 加日志、抽 `_lmtEventHitsUi`、超长选区提示气泡(`_lmtShowHint`)、气泡空结果显示"翻译结果为空,请重试"。GOALS.md 勾选同步。 |
| Commit 4(本次) | C5:popup 设置抽屉"忽略的网站"管理列表(渲染/逐个删除/空态,test-popup.js 验证);E1/E2:README 补 events.js 结构与划词/忽略域名恢复文档,CHROMEWEBSTORE.md 权限表补 tabs/DNR 与存储键说明。 |
| Commit 5(本次) | F1-F7 UX 增强(对标沉浸翻译):悬停+Ctrl 单段翻译、划词气泡朗读(TTS)、自定义翻译指令、输入框三连空格翻译、Alt+A 全局快捷键(SW 兜底注入)、翻译样式三变体实时切换、失败段落 ↻ 徽标重试。events.js tap 扩展 keydown/keyup(IME 防护);新增 test-features.js(mock LLM 端到端 12 断言)。 |

### 待办
- 无。A-F 全部完成,六组 E2E 全绿,已推送 origin/main(2026-08-22)。
- 未来可选(PDF/EPUB/字幕/视频双语/图片 OCR 工程量过大,明确不做)。

## 6. 地雷区

- **并行会话**:本仓库有另一个 agent/会话在同时提交过(d1320c6…c7c7afa)。动手前先 `git log --oneline -5` + `git status`,别覆盖别人改动。
- `/tmp/lmt-e2e` 是临时产物,重启即失;重建命令在第 4 节。`test-widget.js` 是本次新增的扩展验证脚本,值得随目录一起保留。
- `scratch/` 目录未跟踪,来源不明,处理前先看内容。
- background 的 `resolveModel` 有 60s 模块级缓存,MV3 worker 冷启动会丢缓存——属预期,不是 bug。
- 用户沟通偏好:中文、直接、讨厌空等("继续"×N = 快干活);重要分叉用 AskUserQuestion。

## 7. 验证清单(收工标准)

- [x] `node --check` 四个 JS 全过 + manifest.json JSON 合法
- [x] E2E 六组全 ✓(page/hostile × 划词、widget、popup 管理列表、features)
- [x] 敌意页上:小球可见、点击小球能进入翻译态(`lmt-active` 断言通过)、小球/气泡可拖拽、拖后误触被抑制(test-widget 双页全过)
- [x] F1-F7 全部经 mock-LLM 端到端断言(真实注入译文,非仅 UI 冒烟;popup 打开无报错、模型徽章正常在 test-popup/features 中覆盖)
- [x] 无页面错误(pageerror 监听为零)
- [x] GOALS.md 与实际一致;handoff 本文件更新
