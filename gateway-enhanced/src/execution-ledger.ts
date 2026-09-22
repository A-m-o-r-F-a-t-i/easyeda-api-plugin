import { GatewayProtocolError } from './protocol';

let tail: Promise<void> = Promise.resolve();

/** Every native editor operation is serialized; heartbeat traffic stays outside this queue. */
export function serializeEditorOperation<T>(operation: () => Promise<T>): Promise<T> {
	const result = tail.then(operation, operation);
	tail = result.then(() => undefined, () => undefined);
	return result;
}

export class ExecutionLedger<T> {
	private readonly entries = new Map<string, { fingerprint: string; result: Promise<T> }>();

	constructor(private readonly maximum = 1024) {}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	run(key: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.entries.get(key);
		if (previous) {
			if (previous.fingerprint !== fingerprint)
				throw new GatewayProtocolError('INVALID_REQUEST', 'executionId was reused with different content');
			return previous.result;
		}
		if (this.entries.size >= this.maximum)
			throw new GatewayProtocolError('CLIENT_UNSUPPORTED', 'Execution ledger is full; reconnect and prepare a fresh plan');
		const result = Promise.resolve().then(operation);
		// Keep successes AND failures. A rejected operation may have partially written.
		this.entries.set(key, { fingerprint, result });
		return result;
	}
}
