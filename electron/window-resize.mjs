export const resizeEdges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

export function outsidePanel(bounds, point) {
  return point.x < bounds.x + bounds.width * .1 - 3 ||
    point.x > bounds.x + bounds.width * .9 + 3 ||
    point.y < bounds.y + bounds.height * .12 - 4 ||
    point.y >= bounds.y + bounds.height
}

export function resizedBounds(bounds, edge, dx, dy) {
  if ((!resizeEdges.includes(edge) && edge !== 'move') || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new Error('Invalid window resize.')
  }
  let { x, y, width, height } = bounds
  if (edge === 'move') {
    return { x: Math.round(x + dx), y: Math.round(y + dy), width, height }
  }
  if (edge.includes('e')) width = Math.max(700, width + dx)
  if (edge.includes('s')) height = Math.max(540, height + dy)
  if (edge.includes('w')) {
    width = Math.max(700, width - dx)
    x += bounds.width - width
  }
  if (edge.includes('n')) {
    height = Math.max(540, height - dy)
    y += bounds.height - height
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}
