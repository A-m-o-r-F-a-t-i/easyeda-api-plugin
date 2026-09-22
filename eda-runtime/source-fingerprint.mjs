// Canonicalize only the three export-generated DOCHEAD fields observed on 3.2.186.
// All document identity, editor version, unknown fields and body bytes remain covered.
export function normalizeDocumentSource(source) {
  if (typeof source !== 'string') throw new TypeError('Document source must be a string');
  const newline = source.indexOf('\n');
  const end = newline < 0 ? source.length : newline;
  const first = source.slice(0, end).replace(/\r$/, '');
  const divider = first.indexOf('||');
  const unchanged = { canonicalText: source, fingerprintKind: 'raw-source/v1', omittedFields: [] };
  if (divider < 0 || !first.endsWith('|')) return unchanged;
  let envelope, header;
  try { envelope = JSON.parse(first.slice(0, divider)); header = JSON.parse(first.slice(divider + 2, -1)); }
  catch { return unchanged; }
  if (!envelope || envelope.type !== 'DOCHEAD' || !header || Array.isArray(header) || header.docType !== 'PCB' || typeof header.uuid !== 'string') return unchanged;
  // A normal semantic version or unknown client marker is never silently excluded.
  if (!/^[0-9a-f]{16}$/i.test(header.client ?? '') || !Number.isSafeInteger(header.updateTime) || header.updateTime < 0 || header.version !== String(header.updateTime)) return unchanged;
  const { client, updateTime, version, ...retained } = header;
  const stable = Object.fromEntries(Object.entries(retained).sort(([a], [b]) => a.localeCompare(b)));
  const prefix = first.slice(0, divider) + '||' + JSON.stringify(stable) + '|';
  return { canonicalText: prefix + source.slice(end), fingerprintKind: 'easyeda-pcb-content/v1', omittedFields: ['DOCHEAD.client','DOCHEAD.updateTime','DOCHEAD.version'] };
}
