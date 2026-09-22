# 嘉立创 EDA API 插件

简体中文 | [English](README.en.md)

这是嘉立创 EDA 专业版本地 API 插件及其通信栈的私有源码仓库。当前主扩展为 **Enhanced API Gateway 1.1.5**。它在官方公开扩展 API 之上提供类型化 Protocol v2、精确工程/窗口/文档身份、PCB 变更代次、源码指纹、批处理保护和可恢复 Bridge 通信，供 AI 工具与本机嘉立创 EDA 可靠协作。

本仓库只管理 API 插件栈。AgentDock 中的 5 个 EasyEDA Skill 和 PCB MCP 分别位于独立私有仓库，由上层 `easyeda-ai-plugin` 通过 Git submodule 聚合。

## 组件

| 目录 | 当前版本 | 作用 |
| --- | ---: | --- |
| `gateway-enhanced/` | 1.1.5 | 嘉立创 EDA 专业版扩展，连接本机 Bridge 并执行类型化 RPC |
| `gateway-protocol/` | 2 | Protocol v2 合约、Schema、操作清单和类型入口 |
| `eda-runtime/` | 2.0.3 | Gateway 共用的读取、计划校验、PCB 操作、约束和文本运行时 |
| `bridge-server/` | 2.0.0 | 本机 WebSocket/HTTP Bridge、连接恢复和有界文件传输 |

`easyeda-pcb-mcp/` 是独立 Git 仓库，在本仓库中被明确忽略，避免同一份 MCP 源码被重复提交。

## 数据流

```text
AI / MCP client
      │ stdio / typed requests
      ▼
local Bridge server
      │ authenticated local connection
      ▼
Enhanced API Gateway extension
      │ official EasyEDA Pro extension APIs
      ▼
active EasyEDA project / document
```

Gateway 与 Bridge 会同时校验工程、窗口和文档身份。写操作还使用代次、源码哈希和预期旧状态，避免断线重连、标签页切换或并发修改后把计划落到错误对象上。

## 开发与验证

需要 Node.js 20.17 或更高版本；PCB MCP 单独要求 Node.js 22，不属于本仓库安装步骤。

```powershell
# 安装 Gateway 与 Bridge 的锁定依赖
npm run bootstrap

# 协议、Gateway 和 Bridge 测试
npm test

# 编译 Gateway 扩展
npm run build

# 生成扩展安装包
npm run package:extension
```

更详细的扩展安装、菜单、连接和故障排查见 `gateway-enhanced/README.md`、`gateway-enhanced/FAQ.md`。协议字段和兼容边界见 `gateway-protocol/`。

## 仓库规则

- 不提交 `.env`、令牌、私钥、用户目录、运行日志、`node_modules` 或构建后的 `dist`。
- `gateway-protocol/contract.json` 与 `bridge-server/contract.json` 必须保持同步；修改协议后同时运行协议、Gateway 和 Bridge 测试。
- Gateway 源码对 `eda-runtime/` 和 `gateway-protocol/` 使用工作区相对导入，因此四个目录应一起检出。
- 对公开 EasyEDA SDK 的调用只使用真实存在的 API；缺失能力应在协议与工具层显式标注，不通过任意脚本注入绕过。

## 许可证与来源

Gateway 基于 EasyEDA 官方 Apache-2.0 扩展项目持续开发，原始许可证保存在 [LICENSE](LICENSE) 和 `gateway-enhanced/LICENSE`。本私有仓库不会改变上游许可证、商标或第三方权利。

