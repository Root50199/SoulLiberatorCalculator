import assert from 'node:assert/strict'
import test from 'node:test'
import { resizedBounds, resizeEdges } from './window-resize.mjs'

const bounds = { x: 100, y: 200, width: 1000, height: 800 }
test('all resize edges retain the opposite edge', () => {
  for (const edge of resizeEdges) {
    const result = resizedBounds(bounds, edge, 50, 30)
    if (edge.includes('w')) assert.equal(result.x + result.width, 1100)
    else assert.equal(result.x, 100)
    if (edge.includes('n')) assert.equal(result.y + result.height, 1000)
    else assert.equal(result.y, 200)
  }
})
test('northwest respects minimum size without moving the opposite corner', () => {
  assert.deepEqual(resizedBounds(bounds, 'nw', 900, 900), { x: 400, y: 460, width: 700, height: 540 })
})
test('southeast expands and shrinks', () => {
  assert.deepEqual(resizedBounds(bounds, 'se', 80, 40), { ...bounds, width: 1080, height: 840 })
  assert.deepEqual(resizedBounds(bounds, 'se', -900, -900), { ...bounds, width: 700, height: 540 })
})
test('invalid requests are rejected', () => {
  assert.throws(() => resizedBounds(bounds, 'bad', 1, 1))
  assert.throws(() => resizedBounds(bounds, 'e', NaN, 1))
})
test('gate dragging moves both axes without resizing', () => {
  assert.deepEqual(resizedBounds(bounds, 'move', -45, 30), { ...bounds, x: 55, y: 230 })
})
test('held gate drag always uses the original dimensions', () => {
  for (let i = 0; i < 60; i++) {
    const result = resizedBounds(bounds, 'move', i * 2, -i)
    assert.equal(result.width, bounds.width)
    assert.equal(result.height, bounds.height)
  }
})
