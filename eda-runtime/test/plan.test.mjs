import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../plan.mjs';

const base = operation => ({
  schema: 'easyeda-pcb-plan/v2',
  intent: 'Validate mechanical circular keepout handling for solid fills',
  target: { documentUuid: 'pcb' },
  units: 'mm',
  phase: 'route',
  constraints: {
    allowedLayers: ['TOP', 'BOTTOM'],
    circularKeepouts: [{ name: 'MH1', center: [0, 0], diameter: 6 }],
  },
  operations: [operation],
});

test('fill.create rejects a polygon that intersects a circular keepout', () => {
  assert.throws(
    () => validatePlan(base({
      id: 'fill-create',
      type: 'fill.create',
      net: 'GND',
      layer: 'TOP',
      points: [[-4, -1], [4, -1], [4, 1], [-4, 1]],
    })),
    /Fill intersects mechanical circular keepout MH1/,
  );
});

test('fill.modify rejects a desired polygon that intersects a circular keepout', () => {
  assert.throws(
    () => validatePlan(base({
      id: 'fill-modify',
      type: 'fill.modify',
      primitiveId: 'fill-1',
      expected: {
        net: 'GND',
        layer: 1,
        fillMode: 0,
        lineWidth: 0.2,
        primitiveLock: false,
      },
      expectedPoints: [[5, -1], [7, -1], [7, 1], [5, 1]],
      points: [[-4, -1], [4, -1], [4, 1], [-4, 1]],
    })),
    /Fill intersects mechanical circular keepout MH1/,
  );
});

test('fill.create accepts a polygon outside the circular keepout', () => {
  const plan = validatePlan(base({
    id: 'fill-safe',
    type: 'fill.create',
    net: 'GND',
    layer: 'TOP',
    points: [[5, -1], [7, -1], [7, 1], [5, 1]],
  }));
  assert.equal(plan.operations.length, 1);
});

