import type { Turbine } from '@/types/turbine'
import type { Blade } from '@/types/blade'
import type { Segment } from '@/types/segment'
import type { Defect } from '@/types/defect'
import type { WorkOrder } from '@/types/workOrder'

/**
 * 离线巡检包：外委检修队在无网机位各自导出，
 * 回到集控室后不直接并入台账，而是先进「待核对批次」。
 * 结构与全量备份兼容（五张业务表原样携带），另带 kind / sourceTeam 标识。
 */
export interface InspectionPack {
  app: 'gbwindblade'
  kind: 'offline-inspection-pack'
  dbVersion: number
  exportedAt: string
  /** 导出现场包的检修队 / 设备标识，写入台账时作为来源留痕 */
  sourceTeam?: string
  turbines: Turbine[]
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
  workOrders: WorkOrder[]
}

/** 匹配结果：新缺陷 / 同一缺陷且一致 / 同一缺陷但有分歧 */
export type BatchItemMatchKind = 'new' | 'same' | 'conflict'

/**
 * 核对结论：
 * - pending 待核对（分歧项默认，未给结论前整批不可写入）
 * - keep-local 维持本地原值（现场值不覆盖）
 * - use-incoming 采用现场值覆盖本地（本地原值留痕）
 * - duplicate 并列新增：现场记录作为一条新缺陷落档，本地记录保留
 * - new 现场新缺陷直接录入（仅 new 项使用）
 */
export type BatchResolution = 'pending' | 'keep-local' | 'use-incoming' | 'duplicate' | 'new'

export type BatchItemStatus = '待核对' | '已确认' | '已写入' | '已撤回'

/** 批次状态：待核对 → 已确认 → 已写入；已写入可撤回为已撤回 */
export type BatchState = '待核对' | '已确认' | '已写入' | '已撤回'

/** 现场值与本地原值的分歧字段（尺寸 / 程度 / 面位） */
export interface BatchValueDiff {
  /** 字段中文名 */
  field: string
  key: 'lengthMm' | 'widthMm' | 'severity' | 'face'
  local: string | number
  incoming: string | number
}

/** 批次内的一条缺陷核对项：现场原值与本地原值并列保留 */
export interface BatchDefectItem {
  /** 批次内临时主键 */
  itemId: string
  /** 现场缺陷原记录编号（原 defect.id），写入后作为来源记录号留痕 */
  sourceDefectId: string
  /** 命中的本地缺陷 id；现场新缺陷为 null */
  localDefectId: string | null
  matchKind: BatchItemMatchKind
  /** 定位摘要：机组编号 / 叶片序号 / 分段序号 / 展向位置 */
  turbineCode: string
  bladeSerial: string
  segmentIndex: number
  positionM: number
  /** 现场原值完整快照 */
  incoming: Defect
  /** 本地原值完整快照；现场新缺陷为 null */
  local: Defect | null
  /** 尺寸 / 程度 / 面位分歧明细 */
  diffs: BatchValueDiff[]
  resolution: BatchResolution
  status: BatchItemStatus
  /** 同位置存在其他类型的本地缺陷时的并列提示（不影响匹配结论） */
  positionNote?: string
  /** 现场包自身缺少机组 / 叶片 / 分段，无法定位到台账坐标 */
  blocked?: boolean
  blockReason?: string
  decidedAt?: number
  writtenAt?: number
  /** 写入后的本地缺陷 id（新增 / 并列新增时生成） */
  writtenDefectId?: string
  /** 本次写入对本地缺陷执行的动作：新增 / 覆盖更新 / 跳过，供撤回时区分处理 */
  writtenAction?: 'inserted' | 'updated' | 'skipped'
}

/** 批次内的工单核对项：依附现场缺陷，随缺陷结论一同写入或退回 */
export interface BatchWorkOrderItem {
  itemId: string
  sourceOrderId: string
  /** 对应的现场缺陷原记录编号 */
  sourceDefectId: string
  /** 依附的批次缺陷项 itemId */
  defectItemId: string
  incoming: WorkOrder
  /** 已写入 / 已撤回 / 已确认待写入 / 不录入（对应缺陷维持本地时现场工单不覆盖本地） */
  status: BatchItemStatus | '不录入'
  writtenAt?: number
  writtenOrderId?: string
}

/** 现场包内的层级快照：写入时用于补建本地缺失的机组 / 叶片 / 分段 */
export interface BatchHierarchy {
  turbines: Turbine[]
  blades: Blade[]
  segments: Segment[]
}

/**
 * 离线巡检包合并批次。
 * 确认前只存在 inspectionBatches 表，绝不写五张本地业务表。
 */
export interface InspectionBatch {
  id: string
  name: string
  state: BatchState
  /** 来源检修队（来自巡检包，可在核对页修改） */
  sourceTeam: string
  sourceFile: string
  sourceExportedAt: string
  stagedAt: number
  updatedAt: number
  sourceCounts: {
    turbines: number
    blades: number
    segments: number
    defects: number
    workOrders: number
  }
  /** 现场包层级快照（用于写入时补建本地缺失坐标与撤回核对） */
  hierarchy: BatchHierarchy
  defectItems: BatchDefectItem[]
  workOrderItems: BatchWorkOrderItem[]
  /** 整批写入时间，未写入为 null */
  committedAt: number | null
  /** 最近一次写入失败原因；成功后清空 */
  commitError: string | null
  commitAttempts: number
  lastAttemptAt: number | null
  rolledBackAt: number | null
  /** 写入时在本地补建的层级记录 id，撤回批次时随缺陷 / 工单一并退回 */
  onboarded: {
    turbineIds: string[]
    bladeIds: string[]
    segmentIds: string[]
  }
}

export const BATCH_STATE_LABEL: Record<BatchState, string> = {
  待核对: '待核对',
  已确认: '已确认待写入',
  已写入: '已写入台账',
  已撤回: '已撤回'
}

export const BATCH_STATE_TAG_TYPE: Record<BatchState, 'warning' | 'primary' | 'success' | 'info'> = {
  待核对: 'warning',
  已确认: 'primary',
  已写入: 'success',
  已撤回: 'info'
}

export const RESOLUTION_LABEL: Record<BatchResolution, string> = {
  pending: '待核对',
  'keep-local': '维持本地原值',
  'use-incoming': '采用现场值覆盖',
  duplicate: '并列新增为新缺陷',
  new: '录入为新缺陷'
}

export const MATCH_KIND_LABEL: Record<BatchItemMatchKind, string> = {
  new: '现场新缺陷',
  same: '同一缺陷 · 一致',
  conflict: '同一缺陷 · 有分歧'
}

/** 展向位置判定同一缺陷的容差（米） */
export const POSITION_TOLERANCE_M = 0.5

/** 批次汇总数字，列表页与导航徽标共用 */
export interface BatchSummary {
  total: number
  pendingBatches: number
  committedBatches: number
  defectItems: number
  pendingItems: number
  conflictItems: number
  newItems: number
  workOrderItems: number
}
