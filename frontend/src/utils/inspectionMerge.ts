import { createId, db, round2 } from '@/utils/db'
import { FACE_SHORT, type Segment, type SegmentFace } from '@/types/segment'
import type { Blade } from '@/types/blade'
import type { Turbine } from '@/types/turbine'
import type { Defect } from '@/types/defect'
import type { WorkOrder } from '@/types/workOrder'
import {
  POSITION_TOLERANCE_M,
  type BatchDefectItem,
  type BatchHierarchy,
  type BatchValueDiff,
  type BatchWorkOrderItem,
  type InspectionBatch,
  type InspectionPack
} from '@/types/inspectionBatch'

/* ---------------- 巡检包组装 / 校验 ---------------- */

/** 组装外委检修队在无网机位导出的离线巡检包（只含业务五表，不含待核对批次） */
export async function buildInspectionPack(sourceTeam: string): Promise<InspectionPack> {
  const [turbines, blades, segments, defects, workOrders] = await Promise.all([
    db.turbines.toArray(),
    db.blades.toArray(),
    db.segments.toArray(),
    db.defects.toArray(),
    db.workOrders.toArray()
  ])
  return {
    app: 'gbwindblade',
    kind: 'offline-inspection-pack',
    dbVersion: 3,
    exportedAt: new Date().toISOString(),
    sourceTeam: sourceTeam.trim(),
    turbines,
    blades,
    segments,
    defects,
    workOrders
  }
}

/** 校验离线巡检包：兼容老格式全量备份（无 kind 字段时按巡检包处理） */
export function validateInspectionPack(input: unknown): {
  ok: boolean
  errors: string[]
  pack: InspectionPack | null
} {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], pack: null }
  }
  const obj = input as Partial<InspectionPack>
  if (obj.app !== 'gbwindblade') errors.push('app 字段应为 gbwindblade，文件来源不明')
  if (obj.kind !== undefined && obj.kind !== 'offline-inspection-pack') {
    errors.push(`kind 字段应为 offline-inspection-pack，实际为 ${String(obj.kind)}`)
  }
  for (const key of ['turbines', 'blades', 'segments', 'defects', 'workOrders'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, pack: null }
  const pack: InspectionPack = {
    app: 'gbwindblade',
    kind: 'offline-inspection-pack',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : 3,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    sourceTeam: typeof obj.sourceTeam === 'string' ? obj.sourceTeam : '',
    turbines: obj.turbines ?? [],
    blades: obj.blades ?? [],
    segments: obj.segments ?? [],
    defects: obj.defects ?? [],
    workOrders: obj.workOrders ?? []
  }
  return { ok: true, errors: [], pack }
}

/* ---------------- 现场包 → 待核对批次 ---------------- */

interface LocalIndex {
  turbineByCode: Map<string, Turbine>
  bladeByKey: Map<string, Blade>
  segmentByKey: Map<string, Segment>
}

export function bladeKeyOf(turbineCode: string, serial: string): string {
  return `${turbineCode.trim()}::${serial}`
}

export function segmentKeyOf(turbineCode: string, serial: string, index: number): string {
  return `${turbineCode.trim()}::${serial}::${index}`
}

/** 建立本地台账的定位索引：机组编号 → 叶片序号 → 分段序号 */
export function buildLocalIndex(turbines: Turbine[], blades: Blade[], segments: Segment[]): LocalIndex {
  const turbineByCode = new Map<string, Turbine>()
  turbines.forEach((turbine) => turbineByCode.set(turbine.code.trim(), turbine))

  const bladeByKey = new Map<string, Blade>()
  blades.forEach((blade) => {
    const turbine = turbines.find((item) => item.id === blade.turbineId)
    if (turbine) bladeByKey.set(bladeKeyOf(turbine.code, blade.serial), blade)
  })

  const segmentByKey = new Map<string, Segment>()
  segments.forEach((segment) => {
    const blade = blades.find((item) => item.id === segment.bladeId)
    const turbine = blade ? turbines.find((item) => item.id === blade.turbineId) : undefined
    if (blade && turbine) {
      segmentByKey.set(segmentKeyOf(turbine.code, blade.serial, segment.index), segment)
    }
  })
  return { turbineByCode, bladeByKey, segmentByKey }
}

function pushDiff(
  diffs: BatchValueDiff[],
  field: string,
  key: BatchValueDiff['key'],
  local: string | number,
  incoming: string | number
): void {
  if (local !== incoming) diffs.push({ field, key, local, incoming })
}

const FACE_TEXT: Record<string, string> = Object.fromEntries(
  (Object.keys(FACE_SHORT) as SegmentFace[]).map((face) => [face, FACE_SHORT[face]])
)

export interface DefectMatch {
  localDefectId: string | null
  matchKind: BatchDefectItem['matchKind']
  diffs: BatchValueDiff[]
  turbineCode: string
  bladeSerial: string
  segmentIndex: number
  positionM: number
  blocked?: boolean
  blockReason?: string
  positionNote?: string
}

/**
 * 按机组编号、叶片序号、展向位置找同一缺陷：
 * 同类型且展向位置差 ≤ 容差视为同一缺陷；尺寸 / 程度 / 面位分歧时标记 conflict 并列保留。
 * 类型不同即便位置重合也不合并（默认并列新增并提示人工核对）。
 */
export function matchIncomingDefect(
  incoming: Defect,
  pack: InspectionPack,
  index: LocalIndex,
  localDefects: Defect[]
): DefectMatch {
  const packSegment = pack.segments.find((segment) => segment.id === incoming.segmentId)
  const packBlade = packSegment ? pack.blades.find((blade) => blade.id === packSegment.bladeId) : undefined
  const packTurbine = packBlade ? pack.turbines.find((turbine) => turbine.id === packBlade.turbineId) : undefined

  if (!packSegment || !packBlade || !packTurbine) {
    return {
      localDefectId: null,
      matchKind: 'new',
      diffs: [],
      turbineCode: packTurbine?.code ?? '未知机组',
      bladeSerial: packBlade?.serial ?? '?',
      segmentIndex: packSegment?.index ?? 0,
      positionM: incoming.positionM,
      blocked: true,
      blockReason: '巡检包内缺少该缺陷所属的机组 / 叶片 / 分段，无法定位'
    }
  }

  const turbineCode = packTurbine.code.trim()
  const bladeSerial = packBlade.serial
  const segmentIndex = packSegment.index
  const localSegment = index.segmentByKey.get(segmentKeyOf(turbineCode, bladeSerial, segmentIndex))

  // 本地尚无该坐标（机组 / 叶片 / 分段缺失）：写入时随包补建，缺陷一律按新增处理
  if (!localSegment) {
    return {
      localDefectId: null,
      matchKind: 'new',
      diffs: [],
      turbineCode,
      bladeSerial,
      segmentIndex,
      positionM: incoming.positionM
    }
  }

  const near = localDefects
    .filter((defect) => defect.segmentId === localSegment.id)
    .map((defect) => ({ defect, distance: Math.abs(defect.positionM - incoming.positionM) }))
    .filter((item) => item.distance <= POSITION_TOLERANCE_M)
    .sort((a, b) => a.distance - b.distance)

  // 同类型 + 展向位置容差内 → 同一缺陷
  const same = near.find((item) => item.defect.type === incoming.type)
  if (same) {
    const local = same.defect
    const diffs: BatchValueDiff[] = []
    pushDiff(diffs, '长度 (mm)', 'lengthMm', local.lengthMm, incoming.lengthMm)
    pushDiff(diffs, '宽度 (mm)', 'widthMm', local.widthMm, incoming.widthMm)
    pushDiff(diffs, '严重程度', 'severity', local.severity, incoming.severity)
    pushDiff(
      diffs,
      '面位',
      'face',
      FACE_TEXT[local.face] ?? local.face,
      FACE_TEXT[incoming.face] ?? incoming.face
    )
    return {
      localDefectId: local.id,
      matchKind: diffs.length > 0 ? 'conflict' : 'same',
      diffs,
      turbineCode,
      bladeSerial,
      segmentIndex,
      positionM: incoming.positionM
    }
  }

  // 不同类型但位置重合：不判同一缺陷，默认并列录入并提示
  const other = near[0]
  return {
    localDefectId: null,
    matchKind: 'new',
    diffs: [],
    turbineCode,
    bladeSerial,
    segmentIndex,
    positionM: incoming.positionM,
    positionNote: other
      ? `同位置已有本地「${other.defect.type}」缺陷（${other.defect.positionM} m），类型不同，默认并列新增，请人工核对是否漏判类型`
      : undefined
  }
}

/**
 * 离线巡检包合并：先进待核对批次。
 * 不触碰五张本地业务表，只生成一条 InspectionBatch 供人工逐条核对。
 */
export function stageInspectionPack(
  pack: InspectionPack,
  meta: { name: string; sourceFile: string },
  local: { turbines: Turbine[]; blades: Blade[]; segments: Segment[]; defects: Defect[] }
): InspectionBatch {
  const index = buildLocalIndex(local.turbines, local.blades, local.segments)

  const defectItems: BatchDefectItem[] = pack.defects.map((incoming) => {
    const matched = matchIncomingDefect(incoming, pack, index, local.defects)
    return {
      itemId: createId('itm'),
      sourceDefectId: incoming.id,
      resolution: matched.matchKind === 'new' ? 'new' : 'pending',
      status: '待核对',
      incoming,
      local: matched.localDefectId
        ? local.defects.find((defect) => defect.id === matched.localDefectId) ?? null
        : null,
      ...matched
    }
  })

  const defectItemBySource = new Map(defectItems.map((item) => [item.sourceDefectId, item]))
  const workOrderItems: BatchWorkOrderItem[] = pack.workOrders
    .filter((order) => defectItemBySource.has(order.defectId))
    .map((incoming) => ({
      itemId: createId('wim'),
      sourceOrderId: incoming.id,
      sourceDefectId: incoming.defectId,
      defectItemId: defectItemBySource.get(incoming.defectId)?.itemId as string,
      incoming,
      status: '待核对'
    }))

  const hierarchy: BatchHierarchy = {
    turbines: pack.turbines,
    blades: pack.blades,
    segments: pack.segments
  }

  const now = Date.now()
  return {
    id: createId('bat'),
    name: meta.name.trim() || `巡检包 ${pack.exportedAt.slice(0, 10)}`,
    state: '待核对',
    sourceTeam: pack.sourceTeam?.trim() ?? '',
    sourceFile: meta.sourceFile,
    sourceExportedAt: pack.exportedAt,
    stagedAt: now,
    updatedAt: now,
    sourceCounts: {
      turbines: pack.turbines.length,
      blades: pack.blades.length,
      segments: pack.segments.length,
      defects: pack.defects.length,
      workOrders: pack.workOrders.length
    },
    hierarchy,
    defectItems,
    workOrderItems,
    committedAt: null,
    commitError: null,
    commitAttempts: 0,
    lastAttemptAt: null,
    rolledBackAt: null,
    onboarded: { turbineIds: [], bladeIds: [], segmentIds: [] }
  }
}

/* ---------------- 整批写入（确认后才执行） ---------------- */

/** 是否允许整批确认：无待核对 / 阻塞项 */
export function batchReadyToConfirm(batch: InspectionBatch): boolean {
  return (
    (batch.state === '待核对' || batch.state === '已确认') &&
    batch.defectItems.length > 0 &&
    batch.defectItems.every((item) => item.resolution !== 'pending' && !item.blocked)
  )
}

/** 是否允许整批写入 */
export function batchReadyToCommit(batch: InspectionBatch): boolean {
  return batch.state === '已确认'
}

/** 未决项数量（含阻塞） */
export function pendingItemCount(batch: InspectionBatch): number {
  return batch.defectItems.filter((item) => item.resolution === 'pending' || item.blocked).length
}

interface CommitMaps {
  turbineByCode: Map<string, Turbine>
  bladeByKey: Map<string, Blade>
  segmentByKey: Map<string, Segment>
}

/** Dexie 记录可能携带原型/不可克隆字段，事务前转成纯对象再深拷贝 */
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 整批写入本地台账（单个 Dexie 事务，整体成功或整体回滚，失败可整笔重试）。
 * - same（维度一致）/ keep-local：本地记录保持不动，现场工单不覆盖本地工单
 * - use-incoming：覆盖更新尺寸 / 程度 / 面位等，保留来源与本地原值
 * - new / duplicate：新建缺陷
 * - 工单跟随对应缺陷录入；补建的机组 / 叶片 / 分段 id 登记在 onboarded 供撤回使用
 */
export async function commitBatch(batch: InspectionBatch): Promise<InspectionBatch> {
  const now = Date.now()
  const next = structuredClone(toPlain(batch)) as InspectionBatch

  // 已写入批次不可重复写入（如需改结论先撤回），避免重复新增缺陷 / 工单
  if (batch.state === '已写入') {
    next.commitError = '该批次已写入台账，重复写入已被拦截；如需调整请先撤回批次'
    return next
  }

  next.state = '已写入'
  next.commitAttempts += 1
  next.lastAttemptAt = now
  next.commitError = null

  try {
    await db.transaction(
      'rw',
      [db.turbines, db.blades, db.segments, db.defects, db.workOrders],
      async () => {
        // 事务开始时的本地坐标快照（重试时此前 onboarded 已存在，会被索引直接命中）
        const maps: CommitMaps = {
          turbineByCode: new Map(
            (await db.turbines.toArray()).map((turbine) => [turbine.code.trim(), turbine])
          ),
          bladeByKey: new Map<string, Blade>(),
          segmentByKey: new Map<string, Segment>()
        }
        const allBlades = await db.blades.toArray()
        const allSegments = await db.segments.toArray()
        allBlades.forEach((blade) => {
          const turbine = [...maps.turbineByCode.values()].find((item) => item.id === blade.turbineId)
          if (turbine) maps.bladeByKey.set(bladeKeyOf(turbine.code, blade.serial), blade)
        })
        allSegments.forEach((segment) => {
          const blade = allBlades.find((item) => item.id === segment.bladeId)
          const turbine = blade
            ? [...maps.turbineByCode.values()].find((item) => item.id === blade.turbineId)
            : undefined
          if (blade && turbine) {
            maps.segmentByKey.set(segmentKeyOf(turbine.code, blade.serial, segment.index), segment)
          }
        })

        // 1. 按现场层级快照补建本地缺失的机组 / 叶片 / 分段
        await ensureHierarchy(next, maps, now)

        // 2. 逐条缺陷写入
        const sourceDefectToWrittenId = new Map<string, string>()
        for (const item of next.defectItems) {
          if (item.status === '已写入' && item.writtenDefectId) {
            // 重试：上次事务已整体回滚，不应出现此状态；防御性保留映射
            sourceDefectToWrittenId.set(item.sourceDefectId, item.writtenDefectId)
            continue
          }
          const localSegment = maps.segmentByKey.get(
            segmentKeyOf(item.turbineCode, item.bladeSerial, item.segmentIndex)
          )
          if (!localSegment) {
            throw new Error(
              `写入失败：定位不到 ${item.turbineCode} 叶片 ${item.bladeSerial} 第 ${item.segmentIndex} 段`
            )
          }
          const stamp = {
            sourceBatchId: next.id,
            sourceTeam: next.sourceTeam,
            sourceRecordId: item.sourceDefectId
          }

          if (item.resolution === 'new' || item.resolution === 'duplicate') {
            const id = createId('dfc')
            const defect: Defect = {
              ...item.incoming,
              id,
              segmentId: localSegment.id,
              ...stamp,
              originalBeforeMerge: null,
              createdAt: now,
              updatedAt: now
            }
            await db.defects.put(defect)
            item.status = '已写入'
            item.writtenAt = now
            item.writtenDefectId = id
            item.writtenAction = 'inserted'
            sourceDefectToWrittenId.set(item.sourceDefectId, id)
            continue
          }

          if (item.resolution === 'use-incoming' && item.localDefectId) {
            const current = await db.defects.get(item.localDefectId)
            if (!current) throw new Error(`写入失败：本地缺陷 ${item.localDefectId} 已不存在`)
            const originalBeforeMerge = current.originalBeforeMerge ?? {
              lengthMm: current.lengthMm,
              widthMm: current.widthMm,
              severity: current.severity,
              face: current.face
            }
            await db.defects.put({
              ...current,
              type: item.incoming.type,
              severity: item.incoming.severity,
              lengthMm: item.incoming.lengthMm,
              widthMm: item.incoming.widthMm,
              face: item.incoming.face,
              positionM: item.incoming.positionM,
              ...stamp,
              originalBeforeMerge,
              updatedAt: now
            })
            item.status = '已写入'
            item.writtenAt = now
            item.writtenDefectId = item.localDefectId
            item.writtenAction = 'updated'
            sourceDefectToWrittenId.set(item.sourceDefectId, item.localDefectId)
            continue
          }

          // same（维度一致）/ keep-local：本地记录保持不动
          item.status = '已写入'
          item.writtenAt = now
          item.writtenDefectId = item.localDefectId ?? undefined
          item.writtenAction = 'skipped'
          if (item.localDefectId) sourceDefectToWrittenId.set(item.sourceDefectId, item.localDefectId)
        }

        // 3. 工单：跟随对应缺陷录入；「维持本地 / 一致跳过」的现场工单不写入，避免覆盖本地处置结果
        for (const item of next.workOrderItems) {
          const defectItem = next.defectItems.find((defect) => defect.itemId === item.defectItemId)
          if (!defectItem) continue
          if (defectItem.writtenAction === 'skipped') {
            item.status = '不录入'
            continue
          }
          const defectId = sourceDefectToWrittenId.get(item.sourceDefectId)
          if (!defectId) continue
          const order: WorkOrder = {
            ...item.incoming,
            id: createId('wo'),
            defectId,
            sourceBatchId: next.id,
            sourceTeam: next.sourceTeam,
            sourceRecordId: item.sourceOrderId,
            createdAt: now,
            updatedAt: now
          }
          await db.workOrders.put(order)
          item.status = '已写入'
          item.writtenAt = now
          item.writtenOrderId = order.id
          // 现场工单未闭环：缺陷至少推进到「已派工」，闭环以本地验收为准
          if (item.incoming.state !== '已闭环') {
            const defect = await db.defects.get(defectId)
            if (defect && defect.state !== '已修复') {
              await db.defects.update(defectId, { state: '已派工' })
            }
          }
        }
      }
    )
    next.state = '已写入'
    next.committedAt = now
    next.updatedAt = now
    next.commitError = null
    return next
  } catch (error) {
    // 事务已整体回滚：批次回到「已确认」，保留现场原值，允许整笔重试
    next.state = '已确认'
    next.defectItems.forEach((item) => {
      if (item.status === '已写入') item.status = '已确认'
      item.writtenAt = undefined
      item.writtenDefectId = undefined
      item.writtenAction = undefined
    })
    next.workOrderItems.forEach((item) => {
      if (item.status === '已写入') item.status = '已确认'
      item.writtenAt = undefined
      item.writtenOrderId = undefined
    })
    next.commitError = error instanceof Error ? error.message : '整批写入失败，可重试'
    next.updatedAt = now
    return next
  }
}

/** 事务内：按现场层级快照补建本地缺失的机组 / 叶片 / 分段，并登记到 onboarded */
async function ensureHierarchy(batch: InspectionBatch, maps: CommitMaps, now: number): Promise<void> {
  for (const source of batch.hierarchy.turbines) {
    const code = source.code.trim()
    if (maps.turbineByCode.has(code)) continue
    const turbine: Turbine = { ...source, id: createId('tbn'), code, createdAt: now, updatedAt: now }
    await db.turbines.put(turbine)
    maps.turbineByCode.set(code, turbine)
    batch.onboarded.turbineIds.push(turbine.id)
  }

  for (const source of batch.hierarchy.blades) {
    const turbine = batch.hierarchy.turbines.find((item) => item.id === source.turbineId)
    if (!turbine) continue
    const localTurbine = maps.turbineByCode.get(turbine.code.trim())
    if (!localTurbine) continue
    const key = bladeKeyOf(turbine.code, source.serial)
    if (maps.bladeByKey.has(key)) continue
    const blade: Blade = {
      ...source,
      id: createId('bld'),
      turbineId: localTurbine.id,
      createdAt: now,
      updatedAt: now
    }
    await db.blades.put(blade)
    maps.bladeByKey.set(key, blade)
    batch.onboarded.bladeIds.push(blade.id)
  }

  for (const source of batch.hierarchy.segments) {
    const packBlade = batch.hierarchy.blades.find((item) => item.id === source.bladeId)
    const packTurbine = packBlade
      ? batch.hierarchy.turbines.find((item) => item.id === packBlade.turbineId)
      : undefined
    if (!packBlade || !packTurbine) continue
    const bladeKey = bladeKeyOf(packTurbine.code, packBlade.serial)
    const segmentKey = segmentKeyOf(packTurbine.code, packBlade.serial, source.index)
    if (maps.segmentByKey.has(segmentKey)) continue
    const localBlade = maps.bladeByKey.get(bladeKey)
    if (!localBlade) continue
    const segment: Segment = {
      ...source,
      id: createId('seg'),
      bladeId: localBlade.id,
      startM: round2(source.startM),
      endM: round2(source.endM),
      createdAt: now,
      updatedAt: now
    }
    await db.segments.put(segment)
    maps.segmentByKey.set(segmentKey, segment)
    batch.onboarded.segmentIds.push(segment.id)
  }
}

/* ---------------- 整批撤回（缺陷 + 工单 + 补建坐标一起退回） ---------------- */

/**
 * 撤回已写入批次（单个事务）：
 * - 删除本批新增 / 并列新增的缺陷及其工单
 * - 被覆盖的本地缺陷恢复原值与来源清理
 * - 写入时补建、撤回后不再挂有任何缺陷 / 分段 / 叶片的坐标一并退回
 */
export async function rollbackBatch(batch: InspectionBatch): Promise<InspectionBatch> {
  if (batch.state !== '已写入') throw new Error('仅已写入台账的批次可以撤回')

  const now = Date.now()
  const next = structuredClone(toPlain(batch)) as InspectionBatch

  await db.transaction(
    'rw',
    [db.turbines, db.blades, db.segments, db.defects, db.workOrders],
    async () => {
      // 1. 删除本批写入的工单
      const orderIds = next.workOrderItems
        .filter((item) => item.status === '已写入' && item.writtenOrderId)
        .map((item) => item.writtenOrderId as string)
      if (orderIds.length > 0) await db.workOrders.bulkDelete(orderIds)

      // 2. 缺陷：新增的删除；覆盖的恢复原值
      for (const item of next.defectItems) {
        if (item.writtenAction === 'inserted' && item.writtenDefectId) {
          await db.defects.delete(item.writtenDefectId)
        } else if (item.writtenAction === 'updated' && item.writtenDefectId) {
          const current = await db.defects.get(item.writtenDefectId)
          if (current?.originalBeforeMerge) {
            const { lengthMm, widthMm, severity, face } = current.originalBeforeMerge
            await db.defects.put({
              ...current,
              lengthMm,
              widthMm,
              severity,
              face,
              sourceBatchId: undefined,
              sourceTeam: undefined,
              sourceRecordId: undefined,
              originalBeforeMerge: null,
              updatedAt: now
            })
          }
        }
      }

      // 3. 退回补建坐标：已无缺陷悬挂的分段 → 已无分段的叶片 → 已无叶片的机组
      const liveDefects = await db.defects.toArray()
      const liveSegmentIds = new Set(liveDefects.map((defect) => defect.segmentId))
      const removableSegmentIds = next.onboarded.segmentIds.filter((id) => !liveSegmentIds.has(id))
      if (removableSegmentIds.length > 0) await db.segments.bulkDelete(removableSegmentIds)

      const liveSegmentBladeIds = new Set((await db.segments.toArray()).map((segment) => segment.bladeId))
      const removableBladeIds = next.onboarded.bladeIds.filter((id) => !liveSegmentBladeIds.has(id))
      if (removableBladeIds.length > 0) await db.blades.bulkDelete(removableBladeIds)

      const liveBladeTurbineIds = new Set((await db.blades.toArray()).map((blade) => blade.turbineId))
      const removableTurbineIds = next.onboarded.turbineIds.filter((id) => !liveBladeTurbineIds.has(id))
      if (removableTurbineIds.length > 0) await db.turbines.bulkDelete(removableTurbineIds)
    }
  )

  next.defectItems.forEach((item) => {
    item.status = '已撤回'
    item.resolution = 'pending'
    item.decidedAt = undefined
    item.writtenAt = undefined
    item.writtenDefectId = undefined
    item.writtenAction = undefined
  })
  next.workOrderItems.forEach((item) => {
    if (item.status === '不录入') return
    item.status = '已撤回'
    item.writtenAt = undefined
    item.writtenOrderId = undefined
  })
  next.state = '已撤回'
  next.rolledBackAt = now
  next.committedAt = null
  next.commitError = null
  next.updatedAt = now
  next.onboarded = { turbineIds: [], bladeIds: [], segmentIds: [] }
  return next
}
