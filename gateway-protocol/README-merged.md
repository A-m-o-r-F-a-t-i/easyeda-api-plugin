# Active Protocol v2 contract

`contract.json` defines operation versions and shared limits. `src/index.ts` is the Gateway executable envelope validator and TypeScript source; the Gateway imports it instead of maintaining a private copy. `rpc-request.schema.json` describes the HTTP envelope; Bridge strips its bridgeGenerationId field before WebSocket forwarding.

The Bridge distributable and API Skill receive identical contract.json copies during packaging. Release verification compares byte digests and rejects drift. Earlier proposal files retained in this directory are historical migration input, not the active wire specification.

Binary chunk streaming is not enabled. Generation is currently reset on Bridge/Gateway connection lifetime; native document reload events are not complete, so source hashes and per-object old-state checks remain necessary.
