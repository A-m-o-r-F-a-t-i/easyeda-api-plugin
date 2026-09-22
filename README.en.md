# EasyEDA Pro API Plugin

[简体中文](README.md) | English

This public repository contains the local API extension and communication stack used with EasyEDA Pro. The primary extension is **Enhanced API Gateway 1.1.5**. It adds a typed Protocol v2, exact project/window/document identity, PCB change epochs, source fingerprints, guarded batches, and recoverable Bridge communication on top of the official public extension APIs.

This repository owns only the API plugin stack. The five AgentDock EasyEDA Skills and the PCB MCP live in separate public repositories and are assembled by the parent `easyeda-ai-plugin` repository through Git submodules.

## Components

| Directory | Version | Responsibility |
| --- | ---: | --- |
| `gateway-enhanced/` | 1.1.5 | EasyEDA Pro extension that connects to the local Bridge and executes typed RPC requests |
| `gateway-protocol/` | 2 | Protocol v2 contracts, schemas, operation registry, and type entry points |
| `eda-runtime/` | 2.0.3 | Shared read, plan validation, PCB operation, constraint, and text runtimes |
| `bridge-server/` | 2.0.0 | Local WebSocket/HTTP Bridge, reconnect handling, and bounded file transfer |

`easyeda-pcb-mcp/` is an independent Git repository and is intentionally ignored here so the MCP source is never committed twice.

## Data flow

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

The Gateway and Bridge validate project, window, and document identity. Mutations additionally use generations, source hashes, and expected old state so reconnects, tab switches, or concurrent edits cannot silently redirect a plan to a different target.

## Development and verification

Node.js 20.17 or newer is required. The separately managed PCB MCP requires Node.js 22 and is not installed by this workspace.

```powershell
# Install locked Gateway and Bridge dependencies
npm run bootstrap

# Run protocol, Gateway, and Bridge tests
npm test

# Compile the Gateway extension
npm run build

# Produce the extension package
npm run package:extension
```

See `gateway-enhanced/README.en.md` and `gateway-enhanced/FAQ.en.md` for extension installation, menus, connectivity, and troubleshooting. Protocol fields and compatibility rules are documented under `gateway-protocol/`.

## Repository rules

- Never commit `.env` files, tokens, private keys, user-specific paths, runtime logs, `node_modules`, or generated `dist` output.
- Keep `gateway-protocol/contract.json` and `bridge-server/contract.json` synchronized. Run protocol, Gateway, and Bridge tests after every protocol change.
- Gateway sources import `eda-runtime/` and `gateway-protocol/` by workspace-relative paths, so all four directories must be checked out together.
- Use only real public EasyEDA SDK APIs. Record missing capabilities explicitly in the protocol and tool layers rather than bypassing them with arbitrary script injection.

## License and origin

The Gateway is developed from EasyEDA's official Apache-2.0 extension project. The original license is preserved in [LICENSE](LICENSE) and `gateway-enhanced/LICENSE`. Public visibility does not alter upstream licenses, trademarks, or third-party rights.

