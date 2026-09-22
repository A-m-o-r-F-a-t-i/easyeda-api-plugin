import type { GatewayEventMessage } from './protocol';
import { GatewayProtocolError } from './protocol';

const LISTENER_IDS = ['enhanced-api-gateway-v2-primitive-events', 'enhanced-api-gateway-v2-net-events'] as const;
const MAX_EVENTS = 512;

export interface CurrentIdentity {
	windowId: string | null;
	projectUuid: string | null;
	documentUuid: string | null;
	tabId: string | null;
	documentType: number | null;
}

interface DocumentState {
	generationId: string;
	changeEpoch: number;
	lastEventSequence: number;
	eventCoverage: 'partial' | 'unavailable';
}

let localWindowId: string | null = null;
let generationId = crypto.randomUUID();
let eventSequence = 0;
let epoch = 0;
let droppedThrough = 0;
let listenersRegistered = false;
let eventSender: ((message: GatewayEventMessage) => void) | null = null;
const journal: GatewayEventMessage[] = [];

export function getGenerationId(): string {
	return generationId;
}
export function getEventCoverage(): 'partial' | 'unavailable' {
	return listenersRegistered ? 'partial' : 'unavailable';
}

export function setConnectionWindow(windowId: string | null): void {
	localWindowId = windowId;
	generationId = crypto.randomUUID();
	eventSequence = 0;
	epoch = 0;
	droppedThrough = 0;
	journal.length = 0;
}

export function setEventSender(sender: ((message: GatewayEventMessage) => void) | null): void {
	eventSender = sender;
}

export function getDocumentState(_documentUuid: string | null): DocumentState {
	// The beta callback does not carry a document UUID. Conservatively invalidate
	// every document in this window instead of attributing a late event by focus.
	return { generationId, changeEpoch: epoch, lastEventSequence: eventSequence, eventCoverage: getEventCoverage() };
}

export function getEventsSince(sequence: number): Record<string, unknown> {
	if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > eventSequence)
		throw new GatewayProtocolError('INVALID_REQUEST', 'Event cursor is outside this generation');
	return { generationId, events: journal.filter(event => event.sequence > sequence), lastEventSequence: eventSequence, eventsTruncated: sequence < droppedThrough, oldestAvailableSequence: journal[0]?.sequence ?? null, eventCoverage: getEventCoverage() };
}

export function markSyntheticChange(documentUuid: string | null): DocumentState {
	publishEvent('document.syntheticChange', [], true, documentUuid);
	return getDocumentState(documentUuid);
}

export async function readCurrentIdentity(): Promise<CurrentIdentity> {
	const [project, document] = await Promise.all([
		eda.dmt_Project.getCurrentProjectInfo(),
		eda.dmt_SelectControl.getCurrentDocumentInfo(),
	]);
	return { windowId: localWindowId, projectUuid: project?.uuid ?? null, documentUuid: document?.uuid ?? null, tabId: document?.tabId ?? null, documentType: document?.documentType ?? null };
}

function normalizeEventItems(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value))
		return [];
	return value.slice(0, 2000).map((item) => {
		const normalized: Record<string, unknown> = {};
		if (typeof item !== 'object' || item === null)
			return normalized;
		const record = item as Record<string, unknown>;
		for (const key of ['primitiveId', 'primitiveType', 'net', 'designator', 'parentComponentPrimitiveId', 'parentComponentDesignator']) {
			const entry = record[key];
			if (typeof entry === 'string' || typeof entry === 'number')
				normalized[key] = entry;
		}
		return normalized;
	});
}

function publishEvent(eventType: string, items: unknown, incrementsEpoch: boolean, documentUuid: string | null = null): void {
	// Increment synchronously, before any asynchronous identity read could race.
	if (incrementsEpoch)
		epoch += 1;
	eventSequence += 1;
	if (!localWindowId)
		return;
	const message: GatewayEventMessage = {
		type: 'event',
		windowId: localWindowId,
		projectUuid: null,
		documentUuid,
		tabId: null,
		generationId,
		sequence: eventSequence,
		changeEpoch: epoch,
		eventType,
		requestId: null,
		items: normalizeEventItems(items),
		timestamp: Date.now(),
	};
	journal.push(message);
	while (journal.length > MAX_EVENTS) droppedThrough = journal.shift()?.sequence ?? droppedThrough;
	try {
		eventSender?.(message);
	}
	catch { /* Local journal remains authoritative when the socket is unavailable. */ }
}

export function registerPcbEventListeners(): void {
	if (listenersRegistered)
		return;
	try {
		for (const id of LISTENER_IDS) {
			if (eda.pcb_Event.isEventListenerAlreadyExist(id))
				eda.pcb_Event.removeEventListener(id);
		}
		eda.pcb_Event.addPrimitiveEventListener(LISTENER_IDS[0], 'all', (eventType, props) => {
			publishEvent(`primitive.${String(eventType)}`, props, true);
		}, false);
		eda.pcb_Event.addNetEventListener(LISTENER_IDS[1], 'all', (eventType, props) => {
			if (String(eventType) !== 'selected')
				publishEvent(`net.${String(eventType)}`, props, true);
		}, false);
		listenersRegistered = true;
	}
	catch (error) {
		unregisterPcbEventListeners();
		console.error('[API-Gateway] PCB event listeners unavailable:', error instanceof Error ? error.message : String(error));
	}
}

export function unregisterPcbEventListeners(): void {
	for (const id of LISTENER_IDS) {
		try {
			if (eda.pcb_Event.isEventListenerAlreadyExist(id))
				eda.pcb_Event.removeEventListener(id);
		}
		catch { /* Best-effort cleanup must attempt both listener IDs. */ }
	}
	listenersRegistered = false;
}
