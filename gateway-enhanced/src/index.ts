/**
 * Enhanced EasyEDA API Gateway
 *
 * Protocol v1 remains available for existing clients. Protocol v2 adds typed
 * read-only RPC, exact-target guards, bounded UTF-8 exports and PCB change
 * epochs without exposing additional arbitrary operations.
 */
import * as extensionConfig from '../extension.json';
import { serializeEditorOperation } from './execution-ledger';
import { getGenerationId,	registerPcbEventListeners,	setConnectionWindow,	setEventSender,	unregisterPcbEventListeners } from './gateway-state';

import {
	GatewayProtocolError,
	negotiateProtocolVersion,
	PROTOCOL_VERSIONS,
	toRpcError,
} from './protocol';
import { executeTypedRequest, getRuntimeCapabilities } from './typed-rpc';

const WS_ID = 'ai-bridge-v2';
const PORT_START = 49620;
const PORT_END = 49629;
const SERVICE_ID = 'easyeda-bridge';
const RETRY_DELAY_MS = 3000;
const MAX_RETRIES = 5;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const CONNECTION_TIMEOUT_MS = 1500;
const STORAGE_KEY_AUTO_CONNECT = 'autoConnectEnabled';
const MBUS_TOPIC_STATUS = 'enhanced-api-gateway-status';
const MBUS_TOPIC_CONTROL = 'enhanced-api-gateway-control';

let currentPort: number | null = null;
let handshakeVerified = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatPending = false;
let autoConnectEnabled = true;
let retryCount = 0;
let windowId: string | null = null;
let isConnecting = false;
let connectionSessionId = 0;
let messageBusRegistered = false;
let negotiatedProtocolVersion: 1 | 2 = 1;
let bridgeSessionId: string | null = null;

interface GatewayControlRequest {
	command: 'reconnect' | 'stop';
}

interface GatewayConnectionStatus {
	connected: boolean;
	connecting: boolean;
	port: number | null;
	windowId: string | null;
	gatewayVersion: string;
	protocolVersion: 1 | 2;
}

interface GatewayControlResponse {
	handled: boolean;
	connected: boolean;
	windowId: string | null;
	protocolVersion: 1 | 2;
}

interface BridgeMessage {
	type?: unknown;
	id?: unknown;
	code?: unknown;
	service?: unknown;
	result?: unknown;
	error?: unknown;
	timestamp?: unknown;
	protocolVersions?: unknown;
	bridgeSessionId?: unknown;
	operation?: unknown;
}

function getConnectionStatus(): GatewayConnectionStatus {
	return {
		connected: handshakeVerified,
		connecting: isConnecting,
		port: currentPort,
		windowId,
		gatewayVersion: extensionConfig.version,
		protocolVersion: negotiatedProtocolVersion,
	};
}

function ensureMessageBusServices(): void {
	if (messageBusRegistered)
		return;

	eda.sys_MessageBus.rpcService(MBUS_TOPIC_STATUS, () => getConnectionStatus());
	eda.sys_MessageBus.rpcService(MBUS_TOPIC_CONTROL, (request?: GatewayControlRequest): GatewayControlResponse => {
		if (request?.command === 'reconnect')
			performReconnect();
		else if (request?.command === 'stop')
			performStopConnection(false);

		return {
			handled: true,
			connected: handshakeVerified,
			windowId,
			protocolVersion: negotiatedProtocolVersion,
		};
	});

	messageBusRegistered = true;
}

function nextConnectionSessionId(): number {
	connectionSessionId += 1;
	return connectionSessionId;
}

function isConnectionSessionActive(sessionId: number): boolean {
	return sessionId === connectionSessionId;
}

function closeWebSocket(): void {
	try {
		eda.sys_WebSocket.close(WS_ID);
	}
	catch { /* best effort */ }
}

function sendBridgeMessage(message: unknown): boolean {
	if (!handshakeVerified)
		return false;
	try {
		eda.sys_WebSocket.send(WS_ID, JSON.stringify(message));
		return true;
	}
	catch (error) {
		console.error('[API-Gateway] WebSocket send failed:', error instanceof Error ? error.message : String(error));
		return false;
	}
}

function cancelConnectionFlow(resetRetryCount = true): void {
	nextConnectionSessionId();
	isConnecting = false;
	clearRetryTimer();
	stopHeartbeat();
	handshakeVerified = false;
	currentPort = null;
	windowId = null;
	negotiatedProtocolVersion = 1;
	bridgeSessionId = null;
	setConnectionWindow(null);
	if (resetRetryCount)
		retryCount = 0;
	closeWebSocket();
}

function performReconnect(): void {
	eda.sys_Message.showToastMessage(eda.sys_I18n.text('Reconnecting...'));
	cancelConnectionFlow();
	void scanAndConnect();
}

function performStopConnection(showToast = true): void {
	cancelConnectionFlow();
	if (showToast)
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('Connection stopped'));
}

async function dispatchControlCommand(command: GatewayControlRequest['command']): Promise<void> {
	try {
		const response = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_CONTROL, { command }, 500) as GatewayControlResponse;
		if (response?.handled) {
			if (command === 'stop')
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('Connection stopped'));
			return;
		}
	}
	catch { /* fall back to this extension instance */ }

	ensureMessageBusServices();
	if (command === 'reconnect')
		performReconnect();
	else
		performStopConnection();
}

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	ensureMessageBusServices();
	setEventSender((message) => {
		sendBridgeMessage(message);
	});
	registerPcbEventListeners();
	const storedValue = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	autoConnectEnabled = storedValue !== false;
	if (autoConnectEnabled)
		void scanAndConnect();
}

export function deactivate(): void {
	setEventSender(null);
	unregisterPcbEventListeners();
	cancelConnectionFlow(false);
}

export function reconnect(): void {
	void dispatchControlCommand('reconnect');
}

export async function about(): Promise<void> {
	let status: string;
	let statusInfo: GatewayConnectionStatus = {
		connected: false,
		connecting: false,
		port: null,
		windowId: null,
		gatewayVersion: extensionConfig.version,
		protocolVersion: 1,
	};
	try {
		statusInfo = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_STATUS, undefined, 300) as GatewayConnectionStatus;
	}
	catch { /* show local fallback status */ }

	if (statusInfo.connected) {
		const portInfo = `Connected (port ${statusInfo.port})`;
		const protocolInfo = `\nProtocol: v${statusInfo.protocolVersion}`;
		const windowInfo = statusInfo.windowId ? `\nWindow ID: ${statusInfo.windowId}` : '\nWindow ID: (not registered)';
		status = `${portInfo}${protocolInfo}${windowInfo}`;
	}
	else if (statusInfo.connecting) {
		status = 'Connecting...';
	}
	else {
		status = 'Disconnected';
	}

	eda.sys_Dialog.showInformationMessage(
		`Enhanced API Gateway v${extensionConfig.version}\n${status}`,
		'About',
	);
}

export async function toggleAutoConnect(): Promise<void> {
	const current = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	const enabled = current !== false;
	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT, !enabled);
	const msgKey = !enabled ? 'Auto-Connect enabled' : 'Auto-Connect disabled';
	eda.sys_Message.showToastMessage(eda.sys_I18n.text(msgKey));
}

export function stopConnection(): void {
	void dispatchControlCommand('stop');
}

async function scanAndConnect(): Promise<void> {
	if (isConnecting)
		return;

	const sessionId = nextConnectionSessionId();
	isConnecting = true;
	clearRetryTimer();
	try {
		if (retryCount >= MAX_RETRIES) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('Max retries reached'), ESYS_ToastMessageType.ERROR);
			return;
		}

		for (let port = PORT_START; port <= PORT_END; port++) {
			if (!isConnectionSessionActive(sessionId))
				return;
			const found = await tryConnectToPort(port, sessionId);
			if (!isConnectionSessionActive(sessionId))
				return;
			if (found) {
				currentPort = port;
				retryCount = 0;
				startHeartbeat(sessionId);
				return;
			}
		}

		retryCount += 1;
		console.warn(`[API-Gateway] No bridge server found on ports ${PORT_START}-${PORT_END}; retrying in ${RETRY_DELAY_MS} ms`);
		eda.sys_Message.showToastMessage(
			`${eda.sys_I18n.text('Bridge not found, retrying in ', undefined, undefined, String(RETRY_DELAY_MS / 1000))} (${retryCount}/${MAX_RETRIES})`,
		);
		scheduleRetry(sessionId);
	}
	finally {
		if (isConnectionSessionActive(sessionId))
			isConnecting = false;
	}
}

function tryConnectToPort(port: number, sessionId: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;

		const settle = (success: boolean) => {
			if (settled)
				return;
			settled = true;
			clearTimeout(timer);
			if (!success && isConnectionSessionActive(sessionId))
				closeWebSocket();
			resolve(success);
		};

		if (!isConnectionSessionActive(sessionId)) {
			resolve(false);
			return;
		}

		closeWebSocket();
		timer = setTimeout(() => settle(false), CONNECTION_TIMEOUT_MS);
		handshakeVerified = false;

		try {
			eda.sys_WebSocket.register(
				WS_ID,
				`ws://127.0.0.1:${port}/eda`,
				async (event: MessageEvent) => {
					if (!isConnectionSessionActive(sessionId)) {
						settle(false);
						return;
					}
					try {
						const msg = JSON.parse(String(event.data)) as BridgeMessage;
						if (msg.type === 'handshake') {
							if (msg.service !== SERVICE_ID) {
								console.warn(`[API-Gateway] Handshake failed: unexpected service "${String(msg.service)}"`);
								settle(false);
								return;
							}
							handshakeVerified = true;
							negotiatedProtocolVersion = negotiateProtocolVersion(msg.protocolVersions);
							bridgeSessionId = typeof msg.bridgeSessionId === 'string' ? msg.bridgeSessionId : null;
							windowId = crypto.randomUUID();
							setConnectionWindow(windowId);
							eda.sys_WebSocket.send(WS_ID, JSON.stringify({
								type: 'register',
								windowId,
								gatewayVersion: extensionConfig.version,
								generationId: getGenerationId(),
								clientVersion: eda.sys_Environment.getEditorCurrentVersion(),
								protocolVersions: [...PROTOCOL_VERSIONS],
								bridgeSessionId,
								capabilities: getRuntimeCapabilities(),
								timestamp: Date.now(),
							}));
							eda.sys_Message.showToastMessage(
								`${eda.sys_I18n.text('Bridge connected (port ', undefined, undefined, String(port))}) · Protocol v${negotiatedProtocolVersion}`,
							);
							settle(true);
							return;
						}

						if (!handshakeVerified)
							return;
						await handleMessage(msg);
					}
					catch (error) {
						console.error('[API-Gateway] Failed to handle message:', error instanceof Error ? error.message : String(error));
					}
				},
				() => {},
			);
		}
		catch (error) {
			console.error('[API-Gateway] Failed to register WebSocket:', error instanceof Error ? error.message : String(error));
			settle(false);
		}
	});
}

function startHeartbeat(sessionId: number): void {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => {
		if (!isConnectionSessionActive(sessionId)) {
			stopHeartbeat();
			return;
		}
		if (!handshakeVerified)
			return;
		try {
			heartbeatPending = true;
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({
				type: 'ping',
				id: `hb-${Date.now()}`,
				timestamp: Date.now(),
			}));
			setTimeout(() => {
				if (!isConnectionSessionActive(sessionId))
					return;
				if (heartbeatPending) {
					console.warn('[API-Gateway] Heartbeat timeout; reconnecting');
					cancelConnectionFlow();
					void scanAndConnect();
				}
			}, HEARTBEAT_TIMEOUT_MS);
		}
		catch {
			cancelConnectionFlow();
			void scanAndConnect();
		}
	}, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
	heartbeatPending = false;
}

function scheduleRetry(sessionId: number): void {
	clearRetryTimer();
	retryTimer = setTimeout(() => {
		if (!isConnectionSessionActive(sessionId) || isConnecting)
			return;
		void scanAndConnect();
	}, RETRY_DELAY_MS);
}

function clearRetryTimer(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

async function executeLegacyCode(code: string): Promise<unknown> {
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
	const fn = new AsyncFunction('eda', code);
	const result = await fn(eda);
	return result !== undefined ? result : null;
}

async function handleMessage(msg: BridgeMessage): Promise<void> {
	if (msg.type === 'ping') {
		sendBridgeMessage({ type: 'pong', id: typeof msg.id === 'string' ? msg.id : undefined, timestamp: Date.now() });
		return;
	}
	if (msg.type === 'pong') {
		heartbeatPending = false;
		return;
	}
	if (msg.type === 'execute' && typeof msg.code === 'string') {
		try {
			const code = msg.code;
			const result = await serializeEditorOperation(() => executeLegacyCode(code));
			sendBridgeMessage({ type: 'result', id: msg.id, result, timestamp: Date.now() });
		}
		catch (error) {
			sendBridgeMessage({
				type: 'error',
				id: msg.id,
				error: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			});
		}
		return;
	}
	if (msg.type === 'rpc-request') {
		const id = typeof msg.id === 'string' ? msg.id : 'unknown';
		const operation = typeof msg.operation === 'string' ? msg.operation : 'unknown';
		if (negotiatedProtocolVersion < 2) {
			sendBridgeMessage(toRpcError(
				new GatewayProtocolError('CLIENT_UNSUPPORTED', 'Bridge and Gateway did not negotiate Protocol v2'),
				id,
				operation,
			));
			return;
		}
		try {
			sendBridgeMessage(await serializeEditorOperation(() => executeTypedRequest(msg)));
		}
		catch (error) {
			sendBridgeMessage(toRpcError(error, id, operation));
		}
		return;
	}
	console.warn('[EDA] Unknown message type:', String(msg.type));
}
