/**
 * 基于DynamicGroup重新实现的泳道节点组件
 * 继承DynamicGroupNodeModel和DynamicGroupNode，提供泳道特定功能
 */
import LogicFlow, { observable } from '@logicflow/core'
import { DynamicGroupNodeModel } from '../dynamic-group'
import { forEach } from 'lodash-es'
import { laneConfig, TitlePosition } from './constant'
import { getTitleLayout, resolveLaneTitlePosition } from './utils'

export type LaneChildRelativePositions = Record<
  string,
  { dx: number; dy: number }
>

export function mapLaneChildRelativePositions(
  sourcePositions: LaneChildRelativePositions,
  nodeIdMap: Record<string, string>,
): LaneChildRelativePositions {
  return Object.entries(sourcePositions).reduce(
    (positions, [sourceChildId, offset]) => {
      const copiedChildId = nodeIdMap[sourceChildId]
      if (copiedChildId) positions[copiedChildId] = offset
      return positions
    },
    {} as LaneChildRelativePositions,
  )
}

export class LaneModel extends DynamicGroupNodeModel {
  readonly isLane: boolean = true
  titleSize: number = laneConfig.titleSize
  defaultZIndex: number = -1
  @observable isLaneReordering: boolean = false
  @observable isLaneReturning: boolean = false

  initNodeData(data: LogicFlow.NodeConfig) {
    super.initNodeData(data)
    // 泳道特定配置
    this.width = data.width || laneConfig.defaultWidth
    this.height = data.height || laneConfig.defaultHeight
    this.draggable = true // 允许拖拽（实际拖拽逻辑由泳池控制）
    this.resizable = true // 允许调整大小
    this.rotatable = false // 禁止旋转

    // 设置泳道层级
    // 如果传入了zIndex，使用传入的值，否则默认为2
    // 泳道层级应该比所属泳池高，确保显示在泳池上方
    this.defaultZIndex = data.zIndex || -1
    this.setZIndex(this.defaultZIndex)
    this.autoToFront = true

    this.text.editable = true
    this.style.stroke = '#000'
    this.style.strokeWidth = 1

    // 泳道属性配置
    this.properties = {
      ...this.properties,
      processRef: '', // 流程引用标识
      panels: ['processRef'], // 可配置面板
      direction: data.properties?.direction || 'vertical',
    }

    // 折叠态数据需要保留展开尺寸，序列化后重新渲染才能正确恢复。
    this.collapsedWidth = data.properties?.collapsedWidth ?? this.width
    this.collapsedHeight = data.properties?.collapsedHeight ?? this.height
    this.expandWidth = data.properties?.expandWidth ?? this.width
    this.expandHeight = data.properties?.expandHeight ?? this.height
  }

  setAttributes(): void {
    super.setAttributes()
    this.updateTextPosition()
  }

  getResolvedTitlePosition() {
    return resolveLaneTitlePosition(
      this.properties,
      this.getPoolModel()?.properties ?? {
        direction: this.properties?.direction,
      },
    )
  }

  getTitleTextBox() {
    if (this.isCollapsed) {
      return { x: this.x, y: this.y, width: this.width, height: this.height }
    }
    return getTitleLayout(
      { x: this.x, y: this.y, width: this.width, height: this.height },
      this.getResolvedTitlePosition(),
      this.titleSize,
    ).titleBox
  }

  isTitleTextVerticallyCentered() {
    return true
  }

  /** 折叠 Lane 已经是完整标题块，文字不再沿展开态标题边旋转。 */
  getTitleRenderPosition(): TitlePosition {
    if (!this.isCollapsed) return this.getResolvedTitlePosition()
    return this.getPoolModel()?.isHorizontal ? 'top' : 'left'
  }

  setZIndex(zIndex: number) {
    if (zIndex > this.defaultZIndex) {
      this.zIndex = zIndex
      return
    }
    this.zIndex = Math.min(zIndex, this.defaultZIndex) || this.defaultZIndex
  }

  getOuterGAttributes() {
    const attributes = super.getOuterGAttributes()
    return {
      ...attributes,
      // 仅在排序预览或非法投放归位期间启用过渡，正常移动不能带动画滞后。
      className:
        this.isLaneReordering || this.isLaneReturning
          ? 'lf-lane-reordering'
          : '',
    }
  }

  toggleCollapse(collapse?: boolean) {
    const plugin = this.graphModel.dynamicGroup as any
    if (
      typeof plugin?.isCollapseAllowed === 'function' &&
      !plugin.isCollapseAllowed(this)
    ) {
      this.isCollapsed = false
      this.setProperties({ ...this.properties, isCollapsed: false })
      return
    }

    const next = typeof collapse === 'boolean' ? collapse : !this.isCollapsed
    if (next === this.isCollapsed) return

    if (next) {
      this.setCollapsedSizeForDirection(this.width, this.height)
    }

    super.toggleCollapse(next)
    const pool = this.getPoolModel()
    if (!pool?.isSyncingPoolCollapse) {
      pool?.layoutLanesByOrder?.({ reason: 'collapse' })
    }
  }

  /** 已折叠 Lane 的标题边变更不改变折叠轴，仍按所属 Pool 的排列方向保留标题块。 */
  refreshCollapsedTitleBounds() {
    if (!this.isCollapsed) return

    this.setCollapsedSizeForDirection(this.expandWidth, this.expandHeight)
    this.width = this.collapsedWidth
    this.height = this.collapsedHeight
    this.updateTextPosition()
  }

  private setCollapsedSizeForDirection(
    expandedWidth: number,
    expandedHeight: number,
  ) {
    const isHorizontalPool =
      this.getPoolModel()?.isHorizontal ??
      this.properties?.direction === 'horizontal'
    this.collapsedWidth = isHorizontalPool ? expandedWidth : this.titleSize
    this.collapsedHeight = isHorizontalPool ? this.titleSize : expandedHeight
  }

  /**
   * 获取所属泳池ID
   */
  getPoolId(): string | null {
    try {
      // 检查graphModel是否存在
      if (!this.graphModel) {
        console.warn('GraphModel is not available')
        return null
      }

      // 安全地获取泳池ID
      const poolModel = this.graphModel.nodes.find((node) => {
        return node.children && node.children.has(this.id)
      })
      return poolModel?.id || null
    } catch (error) {
      console.error('Error getting pool ID:', error)
      return null
    }
  }

  /**
   * 获取所属泳池模型
   */
  getPoolModel(): any {
    try {
      const poolId = this.getPoolId()
      if (!poolId) {
        return null
      }

      // 检查graphModel是否存在
      if (!this.graphModel) {
        console.warn('GraphModel is not available for getting pool model')
        return null
      }

      const poolModel = this.graphModel.getNodeModelById(poolId)
      return poolModel || null
    } catch (error) {
      console.error('Error getting pool model:', error)
      return null
    }
  }

  /**
   * 动态修改泳道属性
   */
  changeAttribute({ width, height, x, y }: any) {
    if (width) this.width = width // 更新宽度
    if (height) this.height = height // 更新高度
    if (x) this.x = x // 更新X坐标
    if (y) this.y = y // 更新Y坐标
  }

  /**
   * 重写获取数据方法，添加泳道特定属性
   */
  getData(): LogicFlow.NodeData {
    const data = super.getData()
    // const poolModel = this.getPoolModel()
    return {
      ...data,
      properties: {
        ...data.properties,
        width: this.width,
        height: this.height,
        expandWidth: this.expandWidth,
        expandHeight: this.expandHeight,
        collapsedWidth: this.collapsedWidth,
        collapsedHeight: this.collapsedHeight,
        processRef: this.properties.processRef,
        direction: this.properties.direction,
      },
    }
  }
  /**
   * 重写 isAllowAppendIn，禁止 Lane 嵌套
   */
  isAllowAppendIn(nodeData: LogicFlow.NodeData): boolean {
    // 禁止 Lane 节点被添加到 Lane 中
    return String(nodeData.type) !== 'lane'
  }

  getMovableChildIds() {
    return Array.from(this.children).filter((nodeId: string) => {
      const nodeModel = this.graphModel.getNodeModelById(nodeId)
      return (
        nodeModel && !nodeModel.isDragging && String(nodeModel.type) !== 'lane'
      )
    }) as string[]
  }

  captureChildrenRelativePositions(
    childIds: string[] = this.getMovableChildIds(),
  ): LaneChildRelativePositions {
    return childIds.reduce((positions, childId) => {
      const child = this.graphModel.getNodeModelById(childId)
      if (child) {
        positions[childId] = {
          dx: child.x - this.x,
          dy: child.y - this.y,
        }
      }
      return positions
    }, {} as LaneChildRelativePositions)
  }

  restoreChildrenRelativePositions(positions: LaneChildRelativePositions) {
    const moves = Object.entries(positions)
      .map(([childId, offset]) => {
        const child = this.graphModel.getNodeModelById(childId)
        if (!child) return undefined
        const targetX = this.x + offset.dx
        const targetY = this.y + offset.dy
        return {
          childId,
          targetX,
          targetY,
          deltaX: targetX - child.x,
          deltaY: targetY - child.y,
        }
      })
      .filter(Boolean) as Array<{
      childId: string
      targetX: number
      targetY: number
      deltaX: number
      deltaY: number
    }>
    const moved = moves.filter(({ deltaX, deltaY }) => deltaX || deltaY)
    if (moved.length === 0) return

    const [first] = moved
    const hasSameDelta = moved.every(
      ({ deltaX, deltaY }) =>
        deltaX === first.deltaX && deltaY === first.deltaY,
    )
    if (hasSameDelta) {
      this.graphModel.moveNodes(
        moved.map(({ childId }) => childId),
        first.deltaX,
        first.deltaY,
        true,
      )
      return
    }

    moved.forEach(({ childId, targetX, targetY }) => {
      this.graphModel.moveNode2Coordinate(childId, targetX, targetY, true)
    })
  }

  /**
   * 获取需要移动的节点
   * @param groupModel
   */
  getNodesInGroup(groupModel: DynamicGroupNodeModel): string[] {
    const nodeIds: string[] = []
    forEach(Array.from(groupModel.children), (nodeId: string) => {
      const nodeModel = this.graphModel.getNodeModelById(nodeId)
      // 只有非 Lane 类型的节点才会被带动
      if (
        nodeModel &&
        !nodeModel.isDragging &&
        String(nodeModel.type) !== 'lane'
      ) {
        nodeIds.push(nodeId)
      }
    })
    return nodeIds
  }
  getNodeStyle() {
    const style = super.getNodeStyle()
    style.strokeWidth = 2
    return style
  }
  /**
   * 获取文本样式
   */
  getTextStyle() {
    const style = super.getTextStyle()
    const titleLayout = getTitleLayout(
      { x: this.x, y: this.y, width: this.width, height: this.height },
      this.getResolvedTitlePosition(),
      this.titleSize,
    )
    const titlePosition = this.getTitleRenderPosition()
    const isVerticalTitle =
      titlePosition === 'left' || titlePosition === 'right'

    style.overflowMode = 'ellipsis'
    style.strokeWidth = 2
    style.textWidth = isVerticalTitle
      ? titleLayout.titleBox.height
      : titleLayout.titleBox.width
    style.textHeight = isVerticalTitle
      ? titleLayout.titleBox.width
      : titleLayout.titleBox.height
    if (isVerticalTitle) {
      style.transform = 'rotate(-90deg)'
    } else if ('transform' in style) {
      delete style.transform
    }
    style.textAlign = 'center'
    return style
  }

  /**
   * 获取子泳道
   */
  getSubNodes() {
    const children: any[] = []
    Array.from(this.children).forEach((childId) => {
      const childModel = this.graphModel.getNodeModelById(childId)
      if (childModel) {
        children.push(childModel)
      }
    })
    return children
  }

  /**
   * Lane 文本跟随解析后的标题边，避免仅靠旧 isHorizontal 分支导致四边标题错位。
   */
  setTextPosition() {
    if (!this.text) return

    const titleSize = this.titleSize || laneConfig.titleSize
    const titleBox = this.getTitleTextBox()
    const textAnchor = this.isCollapsed
      ? { x: titleBox.x, y: titleBox.y }
      : getTitleLayout(
          { x: this.x, y: this.y, width: this.width, height: this.height },
          this.getResolvedTitlePosition(),
          titleSize,
        ).textAnchor

    if (this.text.x !== textAnchor.x || this.text.y !== textAnchor.y) {
      this.text = {
        ...this.text,
        x: textAnchor.x,
        y: textAnchor.y,
      }
    }
  }

  updateTextPosition() {
    this.setTextPosition()
  }
}

export default null
