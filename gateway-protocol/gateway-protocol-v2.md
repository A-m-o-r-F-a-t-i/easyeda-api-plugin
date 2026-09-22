# EasyEDA Gateway Protocol v2

## 1. Scope

Protocol v2 is the typed transport contract between an EasyEDA Pro extension, the local Bridge Server, and typed MCP clients. It coexists with the v1 `execute/result/error` path. A v2 implementation must not silently fall back to an active EasyEDA window when an explicit target is supplied.

The protocol does not add APIs to EasyEDA. It standardizes capability discovery, exact target guards, bounded file/text transfer, document change epochs, event delivery, and typed operation errors around public `eda` APIs.

## 2. Compatibility

- Service identifier remains `easyeda-bridge`.
- Protocol v1 message types remain valid: `execute`, `result`, `error`, `ping`, `pong`, `handshake`, and `register`.
- A Bridge handshake advertises `protocolVersions`. Absence of this field means v1 only.
- A Gateway registration advertises its own `protocolVersions`, `gatewayVersion`, `clientVersion`, and capabilities.
- A Bridge sends `rpc-request` only when both sides advertise protocol version 2.
- Unknown operation names return `CLIENT_UNSUPPORTED`; they are never converted into arbitrary code execution.

## 3. Exact target

PCB operations require the following target object:

```json
{
  "windowId": "11111111-2222-4333-8444-555555555555",
  "projectUuid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "documentUuid": "0123456789abcdef",
  "tabId": "0123456789abcdef@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The Gateway checks all four values immediately before invoking the public API. A mismatch produces `TARGET_CHANGED`; it does not activate another tab, open another project, or substitute the active window.

`system.capabilities` may omit project/document/tab fields. `target.inspect` requires `windowId` and returns the current target identity.

## 4. Handshake and registration

Bridge to Gateway:

```json
{
  "type": "handshake",
  "service": "easyeda-bridge",
  "bridgeVersion": "2.0.0",
  "protocolVersions": [1, 2],
  "bridgeSessionId": "f89f5b4e-...",
  "clientType": "eda",
  "timestamp": 1789440000000
}
```

Gateway to Bridge:

```json
{
  "type": "register",
  "windowId": "11111111-2222-4333-8444-555555555555",
  "gatewayVersion": "1.1.0",
  "clientVersion": "3.2.186",
  "protocolVersions": [1, 2],
  "bridgeSessionId": "f89f5b4e-...",
  "capabilities": {
    "legacyExecute": true,
    "typedRpc": true,
    "changeEpoch": true,
    "eventStream": true,
    "utf8FileTransfer": true,
    "binaryChunkTransfer": false,
    "nativeBoardInfo": true,
    "dsnExport": true,
    "documentSourceHash": true
  },
  "timestamp": 1789440000100
}
```

The Bridge records registration metadata per `windowId`. A reconnect replaces only the matching window registration. Pending requests belonging to a disconnected window fail with `WINDOW_DISCONNECTED`.

## 5. Typed RPC

Bridge to Gateway:

```json
{
  "type": "rpc-request",
  "id": "a3edb8a2-...",
  "operation": "pcb.nativeBoardInfo",
  "target": {
    "windowId": "11111111-2222-4333-8444-555555555555",
    "projectUuid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "documentUuid": "0123456789abcdef",
    "tabId": "0123456789abcdef@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "expected": {
    "changeEpoch": 12
  },
  "arguments": {},
  "timestamp": 1789440000200
}
```

Gateway success:

```json
{
  "type": "rpc-result",
  "id": "a3edb8a2-...",
  "operation": "pcb.nativeBoardInfo",
  "result": {},
  "state": {
    "documentUuid": "0123456789abcdef",
    "changeEpochBefore": 12,
    "changeEpochAfter": 12,
    "lastEventSequence": 31
  },
  "timestamp": 1789440000300
}
```

Gateway failure:

```json
{
  "type": "rpc-error",
  "id": "a3edb8a2-...",
  "operation": "pcb.nativeBoardInfo",
  "error": {
    "code": "EPOCH_MISMATCH",
    "message": "Expected document change epoch does not match current state",
    "retryable": false,
    "details": {
      "expected": 12,
      "actual": 13
    }
  },
  "timestamp": 1789440000300
}
```

A typed operation returns a JSON-serializable result. It cannot return native `File`, `Blob`, primitive instances, functions, or cyclic objects.

## 6. Change epoch and events

The Gateway maintains independent state for each open PCB document:

```text
windowId + documentUuid -> { changeEpoch, lastEventSequence }
```

`changeEpoch` starts at zero after Gateway registration and increments for each observed primitive create/modify/delete event, net add/remove event, guarded schematic import, or document-source replacement. `lastEventSequence` is monotonically increasing per Gateway window.

Gateway event:

```json
{
  "type": "event",
  "windowId": "11111111-2222-4333-8444-555555555555",
  "projectUuid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "documentUuid": "0123456789abcdef",
  "tabId": "0123456789abcdef@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sequence": 32,
  "changeEpoch": 13,
  "eventType": "primitive.modify",
  "requestId": null,
  "items": [
    {
      "primitiveId": "example-id",
      "primitiveType": "Line",
      "net": "GND"
    }
  ],
  "timestamp": 1789440000400
}
```

The optional `requestId` associates an event with a currently executing typed request when the runtime makes that association observable. Clients must not assume it is always present. A guarded client uses the returned epoch after its own operation as the next expected epoch.

The Bridge stores a bounded event queue per window. When old entries are discarded, `/events` reports `eventsTruncated=true` and `oldestAvailableSequence`.

## 7. UTF-8 file envelope

P0 text exports use a bounded UTF-8 envelope:

```json
{
  "fileName": "PCB1.dsn",
  "mimeType": "text/plain",
  "encoding": "utf8",
  "byteLength": 362136,
  "sha256": "lowercase-hex",
  "text": "(PCB ..."
}
```

Requirements:

- `byteLength` is measured over UTF-8 bytes, not JavaScript character count.
- The Gateway rejects outputs above the operation-specific maximum before returning success.
- SHA-256 is computed over the exact transferred bytes.
- The Bridge and MCP independently recompute byte length and SHA-256.
- Text transfer verification does not approve electrical, manufacturing, or mechanical content.

Binary chunk transfer is optional in Protocol v2 P0 and must be advertised separately. A client must not infer it from `typedRpc=true`.

## 8. Stable error codes

| Code | Meaning | Default client action |
| --- | --- | --- |
| `INVALID_REQUEST` | Message or arguments violate the operation schema | Correct the request; do not retry unchanged |
| `CLIENT_UNSUPPORTED` | Operation or required API is unavailable on this client | Use an explicitly supported fallback |
| `TARGET_CHANGED` | Window, project, document, or tab no longer matches | Rediscover exact target |
| `EPOCH_MISMATCH` | Expected change epoch is stale | Discard the old plan and reread state |
| `CONCURRENT_CHANGE` | State changed during a guarded operation | Stop the remaining plan and inspect actual state |
| `METHOD_FAILED` | Public API invocation returned failure or invalid data | Preserve evidence; retry only after diagnosis |
| `PARTIAL_SUCCESS` | The operation may have changed state before failing | Read back before any retry |
| `FILE_TOO_LARGE` | Output exceeds the negotiated bound | Use a larger explicitly allowed bound or another export |
| `TRANSFER_HASH_MISMATCH` | Byte count or digest verification failed | Discard transferred data |
| `WINDOW_DISCONNECTED` | Target Gateway window disconnected | Reconnect and rediscover target |
| `REQUEST_TIMEOUT` | Bridge did not receive a terminal response in time | Inspect target state before retrying writes |
| `PERMISSION_DENIED` | EasyEDA or host permission rejected the operation | Stop; do not switch entrypoints to bypass it |
| `INTERNAL_ERROR` | Unexpected implementation failure | Preserve diagnostic code and bounded message |

Error messages must not include full private netlists, document sources, authentication material, or arbitrary object serialization.

## 9. HTTP API exposed by Bridge v2

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Service, protocol versions, connection and queue counts |
| `GET` | `/eda-windows` | Window registrations and advertised capabilities |
| `GET` | `/capabilities?windowId=...` | Exact Gateway capability record |
| `POST` | `/execute` | Legacy v1 code execution |
| `POST` | `/rpc` | Typed v2 request; exact `windowId` required |
| `GET` | `/events?windowId=...&afterSequence=...` | Read bounded events without changing editor state |

`/eda-windows/select` remains for v1 compatibility but typed MCP clients do not use it.

## 10. P0 operation registry

| Operation | Target requirement | Mutates PCB | Result |
| --- | --- | ---: | --- |
| `system.capabilities` | `windowId` | No | Client version, method presence and Gateway capabilities |
| `target.inspect` | `windowId` | No | Current project/document/tab and epoch state |
| `events.getState` | Full PCB target | No | Current epoch and last sequence |
| `pcb.nativeBoardInfo` | Full PCB target | No | UTF-8 PCB information file envelope |
| `pcb.exportDsn` | Full PCB target | No | UTF-8 Specctra DSN file envelope |
| `document.sourceHash` | Full target | No | Source byte count and SHA-256 without returning source text |

Later operations require a protocol minor revision or an independently versioned operation schema. They must not change the meaning of existing operation names.

## 11. Limits

Initial defaults:

- HTTP JSON request: 8 MiB.
- RPC JSON response: 16 MiB.
- PCB Info text: 1 MiB.
- DSN text: 12 MiB.
- Event queue: 2,000 entries per window.
- RPC timeout: operation-specific, maximum 300 seconds.

Implementations may use lower limits but must advertise them and return a stable error rather than truncating successful data.
