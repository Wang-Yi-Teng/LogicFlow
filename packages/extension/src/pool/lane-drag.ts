import LogicFlow, { BaseEdgeModel, BaseNodeModel } from '@logicflow/core'
import { filter } from 'lodash-es'
import { LaneModel } from './LaneModel'
import { PoolModel } from './PoolModel'

export type LaneSlotBounds = {
  laneId: string
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type LaneDragState = {
  laneId: string
  sourcePoolId: string
  targetPoolId?: string
  insertIndex?: number
  previousAxis: number
  originalRaisedElementZIndices: Record<string, number>
  originalTextPositions: Record<string, { x: number; y: number }>
  // 在预览布局改变泳道位置前记录槽位边界，命中判断不能依赖预览后的坐标。
  slotBoundsByPool: Record<string, LaneSlotBounds[]>
}

const LANE_RETURN_ANIMATION_DURATION = 160
const LANE_DRAG_CURSOR_CLASSES = [
  'lf-pool-lane-drag-not-allowed',
  'lf-pool-lane-drag-allowed',
]

export type PoolLaneDragContext = {
  lf: LogicFlow
  getLaneDragState(): LaneDragState | undefined
  setLaneDragState(state?: LaneDragState): void
  resolvePoolById(poolId?: unknown): PoolModel | undefined
  getPoolByPoint(
    point: { x: number; y: number },
    nodeData: LogicFlow.NodeData | LogicFlow.NodeConfig,
  ): PoolModel | undefined
  getPoolByBounds(
    bounds: any,
    nodeData: LogicFlow.NodeData | LogicFlow.NodeConfig,
  ): PoolModel | undefined
  moveLaneToPool(
    laneId: string,
    targetPoolId: string,
    insertIndex: number,
  ): boolean
  emitLaneMoveNotAllowed(lane: LaneModel, reason: string): void
  getLaneBlockPreviewOrder(
    pool: PoolModel,
    lanes: LaneModel[],
    insertIndex: number,
  ): string[]
  setLaneBlockDropIndicator(
    pool: PoolModel,
    lanes: LaneModel[],
    insertIndex: number,
  ): void
  previewLaneBlockOrder(
    pool: PoolModel,
    lanes: LaneModel[],
    insertIndex: number,
  ): void
}

export function captureLaneSlotBounds(pool: PoolModel): LaneSlotBounds[] {
  // 保留原始几何信息，避免预览动画改变槽位的命中区域。
  return pool.getOrderedLanes().map((lane: LaneModel) => {
    const { minX, minY, maxX, maxY } = lane.getBounds()
    return { laneId: lane.id, minX, minY, maxX, maxY }
  })
}

export function getLaneSlotBounds(
  context: PoolLaneDragContext,
  pool: PoolModel,
): LaneSlotBounds[] {
  const state = context.getLaneDragState()
  if (!state) return captureLaneSlotBounds(pool)
  if (!state.slotBoundsByPool[pool.id]) {
    state.slotBoundsByPool[pool.id] = captureLaneSlotBounds(pool)
  }
  return state.slotBoundsByPool[pool.id]
}

export function getLaneDragMembers(
  context: PoolLaneDragContext,
  lane: LaneModel,
): BaseNodeModel[] {
  // 拖拽泳道时，泳道和其直接子节点需要作为一个可视整体处理。
  return ([lane] as BaseNodeModel[]).concat(
    Array.from(lane.children)
      .map((childId) => context.lf.getNodeModelById(childId))
      .filter(Boolean) as BaseNodeModel[],
  )
}

export function getLaneRelatedEdges(
  context: PoolLaneDragContext,
  lane: LaneModel,
): BaseEdgeModel[] {
  const childIds = new Set(lane.children)
  return filter(context.lf.graphModel.edges, (edge) => {
    return childIds.has(edge.sourceNodeId) || childIds.has(edge.targetNodeId)
  })
}

export function raiseLaneRelatedElements(
  context: PoolLaneDragContext,
  lane: LaneModel,
) {
  const topZIndex = Math.max(
    ...[...context.lf.graphModel.nodes, ...context.lf.graphModel.edges].map(
      (element) => element.zIndex,
    ),
  )

  // 泳道是子节点的背景。关联边置于背景之上，子节点再高一层，避免两者被背景遮挡。
  lane.setZIndex(topZIndex + 1)
  getLaneRelatedEdges(context, lane).forEach((edge) =>
    edge.setZIndex(topZIndex + 2),
  )
  getLaneDragMembers(context, lane)
    .slice(1)
    .forEach((member) => member.setZIndex(topZIndex + 3))
}

export function syncLaneChildZIndex(
  context: PoolLaneDragContext,
  lane: LaneModel,
  childId: string,
) {
  const child = context.lf.getNodeModelById(childId)
  if (!child) return

  const relatedEdges = getLaneRelatedEdges(context, lane)
  const edgeZIndex = Math.max(
    lane.zIndex + 1,
    ...relatedEdges.map((edge) => edge.zIndex),
  )
  relatedEdges.forEach((edge) => {
    if (edge.zIndex < edgeZIndex) {
      edge.setZIndex(edgeZIndex)
    }
  })
  const siblingChildLayer = getLaneDragMembers(context, lane)
    .slice(1)
    .filter((member) => member.id !== childId)
    .map((member) => member.zIndex)
  const targetZIndex = Math.max(
    edgeZIndex + 1,
    child.zIndex,
    ...siblingChildLayer,
  )

  if (child.zIndex < targetZIndex) {
    child.setZIndex(targetZIndex)
  }
}

export function createLaneDragState(
  context: PoolLaneDragContext,
  lane: LaneModel,
  sourcePool: PoolModel,
  previousAxis: number,
) {
  const existingState = context.getLaneDragState()
  if (existingState) return existingState

  const members = getLaneDragMembers(context, lane)
  const relatedEdges = getLaneRelatedEdges(context, lane)
  const raisedElements: Array<BaseNodeModel | BaseEdgeModel> = [
    ...members,
    ...relatedEdges,
  ]
  const originalRaisedElementZIndices = raisedElements.reduce(
    (indices: Record<string, number>, element) => {
      indices[element.id] = element.zIndex
      return indices
    },
    {},
  )
  const originalTextPositions = raisedElements.reduce(
    (positions: Record<string, { x: number; y: number }>, element) => {
      positions[element.id] = { x: element.text.x, y: element.text.y }
      return positions
    },
    {},
  )

  const state: LaneDragState = {
    laneId: lane.id,
    sourcePoolId: sourcePool.id,
    previousAxis,
    originalRaisedElementZIndices,
    originalTextPositions,
    slotBoundsByPool: {
      [sourcePool.id]: captureLaneSlotBounds(sourcePool),
    },
  }
  context.setLaneDragState(state)
  raiseLaneRelatedElements(context, lane)
  return state
}

export function restoreLaneTextPositions(
  context: PoolLaneDragContext,
  state: LaneDragState,
) {
  Object.entries(state.originalTextPositions).forEach(([id, position]) => {
    const element =
      context.lf.getNodeModelById(id) ?? context.lf.getEdgeModelById(id)
    if (!element) return
    element.moveText(position.x - element.text.x, position.y - element.text.y)
  })
}

export function setLaneDragCursor(
  context: PoolLaneDragContext,
  cursor?: 'not-allowed' | 'allowed',
) {
  context.lf.container.classList.remove(...LANE_DRAG_CURSOR_CLASSES)
  if (cursor) {
    context.lf.container.classList.add(`lf-pool-lane-drag-${cursor}`)
  }
}

export function clearLaneDropTarget(pool?: PoolModel) {
  if (!pool) return
  pool.isLaneDropTarget = false
  pool.laneDropIndicator = undefined
  pool.setAllowAppendChild(false)
}

export function canDropLaneIntoPool(
  sourcePool: PoolModel,
  targetPool: PoolModel,
) {
  return targetPool.id === sourcePool.id || sourcePool.canRemoveLane(1)
}

export function getLanePointerInsertIndex(
  context: PoolLaneDragContext,
  pool: PoolModel,
  lane: LaneModel,
  point: { x: number; y: number },
  previousAxis: number,
  slotBounds: LaneSlotBounds[],
): number {
  const lanes = pool.getOrderedLanes() as LaneModel[]
  const axis = pool.isHorizontal ? point.y : point.x
  const target = slotBounds.find((slot) => {
    if (slot.laneId === lane.id) return false
    return (
      point.x >= slot.minX &&
      point.x <= slot.maxX &&
      point.y >= slot.minY &&
      point.y <= slot.maxY
    )
  })

  if (target) {
    const targetIndex = lanes.findIndex(
      (candidate) => candidate.id === target.laneId,
    )

    const sourcePoolId = context.getLaneDragState()?.sourcePoolId
    if (sourcePoolId === pool.id) {
      // 同一泳池内以前的槽位顺序决定前后关系，指针在目标槽位内轻微移动不能反转预览顺序。
      const sourceIndex = slotBounds.findIndex(
        (slot) => slot.laneId === lane.id,
      )
      const targetSlotIndex = slotBounds.findIndex(
        (slot) => slot.laneId === target.laneId,
      )
      return sourceIndex < targetSlotIndex ? targetIndex + 1 : targetIndex
    }

    return axis >= previousAxis ? targetIndex + 1 : targetIndex
  }

  const bounds = pool.getBounds()
  const minAxis = pool.isHorizontal ? bounds.minY : bounds.minX
  const maxAxis = pool.isHorizontal ? bounds.maxY : bounds.maxX
  if (axis <= minAxis) return 0
  if (axis >= maxAxis) return lanes.length
  return lanes.findIndex((candidate) => candidate.id === lane.id)
}

export function getLanePreviewOrder(
  context: PoolLaneDragContext,
  pool: PoolModel,
  laneId: string,
  insertIndex: number,
): string[] {
  const lane = context.lf.getNodeModelById(laneId) as LaneModel
  return lane ? context.getLaneBlockPreviewOrder(pool, [lane], insertIndex) : []
}

export function setLaneDropIndicator(
  context: PoolLaneDragContext,
  pool: PoolModel,
  laneId: string,
  insertIndex: number,
) {
  const lane = context.lf.getNodeModelById(laneId) as LaneModel
  if (!lane) return
  context.setLaneBlockDropIndicator(pool, [lane], insertIndex)
}

export function previewLaneOrder(
  context: PoolLaneDragContext,
  pool: PoolModel,
  laneId: string,
  insertIndex: number,
) {
  const lane = context.lf.getNodeModelById(laneId) as LaneModel
  if (!lane) return
  // 预览与最终布局必须从同一个内容区起算，不能继续假设标题永远在左/上。
  context.previewLaneBlockOrder(pool, [lane], insertIndex)
}

export function updateLaneDragPreview(
  context: PoolLaneDragContext,
  laneId: string,
  point: { x: number; y: number },
) {
  const lane = context.lf.getNodeModelById(laneId) as LaneModel
  if (!lane || String(lane.type) !== 'lane') return

  const sourcePool = context.resolvePoolById(lane.properties?.parent)
  if (!sourcePool) return

  const axis = sourcePool.isHorizontal ? point.y : point.x
  const current = createLaneDragState(context, lane, sourcePool, axis)
  const targetPool = context.getPoolByPoint(point, lane.getData())
  if (current?.targetPoolId && current.targetPoolId !== targetPool?.id) {
    const previousPool = context.resolvePoolById(current.targetPoolId)
    clearLaneDropTarget(previousPool)
  }

  if (!targetPool || !canDropLaneIntoPool(sourcePool, targetPool)) {
    // 离开合法目标后不能继续使用上一次的目标，否则 drop 会误判为有效放置。
    current.targetPoolId = undefined
    current.insertIndex = undefined
    setLaneDragCursor(context, 'not-allowed')
    return
  }

  setLaneDragCursor(
    context,
    targetPool.id === sourcePool.id ? undefined : 'allowed',
  )
  targetPool.isLaneDropTarget = targetPool.id !== sourcePool.id
  targetPool.setAllowAppendChild(targetPool.isLaneDropTarget)

  const previousAxis =
    context.getLaneDragState()!.previousAxis ??
    (sourcePool.isHorizontal ? lane.y : lane.x)
  const insertIndex = getLanePointerInsertIndex(
    context,
    targetPool,
    lane,
    point,
    previousAxis,
    getLaneSlotBounds(context, targetPool),
  )

  const state = context.getLaneDragState()!
  state.targetPoolId = targetPool.id
  state.insertIndex = insertIndex
  state.previousAxis = axis
  setLaneDropIndicator(context, targetPool, laneId, insertIndex)
  if (targetPool.id === sourcePool.id) {
    previewLaneOrder(context, targetPool, laneId, insertIndex)
  }
}

export function clearLaneDragPreview(context: PoolLaneDragContext) {
  const state = context.getLaneDragState()
  if (!state) return

  // 拖拽结束或取消后，恢复拖拽开始前记录的层级。
  Object.entries(state.originalRaisedElementZIndices).forEach(
    ([id, zIndex]) => {
      const element =
        context.lf.getNodeModelById(id) ?? context.lf.getEdgeModelById(id)
      element?.setZIndex(zIndex)
    },
  )

  const pools = [state.sourcePoolId, state.targetPoolId]
  pools.forEach((poolId) => {
    if (!poolId) return
    const pool = context.resolvePoolById(poolId)
    if (!pool) return
    clearLaneDropTarget(pool)
    pool.getOrderedLanes().forEach((item: LaneModel) => {
      item.isLaneReordering = false
    })
  })
  context.setLaneDragState(undefined)
}

export function returnLaneToSourcePool(
  context: PoolLaneDragContext,
  lane: LaneModel,
  sourcePool: PoolModel,
  state?: LaneDragState,
) {
  // 先渲染归位样式，再在下一帧回到固定槽位，避免无效放置时出现同步跳变。
  lane.isLaneReturning = true
  const layout = () => {
    sourcePool.layoutLanesByOrder({ reason: 'reorder' })
    if (state) restoreLaneTextPositions(context, state)
    setTimeout(() => {
      lane.isLaneReturning = false
    }, LANE_RETURN_ANIMATION_DURATION)
  }

  if (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function'
  ) {
    window.requestAnimationFrame(layout)
    return
  }
  setTimeout(layout, 0)
}

export function finalizeLaneDrop(
  context: PoolLaneDragContext,
  node?: LogicFlow.NodeData,
): boolean {
  if (!node || String(node.type) !== 'lane') return false

  const lane = context.lf.getNodeModelById(node.id) as LaneModel
  if (!lane || String(lane.type) !== 'lane') return false

  const sourcePool = context.resolvePoolById(lane.properties?.parent)
  if (!sourcePool) return false

  const state = context.getLaneDragState()
  const targetPool =
    context.resolvePoolById(state?.targetPoolId) ??
    context.getPoolByBounds(lane.getBounds(), lane.getData()) ??
    context.getPoolByPoint({ x: lane.x, y: lane.y }, lane.getData())
  if (!targetPool) {
    returnLaneToSourcePool(context, lane, sourcePool, state)
    context.emitLaneMoveNotAllowed(lane, 'invalid-target-pool')
    return false
  }

  const insertIndex =
    state?.laneId === lane.id && typeof state.insertIndex === 'number'
      ? state.insertIndex
      : targetPool.getLaneInsertIndex({ x: lane.x, y: lane.y })
  if (targetPool.id === sourcePool.id) {
    const reordered = sourcePool.reorderLane(lane.id, insertIndex)
    if (!reordered) sourcePool.layoutLanesByOrder({ reason: 'reorder' })
    return true
  }

  const moved = context.moveLaneToPool(lane.id, targetPool.id, insertIndex)
  if (!moved) sourcePool.layoutLanesByOrder({ reason: 'reorder' })
  return moved
}
