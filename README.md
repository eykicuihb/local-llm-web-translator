# Local LLM Web Translator | 本地大模型网页翻译助手

A sleek, lightweight Chrome Extension that translates web pages in-place (dual-language view) using local LLM servers (such as LM Studio and Ollama) or any OpenAI-compatible API.

一款基于本地大模型（支持 LM Studio, Ollama 或任意兼容 OpenAI 接口的 API）的高颜值、轻量级网页双语对照翻译 Chrome 插件。

---

## Features | 功能特性

*   **Dual-Language Translation (Immersive Style)**: Translates paragraphs and inline texts in-place, keeping both original and target language text for easy reading.
    *   **双语对照翻译**：在原文下方直接渲染翻译结果，保留原文对照，提供沉浸式的阅读体验。
*   **Viewport-based Lazy Translation**: Uses `IntersectionObserver` to queue and translate text *only as it scrolls into the viewport* (with a pre-load buffer). Minimizes API payload and context window congestion.
    *   **视口懒加载翻译**：通过 `IntersectionObserver` 仅翻译用户滚动到视口内的内容（带预加载缓存），极大减轻本地大模型并发负载及上下文窗口压力。
*   **Infinite Scroll & Dynamic Content**: Uses `MutationObserver` to automatically detect and queue newly loaded dynamic elements (e.g., social media feeds, infinite-scroll lists).
    *   **动态内容监听**：采用 `MutationObserver` 自动感知网页新增元素（如社交媒体瀑布流、无限滚动列表），并实时加入翻译队列。
*   **Zero-Config CORS Bypass for Ollama**: Configures dynamic HTTP header rules to strip origin headers for local API requests, allowing out-of-the-box translation via Ollama without changing Ollama's launching arguments.
    *   **Ollama 免配置跨域越过**：动态修改 HTTP 请求头以剥离跨域 Origin 限制，让你可以直接连通本地 Ollama 服务，无需修改 Ollama 的环境变量或启动参数。
*   **Premium Glassmorphic UI**: Sleek, modern dark-theme popup card with real-time translation progress indicators.
    *   **毛玻璃暗黑 UI**：高颜值的现代化控制面板，支持实时展现网页翻译进度。
*   **Floating Translate Widget**: A right-aligned floating button that sticks to the page side (Immersive Translate style) with:
    *   **右侧吸附悬浮窗**：在页面右侧提供像沉浸式翻译一样的悬浮球：
        *   **Vertical Drag-and-Drop**: Easily move the widget vertically. Click suppression prevents accidental triggers on drag.
            *   **垂直拖拽悬浮**：可随意调整高度，并能智能识别拖拽动作防止误触翻译。
        *   **One-Click Toggle**: Instantly trigger translation or toggle translation visibility.
            *   **一键切换双语**：一键开启翻译，或在翻译完成后快速在“双语/原文”状态切换。
        *   **Domain Blacklisting**: Close button allows blocking the widget per-domain.
            *   **域名级屏蔽**：点击右上角关闭按钮可对当前站点永久隐藏悬浮球。

---

## Quick Start | 快速上手

### Step 1: Run your Local LLM Server | 启动本地大模型服务

*   **Using LM Studio**:
    1. Load your translation model (e.g., Qwen2.5, Llama3, Gemma2).
    2. Go to the **Local Server** tab on the left sidebar.
    3. Click **Start Server** (typically runs on `http://localhost:1234/v1`).
*   **Using Ollama**:
    1. Make sure Ollama service is running (normally runs on `http://localhost:11434/v1`).
    2. Make sure you have downloaded a model (e.g., `ollama run qwen2.5`).

### Step 2: Install the Extension | 安装插件

1.  Download or clone this repository.
    *   下载或克隆本仓库代码。
2.  Open Google Chrome and navigate to `chrome://extensions/`.
    *   在 Chrome 浏览器打开 `chrome://extensions/`（扩展程序管理）。
3.  Enable **Developer mode** in the top-right corner.
    *   在右上角开启**开发者模式**。
4.  Click **Load unpacked** in the top-left corner and select this folder.
    *   点击左上角**加载已解压的扩展程序**，选择本仓库目录即可完成安装。

### Step 3: Configure & Translate | 配置并开始翻译

1.  Click the extension icon in your browser toolbar to open the popup.
    *   点击浏览器工具栏的插件图标打开控制面板。
2.  Verify the connection status shows **Connected**. If disconnected, click the gear icon (⚙️) to open advanced settings, choose your provider (Ollama / LM Studio / Custom), check the server URL, and click **Save & Connect**.
    *   确认状态显示为 **Connected**。如未连接，点击右上角齿轮 (⚙️) 并在设置中选择对应的提供商，检查 URL 后点击 **Save & Connect**。
3.  Choose your target language, display mode, and select your preferred model from the dropdown.
    *   选择目标语言、对照模式，以及要使用的大模型名称。
4.  Click **Translate Page** in the popup, or click the **floating globe icon** on the right side of the page to start translating.
    *   点击面板中的 **Translate Page**，或直接点击网页右侧的**悬浮球**即可开始翻译。

---

## File Structure | 项目结构

```text
├── manifest.json         # Manifest V3 configuration (清单配置)
├── background.js         # Service worker for API queries & CORS bypassing (背景服务/跨域处理)
├── popup.html            # Main popup UI panel (Popup 界面)
├── popup.css             # Glassmorphic dark styling (暗黑毛玻璃样式)
├── popup.js              # Connection validation and settings management (设置与连接逻辑)
├── LICENSE               # MIT License
├── README.md             # Project documentation
├── icons/                # Extension logo icons (插件各尺寸 Logo)
└── content/
    ├── content.js        # DOM traversal, lazy load logic, floating widget events (视口翻译与悬浮球逻辑)
    └── content.css       # Custom translation styles & floating widget visual aesthetics (翻译排版与悬浮球样式)
```

---

## License | 开源协议

This project is licensed under the [MIT License](LICENSE).
本项目基于 [MIT](LICENSE) 协议开源。
