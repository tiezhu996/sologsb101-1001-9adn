import type { DefectState, DefectType, Severity } from '@/types/defect'
import type { SegmentFace } from '@/types/segment'
import type { WorkOrderState } from '@/types/workOrder'

/**
 * 离线巡检包合并：外委检修队在无网机位各自导出巡检包，集控室导入后
 * 先进入「待核对批次」，按机组编号、叶片序号与展向位置匹配同一缺陷，
 * 核对确认前不写本地台账；整批确认后才落库，并保留来源与原值。
 */

/** 批次状态：待核对 → 已确认（整批写入）→ 已撤回（缺陷与工单同步退回） */
export type MergeBatchState = '待核对' | '写入失败' | '已确认' | '已撤回'

/** 条目录属关系判定结果 */
export type MergeItemKind = 'new' | 'same' | 'conflict' | 'unlocatable'

/** 现场缺陷的字段分歧项：尺寸（长 / 宽）、程度、面位，另含类型差异 */
export type MergeConflictField = 'type' | 'severity' | 'lengthMm' | 'widthMm' | 'face'

/**
 * 单条核对结论：
 * - both：分歧时并列保留，台账原记录与现场新记录同时存在
 * - incoming：以现场结果为准（新增或覆盖台账记录）
 * - local：保留台账原值（可补挂现场带来的工单）
 * - skip：无法定位的条目不写入
 */
export type MergeResolution = 'both' | 'incoming' | 'local' | 'skip'

/** 条目录入结果：确认前一律「待写入」 */
export type MergeWriteState = '待写入' | '已写入' | '已跳过' | '写入失败' | '已撤回'

/** 批次内携带的现场缺陷（巡检包原记录，记录编号即 id 原样保留） */
export interface IncomingDefectSnapshot {
  /** 现场记录编号（包内缺陷原 id） */
  id: string
  type: DefectType
  severity: Severity
  lengthMm: number
  widthMm: number
  face: SegmentFace
  /** 展向位置（米），与叶片序号共同作为同一缺陷的匹配键 */
  positionM: number
  foundAt: string
  state: DefectState
}

/** 批次内携带的现场工单 */
export interface IncomingOrderSnapshot {
  /** 现场工单记录编号（包内工单原 id） */
  id: string
  /** 包内所属缺陷记录编号 */
  defectId: string
  team: string
  dueDate: string
  state: WorkOrderState
  acceptor: string
  closedAt: number | null
}

/** 匹配到的台账缺陷（核对时的原值快照，撤回时据此还原） */
export interface LocalDefectSnapshot extends IncomingDefectSnapshot {
  segmentId: string
  createdAt: number
  updatedAt: number
}

/** 匹配到的台账工单（用于去重判断与页面提示） */
export interface LocalOrderSnapshot extends IncomingOrderSnapshot {}

/** 无法定位原因 */
export type MergeBlockReasonType = 'turbine-missing' | 'blade-missing' | 'segment-missing' | 'local-defect-missing'

/** 撤回前检查出的阻断原因 */
export interface MergeBlockReason {
  itemId: string
  type: MergeBlockReasonType | 'order-created-after-merge' | 'defect-closed-after-merge'
  message: string
}

/** 确认写入后留存的落库痕迹，撤回批次时据此退回缺陷与工单 */
export interface MergeWrittenRecord {
  writtenAt: number
  /** 受影响的台账缺陷 id（覆盖 / 补挂工单时为既有缺陷） */
  localDefectId: string | null
  /** 并列保留 / 新增时创建的缺陷 id */
  incomingDefectId: string | null
  /** 被现场值覆盖的台账缺陷 id（撤回时还原 localDefectSnapshot） */
  replacedDefectId: string | null
  /** 仅补挂工单、未改字段的台账缺陷（撤回时只删工单，不动缺陷） */
  localKept: boolean
  /** 本次实际新建的工单 id（撤回时仅删除这些，不动合并后新建的工单） */
  createdOrderIds: string[]
  /** 写入时台账已存在的工单 id（撤回阻断检查时排除这些合并前工单） */
  preExistingOrderIds: string[]
  /** 写入前台账缺陷的完整原值快照 */
  localDefectSnapshot: LocalDefectSnapshot | null
}

/**
 * 批次条目：一条现场缺陷与匹配到的台账缺陷（可能为空）。
 * 匹配键：机组编号 + 叶片序号 + 展向位置。
 */
export interface MergeItem {
  id: string
  kind: MergeItemKind
  /** 核对结论，默认值随 kind 给出 */
  resolution: MergeResolution
  /** 现场缺陷原值 */
  incoming: IncomingDefectSnapshot
  /** 现场带来的工单（包内该缺陷下的全部工单） */
  incomingOrders: IncomingOrderSnapshot[]
  /** 匹配到的台账缺陷；新增 / 无法定位时为 null */
  local: LocalDefectSnapshot | null
  /** 匹配到的台账缺陷当时挂接的工单 */
  localOrders: LocalOrderSnapshot[]
  /** 分歧字段；无分歧为空数组 */
  conflictFields: MergeConflictField[]
  /** 写入定位（导入时解析；无法定位时 segmentId 为 null） */
  target: {
    turbineCode: string
    bladeSerial: string
    positionM: number
    segmentId: string | null
  }
  /** 无法定位或校验失败的原因 */
  reason: string | null
  writeState: MergeWriteState
  /** 写入失败的错误信息 */
  error: string | null
  /** 已确认写入后留下的落库痕迹 */
  written: MergeWrittenRecord | null
}

/** 离线巡检包待核对批次 */
export interface MergeBatch {
  id: string
  /** 来源文件名（外委班组 + 机位导出的巡检包） */
  sourceName: string
  state: MergeBatchState
  importedAt: number
  committedAt: number | null
  withdrawnAt: number | null
  sourceDefectCount: number
  sourceWorkOrderCount: number
  lastError: string | null
  items: MergeItem[]
  createdAt: number
  updatedAt: number
}

export const MERGE_BATCH_STATES: MergeBatchState[] = ['待核对', '写入失败', '已确认', '已撤回']

export const MERGE_ITEM_KINDS: MergeItemKind[] = ['new', 'same', 'conflict', 'unlocatable']

export const MERGE_RESOLUTIONS: MergeResolution[] = ['both', 'incoming', 'local', 'skip']

/** 条目录属中文标签 */
export const MERGE_KIND_LABEL: Record<MergeItemKind, string> = {
  new: '新增',
  same: '同一',
  conflict: '分歧',
  unlocatable: '无法定位'
}

/** 核对结论中文标签 */
export const MERGE_RESOLUTION_LABEL: Record<MergeResolution, string> = {
  both: '并列保留',
  incoming: '以现场为准',
  local: '保留台账',
  skip: '不写入'
}

/** 批次状态配色（Element Plus tag type） */
export const MERGE_BATCH_TAG_TYPE: Record<MergeBatchState, 'warning' | 'danger' | 'success' | 'info'> = {
  待核对: 'warning',
  写入失败: 'danger',
  已确认: 'success',
  已撤回: 'info'
}

/** 条目录属配色 */
export const MERGE_KIND_TAG_TYPE: Record<MergeItemKind, 'primary' | 'success' | 'danger' | 'info'> = {
  new: 'primary',
  same: 'success',
  conflict: 'danger',
  unlocatable: 'info'
}

/** 各录属允许选择的核对结论 */
export function allowedResolutions(kind: MergeItemKind): MergeResolution[] {
  switch (kind) {
    case 'new':
      return ['incoming', 'skip']
    case 'same':
      return ['local', 'incoming']
    case 'conflict':
      return ['both', 'incoming', 'local']
    case 'unlocatable':
      return ['skip']
  }
}

/** 导入时各录属的默认核对结论 */
export function defaultResolution(kind: MergeItemKind): MergeResolution {
  switch (kind) {
    case 'new':
      return 'incoming'
    case 'same':
      return 'local'
    case 'conflict':
      // 尺寸、程度或面位有分歧时默认并列保留，确认前不丢任何一侧的值
      return 'both'
    case 'unlocatable':
      return 'skip'
  }
}

/** 写入状态中文标签 */
export const MERGE_WRITE_STATE_LABEL: Record<MergeWriteState, string> = {
  待写入: '待写入',
  已写入: '已写入',
  已跳过: '已跳过',
  写入失败: '写入失败',
  已撤回: '已撤回'
}
