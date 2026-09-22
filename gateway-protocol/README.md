# EasyEDA integrated upgrade protocol

This directory is the versioned contract shared by the Enhanced API Gateway, the Bridge Server inside `easyeda-api`, and `easyeda-pcb-mcp`.

Files:

- `gateway-protocol-v2.md`: normative behavior and compatibility rules.
- `gateway-protocol-v2.schema.json`: WebSocket message schema.
- `operations-v2.json`: P0 operation registry, limits, and stable error codes.
- `test-protocol.mjs`: dependency-free structural checks for the protocol artifacts.

Protocol v1 remains supported. Protocol v2 adds typed RPC, exact targets, change epochs, event delivery, and bounded UTF-8 file envelopes. Binary stream transfer is deliberately not claimed by the P0 capability set.

Run:

```text
node test-protocol.mjs
```
