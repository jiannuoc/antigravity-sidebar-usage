# Antigravity Sidebar Usage (`antigravity-sidebar-usage`)

将实时 **周额度**、**5 小时额度**、**当前上下文 Token 用量** 以及 **类 DeepSeek Harness 实时 Token 生成速度** 固定显示在 Antigravity 2.0 桌面客户端左侧栏 **设置（Settings）按钮上方** 的轻量级增强插件。

## 核心特性

- **四合一常驻监控（折叠态即见）**
  - **周额度 & 5 小时额度**：智能追踪最近发生变化的模型配额并锁定常驻显示，不会因为切换对话或回到首页而在不同模型间来回跳变。
  - **当前上下文**：实时展示当前对话已用 Token / 上限及百分比进度条。
  - **实时 Token 速度栏**：紧凑状态行 + 10 柱微型速率波形（Sparkline）+ 首字延迟（`TTFT`）；空闲时保留上一轮实测 `tok/s`，流式生成时自动切换为 `250ms` 高频实时跳动（`预热中` → `实时 tok/s`）。
- **10 秒自动刷新**：后台每 10 秒自动同步最新配额与上下文状态，也支持点击右上角按钮手动立即刷新。
- **展开查看完整明细（无内部滚动条）**
  - 全部模型分组配额、重置倒计时与 AI Credits。
  - 上下文构成明细（用户消息、智能体回复、工具调用、系统提示、规则 / 技能 / MCP）。
  - 生成性能详情（生成速度、首字延迟 `TTFT`、缓存命中率、本轮输出回复 / 思考 Token 拆分）。
- **样式隔离与汉化共存**：通过 Shadow DOM 隔离样式，使用独立起止标记注入 `dist/preload.js`，不破坏现有汉化补丁，支持一键无损卸载还原。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `src/sidebar-usage-widget.js` | 左侧栏实时用量与速率组件脚本（Shadow DOM、Connect-RPC 轮询、流式速率采样） |
| `install.py` | `app.asar` 安全检查、自动备份、SHA-256 校验并注入/卸载 `dist/preload.js` 的安装器 |
| `install.bat` | Windows 一键安装 / 更新脚本（支持自动重启 Antigravity 解除文件占用） |
| `uninstall.bat` | Windows 一键卸载恢复脚本 |
| `preview.html` | 本地浏览器交互式预览页（内置模拟数据与流式生成演示，无需修改客户端） |
| `tests/test_all.py` | 安装器与前端逻辑自动化测试套件 |

## 本地预览（无需修改客户端）

直接用浏览器打开 `preview.html` 即可体验完整交互：
- 模拟消耗 Gemini / Claude 额度，观察常驻配额锁定逻辑
- 切换不同对话或回到首页，验证上下文独立更新
- 点击 **「⚡ 模拟流式生成 (Live tok/s)」** 预览实时波形与 `TTFT` 跳动
- 点击卡片展开/收起完整详情面板

## 安装、查看状态与卸载

### 方式一：Windows 一键批处理（推荐）

- **安装 / 更新**：双击运行 `install.bat`（若客户端正在运行，会自动重启 Antigravity 以解除 `app.asar` 占用并完成写入）
- **卸载恢复**：双击运行 `uninstall.bat`

> 提示：如果 Antigravity 客户端后续自动更新覆盖了 `app.asar`，重新运行一次 `install.bat` 即可。

### 方式二：命令行（`install.py`）

```powershell
# 查看当前安装状态与校验信息（只读，无需关闭客户端）
python install.py --action status

# 预览将要执行的改动（演练模式，不写入磁盘）
python install.py --action install --dry-run

# 执行安装或更新（如客户端正在运行，可附加 --restart-app 自动重启）
python install.py --action install --restart-app

# 卸载并清理注入代码块
python install.py --action uninstall --restart-app
```

也可通过 `--asar <路径>` 指定自定义的 `app.asar` 文件路径。

## 运行测试

测试会复制本机 `app.asar` 到临时文件进行完整安装/幂等重装/卸载及前端行为验证（测试结束自动清理临时文件，不会修改线上客户端）：

```powershell
node --check src/sidebar-usage-widget.js
python -m unittest discover -s tests -v
```

## License

MIT
