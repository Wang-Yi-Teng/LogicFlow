import LogicFlow, {
  BaseEdgeModel,
  BaseNodeModel,
  EventType,
  createUuid,
  transformEdgeData,
  transformNodeData,
} from '@logicflow/core'
import { cloneDeep, filter, forEach, has, map } from 'lodash-es'
import { LaneModel, mapLaneChildRelativePositions } from './LaneModel'
import type { LaneChildRelativePositions } from './LaneModel'
import { PoolModel } from './PoolModel'
import { poolConfig } from './constant'

import GraphConfigData = LogicFlow.GraphConfigData
import GraphElements = LogicFlow.GraphElements
import EdgeConfig = LogicFlow.EdgeConfig
import EdgeData = LogicFlow.EdgeData

type ElementsInfoInGroup = {
  childNodes: BaseNodeModel[]
  edgesData: EdgeData[]
}

type PasteContext = {
  nodeIdMap: Record<string, string>
  elements: GraphElements
  edgesInnerGroup: EdgeData[]
  blankPasteTargetPool?: PoolModel
  copiedLaneChildOffsets: Record<string, LaneChildRelativePositions>
  copiedLanes: LaneModel[]
}

export type PoolPasteContext = {
  lf: LogicFlow
  nodeLaneMap: Map<string, string>
  resolvePoolById(poolId?: unknown): PoolModel | undefined
  getAncestorContainersByNodeId(nodeId: string): Array<PoolModel | LaneModel>
  getRootContainerNodes(nodes: BaseNodeModel[]): BaseNodeModel[]
}

function removeChildrenInGroupNodeData<
  T extends LogicFlow.NodeData | LogicFlow.NodeConfig,
>(nodeData: T) {
  const newNodeData = cloneDeep(nodeData)
  delete newNodeData.children
  if (newNodeData.properties?.children) {
    delete newNodeData.properties.children
  }
  return newNodeData
}

function resolveNodePool(
  pasteContext: PoolPasteContext,
  nodeId: string,
): PoolModel | undefined {
  const node = pasteContext.lf.getNodeModelById(nodeId) as
    | PoolModel
    | LaneModel
    | undefined
  if (String(node?.type) === 'pool') return node as PoolModel

  return pasteContext
    .getAncestorContainersByNodeId(nodeId)
    .find((ancestor) => String(ancestor.type) === 'pool') as
    | PoolModel
    | undefined
}

function resolvePasteTargetPool(
  pasteContext: PoolPasteContext,
): PoolModel | undefined {
  const { nodes } = pasteContext.lf.graphModel.getSelectElements()
  const poolIds = new Set<string>()

  nodes.forEach((node) => {
    const pool = resolveNodePool(pasteContext, node.id)
    if (pool) poolIds.add(pool.id)
  })

  if (poolIds.size !== 1) return undefined
  return pasteContext.lf.getNodeModelById(Array.from(poolIds)[0]) as
    | PoolModel
    | undefined
}

function createPasteTargetPool(
  pasteContext: PoolPasteContext,
  node: LogicFlow.NodeData | LogicFlow.NodeConfig,
  laneId: string,
  laneWidth: number,
  laneHeight: number,
  distance: number,
): PoolModel {
  const sourcePool = pasteContext.resolvePoolById(node.properties?.parent)
  const direction =
    sourcePool?.properties?.direction ??
    node.properties?.direction ??
    'horizontal'
  const titlePosition =
    sourcePool?.properties?.titlePosition ??
    (direction === 'vertical' ? 'top' : 'left')
  const titleOnSide = titlePosition === 'left' || titlePosition === 'right'
  const titleOnTopOrBottom =
    titlePosition === 'top' || titlePosition === 'bottom'
  const width = laneWidth + (titleOnSide ? poolConfig.titleSize : 0)
  const height = laneHeight + (titleOnTopOrBottom ? poolConfig.titleSize : 0)
  let x = Number(node.x ?? 0) + distance
  let y = Number(node.y ?? 0) + distance

  if (titlePosition === 'left') x -= poolConfig.titleSize / 2
  if (titlePosition === 'right') x += poolConfig.titleSize / 2
  if (titlePosition === 'top') y -= poolConfig.titleSize / 2
  if (titlePosition === 'bottom') y += poolConfig.titleSize / 2

  return pasteContext.lf.addNode({
    type: 'pool',
    x,
    y,
    text: sourcePool?.text?.value ?? '新泳池',
    children: [laneId],
    properties: {
      direction,
      titlePosition,
      laneConfig: sourcePool?.properties?.laneConfig,
      width,
      height,
      children: [laneId],
    },
    zIndex: sourcePool?.zIndex,
  }) as PoolModel
}

function initGroupChildNodes(
  pasteContext: PoolPasteContext,
  nodeIdMap: Record<string, string>,
  children: Set<string>,
  curGroup: LaneModel,
  distance: number,
): ElementsInfoInGroup {
  const allChildNodes: BaseNodeModel[] = []
  const edgesDataArr: EdgeData[] = []
  const allRelatedEdges: BaseEdgeModel[] = []

  forEach(Array.from(children), (childId: string) => {
    const childNode = pasteContext.lf.getNodeModelById(childId)
    if (childNode) {
      const childNodeChildren = childNode.children
      const childNodeData = childNode.getData()
      const eventType = EventType.NODE_GROUP_COPY || 'node:group-copy-add'

      const newNodeConfig = transformNodeData(
        removeChildrenInGroupNodeData(childNodeData),
        distance,
      )
      const tempChildNode = pasteContext.lf.addNode(newNodeConfig, eventType)
      curGroup.addChild(tempChildNode.id)
      tempChildNode.setProperties({
        ...tempChildNode.properties,
        parent: curGroup.id,
      })

      nodeIdMap[childId] = tempChildNode.id
      allChildNodes.push(tempChildNode)

      // 内部边要从原始子节点收集，再通过 nodeIdMap 重建到复制出来的子节点。
      allRelatedEdges.push(
        ...[...childNode.incoming.edges, ...childNode.outgoing.edges],
      )

      if (childNodeChildren instanceof Set) {
        const { childNodes, edgesData } = initGroupChildNodes(
          pasteContext,
          nodeIdMap,
          childNodeChildren,
          tempChildNode as LaneModel,
          distance,
        )

        allChildNodes.push(...childNodes)
        edgesDataArr.push(...edgesData)
      }
    }
  })

  const edgesInnerGroup = filter(allRelatedEdges, (edge, index) => {
    return (
      allRelatedEdges.findIndex((item) => item.id === edge.id) === index &&
      has(nodeIdMap, edge.sourceNodeId) &&
      has(nodeIdMap, edge.targetNodeId)
    )
  })
  const edgesDataInnerGroup = map(edgesInnerGroup, (edge) => {
    return edge.getData()
  })
  curGroup.setProperties({
    ...curGroup.properties,
    children: Array.from(curGroup.children),
  })

  return {
    childNodes: allChildNodes,
    edgesData: edgesDataArr.concat(edgesDataInnerGroup),
  }
}

function createEdge(
  pasteContext: PoolPasteContext,
  edge: EdgeConfig | EdgeData,
  nodeIdMap: Record<string, string>,
  distance: number,
) {
  const { sourceNodeId, targetNodeId } = edge
  const sourceId = nodeIdMap[sourceNodeId] ?? sourceNodeId
  const targetId = nodeIdMap[targetNodeId] ?? targetNodeId
  const isCopiedInternalEdge =
    has(nodeIdMap, sourceNodeId) && has(nodeIdMap, targetNodeId)

  // 复制出来的内部边会连接到重新布局后的子节点，旧路径点不能再平移复用。
  let newEdgeConfig = cloneDeep(edge)
  if (isCopiedInternalEdge) {
    const edgeConfig = newEdgeConfig as any
    const { text } = edgeConfig
    delete edgeConfig.startPoint
    delete edgeConfig.endPoint
    delete edgeConfig.pointsList
    delete edgeConfig.points
    delete edgeConfig.sourceAnchorId
    delete edgeConfig.targetAnchorId
    newEdgeConfig = {
      ...edgeConfig,
      id: '',
      text:
        typeof text === 'object' && text !== null
          ? {
              value: text.value,
              draggable: text.draggable,
              editable: text.editable,
            }
          : text,
    }
  } else if (edge.id && typeof edge.text === 'object' && edge.text !== null) {
    newEdgeConfig = transformEdgeData(edge as EdgeData, distance)
  }

  const edgeModel = pasteContext.lf.graphModel.addEdge({
    ...newEdgeConfig,
    sourceNodeId: sourceId,
    targetNodeId: targetId,
  })
  if (isCopiedInternalEdge) {
    edgeModel.resetTextPosition()
  }
  return edgeModel
}

function pasteLaneNode(
  pasteContext: PoolPasteContext,
  node: LogicFlow.NodeData | LogicFlow.NodeConfig,
  children: Set<string>,
  distance: number,
  context: PasteContext,
) {
  const { nodeIdMap, elements, edgesInnerGroup } = context
  const originId = node.id
  const sourceLane = originId
    ? (pasteContext.lf.getNodeModelById(originId) as LaneModel)
    : undefined
  const sourceChildOffsets =
    sourceLane?.captureChildrenRelativePositions() ?? {}
  const laneWidth = sourceLane?.expandWidth ?? (node as any).width
  const laneHeight = sourceLane?.expandHeight ?? (node as any).height
  const selectedTargetPool = resolvePasteTargetPool(pasteContext)
  const generatedLaneId = selectedTargetPool ? undefined : createUuid()
  const targetPool =
    selectedTargetPool ??
    context.blankPasteTargetPool ??
    createPasteTargetPool(
      pasteContext,
      node,
      generatedLaneId!,
      laneWidth,
      laneHeight,
      distance,
    )
  context.blankPasteTargetPool = selectedTargetPool
    ? context.blankPasteTargetPool
    : targetPool

  // 多个 lane 按剪贴板顺序连续追加到当前目标泳池。
  const insertIndex = targetPool.getOrderedLanes().length
  const laneProperties: Record<string, unknown> = {
    ...node.properties,
    parent: targetPool.id,
    direction: targetPool.properties?.direction,
    isHorizontal: targetPool.isHorizontal,
    isCollapsed: false,
  }
  // 副本不继承折叠态的运行时尺寸，使用源泳道记录的展开尺寸。
  delete laneProperties.width
  delete laneProperties.height
  delete laneProperties.collapsedWidth
  delete laneProperties.collapsedHeight

  const model = pasteContext.lf.addNode(
    removeChildrenInGroupNodeData({
      ...node,
      id: generatedLaneId,
      x: selectedTargetPool ? node.x : Number(node.x ?? 0) + distance,
      y: selectedTargetPool ? node.y : Number(node.y ?? 0) + distance,
      width: laneWidth,
      height: laneHeight,
      properties: laneProperties,
    }),
  )
  if (originId) nodeIdMap[originId] = model.id
  if (!selectedTargetPool && !elements.nodes.includes(targetPool)) {
    elements.nodes.push(targetPool)
  }
  elements.nodes.push(model)

  const laneIds = targetPool.getOrderedLanes().map((lane: any) => lane.id)
  const ids = laneIds.filter((id: string) => id !== model.id)
  ids.splice(Math.max(0, Math.min(insertIndex, ids.length)), 0, model.id)
  targetPool.setLaneOrder(ids)
  pasteContext.nodeLaneMap.set(model.id, targetPool.id)

  const { edgesData } = initGroupChildNodes(
    pasteContext,
    nodeIdMap,
    children,
    model as LaneModel,
    distance,
  )
  edgesInnerGroup.push(...edgesData)
  context.copiedLanes.push(model as LaneModel)
  context.copiedLaneChildOffsets[model.id] = mapLaneChildRelativePositions(
    sourceChildOffsets,
    nodeIdMap,
  )
  targetPool.layoutLanesByOrder({ reason: 'add' })
}

function pasteCommonNode(
  pasteContext: PoolPasteContext,
  node: LogicFlow.NodeData | LogicFlow.NodeConfig,
  children: Set<string>,
  distance: number,
  context: PasteContext,
) {
  const originId = node.id
  const model = pasteContext.lf.addNode(removeChildrenInGroupNodeData(node))

  if (originId) context.nodeIdMap[originId] = model.id
  context.elements.nodes.push(model)

  if (model.isGroup) {
    const { edgesData } = initGroupChildNodes(
      pasteContext,
      context.nodeIdMap,
      children,
      model as LaneModel,
      distance,
    )
    context.edgesInnerGroup.push(...edgesData)
    if (String(model.type) === 'lane') {
      context.copiedLanes.push(model as LaneModel)
      context.copiedLaneChildOffsets[model.id] = (
        model as LaneModel
      ).captureChildrenRelativePositions()
    }
  }
}

export function createPoolAddElements(
  pasteContext: PoolPasteContext,
): LogicFlow['addElements'] {
  return (
    { nodes: selectedNodes, edges: selectedEdges }: GraphConfigData,
    distance = 40,
  ): GraphElements => {
    const pasteNodes = selectedNodes ?? []
    const pasteEdges = selectedEdges ?? []
    const context: PasteContext = {
      nodeIdMap: {},
      elements: {
        nodes: [],
        edges: [],
      },
      edgesInnerGroup: [],
      copiedLaneChildOffsets: {},
      copiedLanes: [],
    }
    const { nodeIdMap, elements, edgesInnerGroup } = context

    forEach(pasteNodes, (node) => {
      const children = node.properties?.children ?? node.children

      if (String(node.type) === 'lane') {
        pasteLaneNode(pasteContext, node, children, distance, context)
        return
      }

      pasteCommonNode(pasteContext, node, children, distance, context)
    })

    context.copiedLanes.forEach((lane) => {
      lane.restoreChildrenRelativePositions(
        context.copiedLaneChildOffsets[lane.id] ?? {},
      )
    })

    forEach(edgesInnerGroup, (edge) => {
      createEdge(pasteContext, edge, nodeIdMap, distance)
    })
    forEach(pasteEdges, (edge) => {
      elements.edges.push(createEdge(pasteContext, edge, nodeIdMap, distance))
    })
    // 快捷键粘贴会选中 addElements 返回的 nodes。Pool 复制会真实创建
    // Pool/Lane/子节点，但选中态只暴露最外层容器，避免父子同时选中后拖拽重复位移。
    elements.nodes = pasteContext.getRootContainerNodes(elements.nodes)
    // 返回 elements 进行选中效果，即触发 element.selectElementById()
    // shortcut.ts 也会对最外层的 nodes 和 edges 进行偏移，即 translationNodeData()
    return elements
  }
}
