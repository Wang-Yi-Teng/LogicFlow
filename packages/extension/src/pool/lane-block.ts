import LogicFlow from '@logicflow/core'
import { LaneModel } from './LaneModel'
import type { LaneChildRelativePositions } from './LaneModel'
import { PoolModel } from './PoolModel'

export type LaneSnapshot = {
  x: number
  y: number
  children: LaneChildRelativePositions
}

export type PoolLaneBlockContext = {
  lf: LogicFlow
  resolvePoolById(poolId?: unknown): PoolModel | undefined
  getPoolContentBox(pool: PoolModel): {
    x: number
    y: number
    width: number
    height: number
  }
}

export function getLaneModelsByIds(
  context: PoolLaneBlockContext,
  laneIds: string[],
): LaneModel[] {
  return laneIds
    .map((laneId) => context.lf.getNodeModelById(laneId))
    .filter((node): node is LaneModel => String(node?.type) === 'lane')
}

export function getSourcePoolsByIds(
  context: PoolLaneBlockContext,
  poolIds: string[],
): PoolModel[] {
  return poolIds
    .map((poolId) => context.resolvePoolById(poolId))
    .filter((pool): pool is PoolModel => !!pool)
}

export function groupLanesBySourcePool(
  context: PoolLaneBlockContext,
  lanes: LaneModel[],
) {
  const lanesBySourcePool = new Map<string, LaneModel[]>()
  lanes.forEach((lane) => {
    const poolId = context.resolvePoolById(lane.properties?.parent)?.id
    if (!poolId) return
    const items = lanesBySourcePool.get(poolId) ?? []
    items.push(lane)
    lanesBySourcePool.set(poolId, items)
  })
  return lanesBySourcePool
}

export function canMoveLaneBlock(
  sourcePools: PoolModel[],
  lanesBySourcePool: Map<string, LaneModel[]>,
  targetPool: PoolModel,
) {
  return sourcePools.every((sourcePool) => {
    const selected = lanesBySourcePool.get(sourcePool.id) ?? []
    return (
      sourcePool.id === targetPool.id ||
      sourcePool.canRemoveLane(selected.length)
    )
  })
}

export function getLaneBlockPreviewOrder(
  pool: PoolModel,
  lanes: LaneModel[],
  insertIndex: number,
): string[] {
  const selectedIds = new Set(lanes.map((lane) => lane.id))
  const ids = pool.getOrderedLanes().map((lane: LaneModel) => lane.id)
  const blockIds = ids.filter((id) => selectedIds.has(id))
  if (blockIds.length === 0) {
    // 跨泳池预览时，目标池不含选中 lane，直接保留选中块的既有顺序。
    blockIds.push(...lanes.map((lane) => lane.id))
  }
  const remainingIds = ids.filter((id) => !selectedIds.has(id))
  const selectedBeforeInsert = ids
    .slice(0, insertIndex)
    .filter((id) => selectedIds.has(id)).length
  // insertIndex 基于完整槽位，先扣除块自身占用的前置槽位再插入剩余列表。
  const adjustedIndex = Math.max(0, insertIndex - selectedBeforeInsert)
  remainingIds.splice(
    Math.min(adjustedIndex, remainingIds.length),
    0,
    ...blockIds,
  )
  return remainingIds
}

export function previewLaneBlockOrder(
  context: PoolLaneBlockContext,
  pool: PoolModel,
  lanes: LaneModel[],
  insertIndex: number,
) {
  const selectedIds = new Set(lanes.map((lane) => lane.id))
  const order = getLaneBlockPreviewOrder(pool, lanes, insertIndex)
  const previewLanes = order.map(
    (laneId) => context.lf.getNodeModelById(laneId) as LaneModel,
  )
  const contentBox = context.getPoolContentBox(pool)
  // 预览位置必须与正式布局使用同一个 contentBox，否则标题移动到右/下时会错位。
  let cursor = pool.isHorizontal
    ? contentBox.y - contentBox.height / 2
    : contentBox.x - contentBox.width / 2

  order.forEach((laneId, index) => {
    const lane = context.lf.getNodeModelById(laneId) as LaneModel
    if (!lane) return
    const size = pool.isHorizontal ? lane.height : lane.width
    cursor += pool.getCollapsedLaneGapBefore(index, previewLanes)
    if (!selectedIds.has(laneId)) {
      lane.isLaneReordering = true
      pool.moveLane(
        lane,
        pool.isHorizontal ? contentBox.x : cursor + lane.width / 2,
        pool.isHorizontal ? cursor + lane.height / 2 : contentBox.y,
      )
    }
    cursor += size
  })
}

export function setLaneBlockDropIndicator(
  context: PoolLaneBlockContext,
  pool: PoolModel,
  lanes: LaneModel[],
  insertIndex: number,
) {
  if (lanes.length === 0) return

  const order = getLaneBlockPreviewOrder(pool, lanes, insertIndex)
  const firstLaneId = lanes[0].id
  const firstLaneIndex = order.indexOf(firstLaneId)
  const contentBox = context.getPoolContentBox(pool)
  const previewLanes = order.map(
    (laneId) => context.lf.getNodeModelById(laneId) as LaneModel,
  )
  const beforeSize = pool.getLaneAxisOffset(firstLaneIndex, previewLanes)
  // 选中的 Lane 在预览顺序中连续排列，因此该区间就是整个块的占位尺寸。
  const blockSize =
    pool.getLaneAxisOffset(firstLaneIndex + lanes.length, previewLanes) -
    beforeSize
  pool.laneDropIndicator = {
    laneId: firstLaneId,
    index: insertIndex,
    ...(pool.isHorizontal
      ? {
          x: contentBox.x - contentBox.width / 2,
          y: contentBox.y - contentBox.height / 2 + beforeSize,
          width: contentBox.width,
          height: blockSize,
        }
      : {
          x: contentBox.x - contentBox.width / 2 + beforeSize,
          y: contentBox.y - contentBox.height / 2,
          width: blockSize,
          height: contentBox.height,
        }),
  }
}

export function getSelectionLaneBlock(
  lanes: LaneModel[],
  sourcePool: PoolModel,
): LaneModel[] {
  const laneIds = new Set(lanes.map((lane) => lane.id))
  return sourcePool
    .getOrderedLanes()
    .filter((lane: LaneModel) => laneIds.has(lane.id)) as LaneModel[]
}

export function reorderLaneBlock(
  pool: PoolModel,
  lanes: LaneModel[],
  insertIndex: number,
) {
  const laneIds = new Set(lanes.map((lane) => lane.id))
  const orderedIds = pool.getOrderedLanes().map((lane: LaneModel) => lane.id)
  const blockIds = orderedIds.filter((id: string) => laneIds.has(id))
  const idsBeforeTarget = orderedIds.slice(0, insertIndex)
  const adjustedIndex = Math.max(
    0,
    insertIndex - idsBeforeTarget.filter((id) => laneIds.has(id)).length,
  )
  const remainingIds = orderedIds.filter((id: string) => !laneIds.has(id))
  remainingIds.splice(
    Math.min(adjustedIndex, remainingIds.length),
    0,
    ...blockIds,
  )

  pool.setLaneOrder(remainingIds, { reason: 'reorder' })
}

export function getSelectionLaneVisualOrder(
  lanes: LaneModel[],
  targetPool: PoolModel,
  laneSnapshots: Record<string, LaneSnapshot>,
) {
  return lanes.slice().sort((left, right) => {
    const leftSnapshot = laneSnapshots[left.id] ?? left
    const rightSnapshot = laneSnapshots[right.id] ?? right
    const primaryDelta = targetPool.isHorizontal
      ? leftSnapshot.y - rightSnapshot.y
      : leftSnapshot.x - rightSnapshot.x
    if (primaryDelta !== 0) return primaryDelta

    return targetPool.isHorizontal
      ? leftSnapshot.x - rightSnapshot.x
      : leftSnapshot.y - rightSnapshot.y
  })
}

export function restoreLaneBlockChildPositions(
  lanes: LaneModel[],
  laneSnapshots: Record<string, LaneSnapshot>,
) {
  lanes.forEach((lane) => {
    const snapshot = laneSnapshots[lane.id]
    if (!snapshot) return
    lane.restoreChildrenRelativePositions(snapshot.children)
  })
}
