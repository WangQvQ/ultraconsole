import type { PredBBox, RoiPoint } from '../store/useConsoleStore'

export function pointInPolygon(p: RoiPoint, poly: RoiPoint[]) {
  // ray casting
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    // yi > p.y !== yj > p.y 已经排除了 yi == yj 的水平边情况，分母不会为 0
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export function filterBBoxesByRoiNormalized(args: { bboxes: PredBBox[]; roiPoly: RoiPoint[]; width: number; height: number }) {
  const { bboxes, roiPoly, width, height } = args
  if (roiPoly.length < 3 || width <= 0 || height <= 0) return bboxes
  return bboxes.filter((b) => {
    const cx = ((b.x1 + b.x2) / 2) / width
    const cy = ((b.y1 + b.y2) / 2) / height
    return pointInPolygon({ x: cx, y: cy }, roiPoly)
  })
}

