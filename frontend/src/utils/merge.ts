import { createId, db, round2, type BackupPayload } from '@/utils/db'
import {
  DEFECT_TYPES,
  SEVERITIES,
  type Defect,
  type DefectState,
  type DefectType,
  type Severity
} from '@/types/defect'
import { WORK_ORDER_STATES, type WorkOrder, type WorkOrderState } from '@/types/workOrder'
import type { Blade } from '@/types/blade'
import { SEGMENT_FACES, type Segment, type SegmentFace } from '@/types/segment'
import type {
  IncomingDefectSnapshot,
  IncomingOrderSnapshot,
  LocalDefectSnapshot,
  LocalOrderSnapshot,
  MergeBatch,
  MergeBlockReason,
  MergeConflictField,
  MergeItem,
  MergeResolution,
  MergeWrittenRecord
} from '@/types/mergeBatch'

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function todayString(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 展向位置匹配键：机组编号 + 叶片序号 + 展向位置（保留 2 位小数） */
function positionKey(turbineCode: string, bladeSerial: string, positionM: number): string {
  return `${turbineCode}#${bladeSerial}#${round2(positionM).toFixed(2)}`
}

function orderSignature(order: Pick<WorkOrder, 'team' | 'dueDate' | 'state'>): string {
  return `${order.team}|${order.dueDate}|${order.state}`
}

/* ------------------------------------------------------------------ */
/* 快照清洗：巡检包来源不可信，逐字段兜底                                */
/* ------------------------------------------------------------------ */

function sanitizeDefect(raw: unknown): IncomingDefectSnapshot {
  const obj = (raw ?? {}) as Partial<Defect>
  return {
    id: asString(obj.id),
    type: asEnum<DefectType>(obj.type, DEFECT_TYPES, '裂纹'),
    severity: asEnum<Severity>(obj.severity, SEVERITIES, '轻度'),
    lengthMm: asNumber(obj.lengthMm, 0),
    widthMm: asNumber(obj.widthMm, 0),
    face: asEnum<SegmentFace>(obj.face, SEGMENT_FACES, 'PS'),
    positionM: round2(asNumber(obj.positionM, 0)),
    foundAt: asString(obj.foundAt, todayString()),
    state: asEnum<DefectState>(obj.state, ['待处理', '已派工', '已修复'] as const, '待处理')
  }
}

function sanitizeOrder(raw: unknown): IncomingOrderSnapshot {
  const obj = (raw ?? {}) as Partial<WorkOrder>
  return {
    id: asString(obj.id),
    defectId: asString(obj.defectId),
    team: asString(obj.team, '未指派班组'),
    dueDate: asString(obj.dueDate, todayString()),
    state: asEnum<WorkOrderState>(obj.state, WORK_ORDER_STATES, '待派'),
    acceptor: asString(obj.acceptor, ''),
    closedAt: typeof obj.closedAt === 'number' ? obj.closedAt : null
  }
}

function toLocalDefectSnapshot(defect: Defect): LocalDefectSnapshot {
  return {
    id: defect.id,
    segmentId: defect.segmentId,
    type: defect.type,
    severity: defect.severity,
    lengthMm: defect.lengthMm,
    widthMm: defect.widthMm,
    face: defect.face,
    positionM: defect.positionM,
    foundAt: defect.foundAt,
    state: defect.state,
    createdAt: defect.createdAt,
    updatedAt: defect.updatedAt
  }
}

/** 尺寸、程度或面位（含类型）分歧时给出差异字段，供核对页并列高亮 */
export function diffFields(
  incoming: IncomingDefectSnapshot,
  local: LocalDefectSnapshot
): MergeConflictField[] {
  const fields: MergeConflictField[] = []
  if (incoming.type !== local.type) fields.push('type')
  if (incoming.severity !== local.severity) fields.push('severity')
  if (asNumber(incoming.lengthMm) !== asNumber(local.lengthMm)) fields.push('lengthMm')
  if (asNumber(incoming.widthMm) !== asNumber(local.widthMm)) fields.push('widthMm')
  if (incoming.face !== local.face) fields.push('face')
  return fields
}

/* ------------------------------------------------------------------ */
/* 导入巡检包 → 生成待核对批次（不写台账）                               */
/* ------------------------------------------------------------------ */

export interface IngestResult {
  batch: MergeBatch
  newCount: number
  sameCount: number
  conflictCount: number
  unlocatableCount: number
}

/**
 * 解析巡检包并生成「待核对批次」。
 * 匹配规则：机组编号 + 叶片序号 + 展向位置；只建批次与差异清单，绝不触碰台账。
 */
export async function ingestMergeBatch(
  payload: BackupPayload,
  sourceName: string
): Promise<IngestResult> {
  const [turbines, blades, segments, localDefects, localOrders] = await Promise.all([
    db.turbines.toArray(),
    db.blades.toArray(),
    db.segments.toArray(),
    db.defects.toArray(),
    db.workOrders.toArray()
  ])

  /* ---- 本地台账解析链 ---- */
  const localTurbineByCode = new Map(turbines.map((turbine) => [turbine.code, turbine]))
  const localBladeByTurbine = new Map<string, Blade>()
  blades.forEach((blade) => localBladeByTurbine.set(`${blade.turbineId}#${blade.serial}`, blade))
  const localSegmentsByBlade = new Map<string, Segment[]>()
  segments.forEach((segment) => {
    const list = localSegmentsByBlade.get(segment.bladeId) ?? []
    list.push(segment)
    localSegmentsByBlade.set(segment.bladeId, list)
  })
  const localSegmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const localBladeById = new Map(blades.map((blade) => [blade.id, blade]))
  const localTurbineById = new Map(turbines.map((turbine) => [turbine.id, turbine]))
  const localOrdersByDefect = new Map<string, WorkOrder[]>()
  localOrders.forEach((order) => {
    const list = localOrdersByDefect.get(order.defectId) ?? []
    list.push(order)
    localOrdersByDefect.set(order.defectId, list)
  })

  /** 本地缺陷按匹配键分组（同一位置多条时按顺序 1:1 配对） */
  const localGroups = new Map<string, Defect[]>()
  localDefects.forEach((defect) => {
    const segment = localSegmentById.get(defect.segmentId)
    const blade = segment ? localBladeById.get(segment.bladeId) : undefined
    const turbine = blade ? localTurbineById.get(blade.turbineId) : undefined
    if (!segment || !blade || !turbine) return
    const key = positionKey(turbine.code, blade.serial, defect.positionM)
    const list = localGroups.get(key) ?? []
    list.push(defect)
    localGroups.set(key, list)
  })

  /* ---- 巡检包内部解析链 ---- */
  const pkgSegmentById = new Map(payload.segments.map((segment) => [segment.id, segment]))
  const pkgBladeById = new Map(payload.blades.map((blade) => [blade.id, blade]))
  const pkgTurbineById = new Map(payload.turbines.map((turbine) => [turbine.id, turbine]))
  const pkgDefectById = new Map(payload.defects.map((defect) => [defect.id, defect]))
  const pkgOrdersByDefect = new Map<string, IncomingOrderSnapshot[]>()
  payload.workOrders.forEach((raw) => {
    const order = sanitizeOrder(raw)
    if (!order.defectId) return
    const list = pkgOrdersByDefect.get(order.defectId) ?? []
    list.push(order)
    pkgOrdersByDefect.set(order.defectId, list)
  })

  const items: MergeItem[] = []
  let newCount = 0
  let sameCount = 0
  let conflictCount = 0
  let unlocatableCount = 0

  const incomingDefects = payload.defects
    .map((raw) => sanitizeDefect(raw))
    .filter((defect) => defect.id.length > 0)
    .sort((a, b) => a.positionM - b.positionM)

  incomingDefects.forEach((incoming) => {
    const rawDefect = pkgDefectById.get(incoming.id)
    const pkgSegment = rawDefect ? pkgSegmentById.get(rawDefect.segmentId) : undefined
    const pkgBlade = pkgSegment ? pkgBladeById.get(pkgSegment.bladeId) : undefined
    const pkgTurbine = pkgBlade ? pkgTurbineById.get(pkgBlade.turbineId) : undefined
    const turbineCode = pkgTurbine?.code ?? ''
    const bladeSerial = pkgBlade?.serial ?? ''

    const incomingOrders = pkgOrdersByDefect.get(incoming.id) ?? []

    // 按机组编号 + 叶片序号定位台账机组 / 叶片 / 展向分段
    const turbine = turbineCode ? localTurbineByCode.get(turbineCode) : undefined
    const blade = turbine
      ? localBladeByTurbine.get(`${turbine.id}#${bladeSerial}`)
      : undefined
    const bladeSegments = blade ? localSegmentsByBlade.get(blade.id) ?? [] : []
    const targetSegment =
      bladeSegments
        .filter((segment) => incoming.positionM >= segment.startM && incoming.positionM <= segment.endM)
        .sort((a, b) => a.startM - b.startM)[0] ?? null

    let kind: MergeItem['kind']
    let local: LocalDefectSnapshot | null = null
    let localOrders: LocalOrderSnapshot[] = []
    let conflictFields: MergeConflictField[] = []
    let reason: string | null = null

    if (!pkgSegment || !pkgBlade || !pkgTurbine) {
      kind = 'unlocatable'
      reason = '巡检包内缺少该缺陷对应的分段 / 叶片 / 机组记录'
    } else if (!turbine) {
      kind = 'unlocatable'
      reason = `本地台账无机组编号「${turbineCode || '未知'}」，请先在机组合账建档`
    } else if (!blade) {
      kind = 'unlocatable'
      reason = `机组 ${turbineCode} 下没有叶片 ${bladeSerial}`
    } else if (!targetSegment) {
      kind = 'unlocatable'
      reason = `叶片 ${bladeSerial} 上没有覆盖展向位置 ${incoming.positionM} m 的分段`
    } else {
      // 同一位置可能有多条缺陷：取走该位置组尚未配对的首条本地缺陷
      const group = localGroups.get(positionKey(turbineCode, bladeSerial, incoming.positionM))
      const matched = group?.shift()
      if (!matched) {
        kind = 'new'
      } else {
        local = toLocalDefectSnapshot(matched)
        localOrders = (localOrdersByDefect.get(matched.id) ?? []).map((order) => ({
          id: order.id,
          defectId: order.defectId,
          team: order.team,
          dueDate: order.dueDate,
          state: order.state,
          acceptor: order.acceptor,
          closedAt: order.closedAt
        }))
        conflictFields = diffFields(incoming, local)
        kind = conflictFields.length > 0 ? 'conflict' : 'same'
      }
    }

    if (kind === 'new') newCount += 1
    else if (kind === 'same') sameCount += 1
    else if (kind === 'conflict') conflictCount += 1
    else unlocatableCount += 1

    items.push({
      id: createId('mgi'),
      kind,
      resolution: kind === 'unlocatable' ? 'skip' : defaultResolutionByKind(kind),
      incoming,
      incomingOrders,
      local,
      localOrders,
      conflictFields,
      target: {
        turbineCode: turbineCode || '未知',
        bladeSerial: bladeSerial || '—',
        positionM: incoming.positionM,
        segmentId: targetSegment?.id ?? null
      },
      reason,
      writeState: '待写入',
      error: null,
      written: null
    })
  })

  const now = Date.now()
  const batch: MergeBatch = {
    id: createId('mgb'),
    sourceName,
    state: '待核对',
    importedAt: now,
    committedAt: null,
    withdrawnAt: null,
    sourceDefectCount: incomingDefects.length,
    sourceWorkOrderCount: payload.workOrders.length,
    lastError: null,
    items,
    createdAt: now,
    updatedAt: now
  }
  await db.mergeBatches.put(batch)

  return { batch, newCount, sameCount, conflictCount, unlocatableCount }
}

function defaultResolutionByKind(kind: MergeItem['kind']): MergeResolution {
  switch (kind) {
    case 'new':
      return 'incoming'
    case 'same':
      return 'local'
    case 'conflict':
      return 'both'
    case 'unlocatable':
      return 'skip'
  }
}

/* ------------------------------------------------------------------ */
/* 整批确认写入                                                        */
/* ------------------------------------------------------------------ */

export interface CommitResult {
  ok: boolean
  state: MergeBatch['state']
  writtenItems: number
  skippedItems: number
  failedItems: number
  createdDefects: number
  createdOrders: number
  errors: string[]
}

interface CommitPlan {
  item: MergeItem
  segment: Segment
}

/** 现场带来的工单反推缺陷状态 */
function stateFromOrders(
  orders: IncomingOrderSnapshot[],
  fallback: DefectState
): DefectState {
  if (orders.length === 0) return fallback
  return orders.every((order) => order.state === '已闭环') ? '已修复' : '已派工'
}

/** 整批确认写入；任何条目写不进去都会被标出，批次可修正后重试 */
export async function commitMergeBatch(batchId: string): Promise<CommitResult> {
  const batch = await db.mergeBatches.get(batchId)
  if (!batch) {
    return {
      ok: false,
      state: '待核对',
      writtenItems: 0,
      skippedItems: 0,
      failedItems: 0,
      createdDefects: 0,
      createdOrders: 0,
      errors: ['批次不存在或已被删除']
    }
  }
  if (batch.state !== '待核对' && batch.state !== '写入失败') {
    return {
      ok: false,
      state: batch.state,
      writtenItems: 0,
      skippedItems: 0,
      failedItems: 0,
      createdDefects: 0,
      createdOrders: 0,
      errors: [`批次当前为「${batch.state}」，不能写入`]
    }
  }

  const [turbines, blades, segments, defects, orders] = await Promise.all([
    db.turbines.toArray(),
    db.blades.toArray(),
    db.segments.toArray(),
    db.defects.toArray(),
    db.workOrders.toArray()
  ])
  const turbineByCode = new Map(turbines.map((turbine) => [turbine.code, turbine]))
  const bladeByTurbineSerial = new Map(blades.map((blade) => [`${blade.turbineId}#${blade.serial}`, blade]))
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const defectById = new Map(defects.map((defect) => [defect.id, defect]))
  const ordersByDefect = new Map<string, WorkOrder[]>()
  orders.forEach((order) => {
    const list = ordersByDefect.get(order.defectId) ?? []
    list.push(order)
    ordersByDefect.set(order.defectId, list)
  })

  /* ---- 重试前重置上轮失败 / 未写入条目的状态（已写入条目幂等保留） ---- */
  batch.items.forEach((item) => {
    if (item.writeState === '写入失败' || item.writeState === '待写入') {
      item.writeState = '待写入'
      item.error = null
    }
  })

  /* ---- 阶段 A：逐条复核解析，失败条目标错但不阻断其余条目 ---- */
  const plans: CommitPlan[] = []
  const errors: string[] = []
  let skippedItems = 0

  batch.items.forEach((item) => {
    item.error = null
    if (item.writeState === '已写入') {
      // 重试幂等：上一批已成功落库的条目不重复写入
      return
    }
    if (item.resolution === 'skip' || item.kind === 'unlocatable') {
      // 跳过 / 无法定位不写台账；整批确认时仅登记为「已跳过」
      item.resolution = 'skip'
      item.writeState = '已跳过'
      skippedItems += 1
      return
    }
    const turbine = turbineByCode.get(item.target.turbineCode)
    const blade = turbine
      ? bladeByTurbineSerial.get(`${turbine.id}#${item.target.bladeSerial}`)
      : undefined
    const segment =
      item.target.segmentId ? segmentById.get(item.target.segmentId) : undefined
    const segValid =
      segment && blade && segment.bladeId === blade.id &&
      item.incoming.positionM >= segment.startM &&
      item.incoming.positionM <= segment.endM
        ? segment
        : undefined

    const liveLocal = item.local ? defectById.get(item.local.id) ?? null : null

    if (!turbine) {
      item.writeState = '写入失败'
      item.error = `台账缺少机组「${item.target.turbineCode}」`
    } else if (!blade) {
      item.writeState = '写入失败'
      item.error = `机组 ${item.target.turbineCode} 缺少叶片 ${item.target.bladeSerial}`
    } else if (!segValid) {
      item.writeState = '写入失败'
      item.error = `叶片 ${item.target.bladeSerial} 缺少覆盖 ${item.target.positionM} m 的展向分段`
    } else if (item.local && !liveLocal) {
      item.writeState = '写入失败'
      item.error = '原匹配的台账缺陷已不存在，请撤回该结论改为新增或跳过'
    } else {
      plans.push({ item, segment: segValid })
      return
    }
    errors.push(`${item.target.turbineCode} 叶片${item.target.bladeSerial} ${item.incoming.positionM}m ${item.incoming.type}：${item.error}`)
  })

  const failedItems = batch.items.filter((item) => item.writeState === '写入失败').length

  if (plans.length === 0) {
    const now = Date.now()
    if (failedItems > 0) {
      batch.state = '写入失败'
      batch.lastError = errors[0] ?? '部分条目无法写入'
      batch.updatedAt = now
      await db.mergeBatches.put(batch)
      return {
        ok: false,
        state: '写入失败',
        writtenItems: 0,
        skippedItems,
        failedItems,
        createdDefects: 0,
        createdOrders: 0,
        errors
      }
    }
    // 全部条目均为跳过：不落任何台账数据，仅把批次标记为已确认
    batch.state = '已确认'
    batch.committedAt = now
    batch.lastError = null
    batch.updatedAt = now
    await db.mergeBatches.put(batch)
    return {
      ok: true,
      state: '已确认',
      writtenItems: 0,
      skippedItems,
      failedItems: 0,
      createdDefects: 0,
      createdOrders: 0,
      errors: []
    }
  }

  /* ---- 阶段 B：事务内整批落库，失败整体回滚并可重试 ---- */
  const defectsToPut: Defect[] = []
  const ordersToPut: WorkOrder[] = []
  let createdDefects = 0
  let createdOrders = 0
  let writtenItems = 0

  try {
    await db.transaction(
      'rw',
      [db.defects, db.workOrders, db.mergeBatches],
      async () => {
        for (const plan of plans) {
          const { item, segment } = plan
          const now = Date.now()
          const incoming = item.incoming
          // 事务内重新读取，确保拿到最新工单用于去重
          const existingOrders = liveLocalOrders(item, defectById, ordersByDefect)
          const existingSignatures = new Set(existingOrders.map(orderSignature))

          const attachOrders: Array<{ order: IncomingOrderSnapshot; defectId: string }> = []
          item.incomingOrders.forEach((order) => {
            if (!existingSignatures.has(orderSignature(order))) {
              existingSignatures.add(orderSignature(order))
              attachOrders.push({ order, defectId: '' })
            }
          })

          let targetDefectId: string
          let record: MergeWrittenRecord

          if (item.kind === 'new' || item.resolution === 'both') {
            // 新增 / 并列保留：现场记录作为新缺陷入台账，原值随 provenance 留存
            const defectId = createId('dfc')
            targetDefectId = defectId
            const derivedState = stateFromOrders(item.incomingOrders, incoming.state)
            defectsToPut.push({
              id: defectId,
              segmentId: segment.id,
              type: incoming.type,
              severity: incoming.severity,
              lengthMm: incoming.lengthMm,
              widthMm: incoming.widthMm,
              face: incoming.face,
              positionM: incoming.positionM,
              foundAt: incoming.foundAt,
              state: derivedState,
              provenance: {
                batchId: batch.id,
                sourceName: batch.sourceName,
                sourceRecordId: incoming.id,
                original: {
                  type: incoming.type,
                  severity: incoming.severity,
                  lengthMm: incoming.lengthMm,
                  widthMm: incoming.widthMm,
                  face: incoming.face,
                  positionM: incoming.positionM,
                  foundAt: incoming.foundAt,
                  state: incoming.state
                },
                mergedAt: now
              },
              createdAt: now,
              updatedAt: now
            })
            createdDefects += 1
            record = {
              writtenAt: now,
              localDefectId: item.local?.id ?? null,
              incomingDefectId: defectId,
              replacedDefectId: null,
              localKept: false,
              createdOrderIds: [],
              preExistingOrderIds: existingOrders.map((order) => order.id),
              localDefectSnapshot: item.local ? toLocalDefectSnapshot(defectById.get(item.local.id) as Defect) : null
            }
          } else {
            // same / conflict 下的 incoming（覆盖）或 local（保留台账），目标都是既有缺陷
            const localDefect = (item.local ? defectById.get(item.local.id) : null) as Defect
            targetDefectId = localDefect.id
            const snapshot = toLocalDefectSnapshot(localDefect)
            if (item.resolution === 'incoming') {
              const derivedState = stateFromOrders(item.incomingOrders, incoming.state)
              defectsToPut.push({
                ...localDefect,
                segmentId: segment.id,
                type: incoming.type,
                severity: incoming.severity,
                lengthMm: incoming.lengthMm,
                widthMm: incoming.widthMm,
                face: incoming.face,
                positionM: incoming.positionM,
                foundAt: incoming.foundAt,
                state: derivedState,
                provenance: {
                  batchId: batch.id,
                  sourceName: batch.sourceName,
                  sourceRecordId: incoming.id,
                  original: {
                    type: incoming.type,
                    severity: incoming.severity,
                    lengthMm: incoming.lengthMm,
                    widthMm: incoming.widthMm,
                    face: incoming.face,
                    positionM: incoming.positionM,
                    foundAt: incoming.foundAt,
                    state: incoming.state
                  },
                  mergedAt: now
                },
                updatedAt: now
              })
              record = {
                writtenAt: now,
                localDefectId: localDefect.id,
                incomingDefectId: null,
                replacedDefectId: localDefect.id,
                localKept: false,
                createdOrderIds: [],
                preExistingOrderIds: existingOrders.map((order) => order.id),
                localDefectSnapshot: snapshot
              }
            } else {
              // local：保留台账原值，仅补挂现场带来的工单
              record = {
                writtenAt: now,
                localDefectId: localDefect.id,
                incomingDefectId: null,
                replacedDefectId: null,
                localKept: true,
                createdOrderIds: [],
                preExistingOrderIds: existingOrders.map((order) => order.id),
                localDefectSnapshot: null
              }
            }
          }

          attachOrders.forEach(({ order }) => {
            const orderId = createId('wo')
            ordersToPut.push({
              id: orderId,
              defectId: targetDefectId,
              team: order.team,
              dueDate: order.dueDate,
              state: order.state,
              acceptor: order.acceptor,
              closedAt: order.closedAt,
              provenance: {
                batchId: batch.id,
                sourceName: batch.sourceName,
                sourceRecordId: order.id,
                mergedAt: now
              },
              createdAt: now,
              updatedAt: now
            })
            record.createdOrderIds.push(orderId)
            createdOrders += 1
          })

          item.writeState = '已写入'
          item.error = null
          item.written = record
          writtenItems += 1
        }

        const now = Date.now()
        batch.state = '已确认'
        batch.committedAt = now
        batch.lastError = null
        batch.updatedAt = now

        if (defectsToPut.length > 0) await db.defects.bulkPut(defectsToPut)
        if (ordersToPut.length > 0) await db.workOrders.bulkPut(ordersToPut)
        await db.mergeBatches.put(batch)
      }
    )
  } catch (error) {
    // 事务已整体回滚：台账未变；重新读取批次后仅标记失败状态，允许修正后重试
    const message = error instanceof Error ? error.message : '写入过程中发生未知错误'
    const reloaded = await db.mergeBatches.get(batchId)
    const failedBatch: MergeBatch = reloaded ?? batch
    failedBatch.items.forEach((item) => {
      if (item.writeState === '待写入') {
        item.writeState = '写入失败'
        item.error = message
      }
    })
    failedBatch.state = '写入失败'
    failedBatch.lastError = message
    failedBatch.updatedAt = Date.now()
    await db.mergeBatches.put(failedBatch)
    return {
      ok: false,
      state: '写入失败',
      writtenItems: 0,
      skippedItems: failedBatch.items.filter((item) => item.writeState === '已跳过').length,
      failedItems: failedBatch.items.filter((item) => item.writeState === '写入失败').length,
      createdDefects: 0,
      createdOrders: 0,
      errors: [message, ...errors]
    }
  }

  return {
    ok: true,
    state: '已确认',
    writtenItems,
    skippedItems,
    failedItems: batch.items.filter((item) => item.writeState === '写入失败').length,
    createdDefects,
    createdOrders,
    errors
  }
}

function liveLocalOrders(
  item: MergeItem,
  defectById: Map<string, Defect>,
  ordersByDefect: Map<string, WorkOrder[]>
): WorkOrder[] {
  if (!item.local) return []
  const live = defectById.get(item.local.id)
  if (!live) return []
  return ordersByDefect.get(live.id) ?? []
}

/* ------------------------------------------------------------------ */
/* 撤回批次：同步退回缺陷与工单                                         */
/* ------------------------------------------------------------------ */

export interface WithdrawResult {
  ok: boolean
  blockers: MergeBlockReason[]
  withdrawnItems?: number
  deletedDefects?: number
  deletedOrders?: number
}

/** 撤回前置检查：合并后的后续进度（新建工单 / 闭环）会阻断撤回，避免误删现场数据 */
export async function checkWithdrawBlockers(batchId: string): Promise<MergeBlockReason[]> {
  const batch = await db.mergeBatches.get(batchId)
  if (!batch || batch.state !== '已确认') return []
  const [orders, defects] = await Promise.all([db.workOrders.toArray(), db.defects.toArray()])
  const defectById = new Map(defects.map((defect) => [defect.id, defect]))
  const blockers: MergeBlockReason[] = []

  batch.items.forEach((item) => {
    const written = item.written
    if (!written) return
    const locate = `${item.target.turbineCode} 叶片${item.target.bladeSerial} ${item.target.positionM}m`

    if (written.incomingDefectId) {
      // 并列保留 / 新增写入的缺陷：合并后又新建的台账工单不允许随批次删除
      const foreignOrders = orders.filter(
        (order) =>
          order.defectId === written.incomingDefectId &&
          !written.createdOrderIds.includes(order.id)
      )
      if (foreignOrders.length > 0) {
        blockers.push({
          itemId: item.id,
          type: 'order-created-after-merge',
          message: `${locate} 的现场缺陷在合并后新增了 ${foreignOrders.length} 张工单，请先在工单页处理`
        })
      } else if (defectById.get(written.incomingDefectId)?.state === '已修复') {
        blockers.push({
          itemId: item.id,
          type: 'defect-closed-after-merge',
          message: `${locate} 的现场缺陷已验收修复，撤回会删除修复记录`
        })
      }
    }

    if (
      written.replacedDefectId &&
      written.localDefectSnapshot &&
      defectById.get(written.replacedDefectId)?.state === '已修复' &&
      written.localDefectSnapshot.state !== '已修复'
    ) {
      // 覆盖写入的缺陷在合并后完成了闭环验收，撤回会把状态还原回合并前
      blockers.push({
        itemId: item.id,
        type: 'defect-closed-after-merge',
        message: `${locate} 的台账缺陷在覆盖写入后已验收修复，不能还原为合并前状态`
      })
    }

    if (written.localKept && written.localDefectId) {
      // 仅补挂工单的台账缺陷：合并前已有的工单与本次补挂工单均可退回，
      // 只有合并后又新建的工单才会阻断撤回
      const foreignOrders = orders.filter(
        (order) =>
          order.defectId === written.localDefectId &&
          !written.createdOrderIds.includes(order.id) &&
          !written.preExistingOrderIds.includes(order.id)
      )
      if (foreignOrders.length > 0) {
        blockers.push({
          itemId: item.id,
          type: 'order-created-after-merge',
          message: `${locate} 的台账缺陷在合并后又新增了 ${foreignOrders.length} 张工单，不能撤回补挂的工单`
        })
      }
    }
  })
  return blockers
}

/** 撤回已确认批次：删除合并写入的缺陷 / 工单，还原被覆盖的台账原值 */
export async function withdrawMergeBatch(batchId: string): Promise<WithdrawResult> {
  const batch = await db.mergeBatches.get(batchId)
  if (!batch) {
    return { ok: false, blockers: [{ itemId: '', type: 'turbine-missing', message: '批次不存在' }] }
  }
  if (batch.state !== '已确认') {
    return {
      ok: false,
      blockers: [
        {
          itemId: '',
          type: 'turbine-missing',
          message: `批次当前为「${batch.state}」，只有已确认批次可以撤回`
        }
      ]
    }
  }

  const blockers = await checkWithdrawBlockers(batchId)
  if (blockers.length > 0) return { ok: false, blockers }

  let withdrawnItems = 0
  let deletedDefects = 0
  let deletedOrders = 0

  await db.transaction(
    'rw',
    [db.defects, db.workOrders, db.mergeBatches],
    async () => {
      for (const item of batch.items) {
        const written = item.written
        if (!written) {
          // 新增 / 同一 / 分歧的跳过条目无台账变更，仅随批次回到「已撤回」
          if (item.writeState === '已写入' || item.writeState === '已跳过') item.writeState = '已撤回'
          continue
        }

        if (written.createdOrderIds.length > 0) {
          await db.workOrders.bulkDelete(written.createdOrderIds)
          deletedOrders += written.createdOrderIds.length
        }

        if (written.incomingDefectId) {
          await db.defects.delete(written.incomingDefectId)
          deletedDefects += 1
        }

        if (written.replacedDefectId && written.localDefectSnapshot) {
          const snapshot = written.localDefectSnapshot
          await db.defects.update(written.replacedDefectId, {
            segmentId: snapshot.segmentId,
            type: snapshot.type,
            severity: snapshot.severity,
            lengthMm: snapshot.lengthMm,
            widthMm: snapshot.widthMm,
            face: snapshot.face,
            positionM: snapshot.positionM,
            foundAt: snapshot.foundAt,
            state: snapshot.state,
            provenance: undefined,
            updatedAt: Date.now()
          })
        }

        item.writeState = '已撤回'
        item.written = null
        item.error = null
        withdrawnItems += 1
      }

      const now = Date.now()
      batch.state = '已撤回'
      batch.withdrawnAt = now
      batch.lastError = null
      batch.updatedAt = now
      await db.mergeBatches.put(batch)
    }
  )

  return { ok: true, blockers: [], withdrawnItems, deletedDefects, deletedOrders }
}

/* ------------------------------------------------------------------ */
/* 批次维护                                                            */
/* ------------------------------------------------------------------ */

/** 修改单条核对结论（分歧并列保留 / 以现场为准 / 保留台账 / 不写入） */
export async function setMergeItemResolution(
  batchId: string,
  itemId: string,
  resolution: MergeResolution
): Promise<void> {
  const batch = await db.mergeBatches.get(batchId)
  if (!batch) return
  if (batch.state !== '待核对' && batch.state !== '写入失败') return
  const item = batch.items.find((entry) => entry.id === itemId)
  if (!item) return
  const allowed =
    item.kind === 'new'
      ? ['incoming', 'skip']
      : item.kind === 'same'
        ? ['local', 'incoming', 'skip']
        : item.kind === 'conflict'
          ? ['both', 'incoming', 'local', 'skip']
          : ['skip']
  if (!allowed.includes(resolution)) return
  item.resolution = resolution
  batch.updatedAt = Date.now()
  await db.mergeBatches.put(batch)
}

/** 删除批次：待核对（确认前不写台账）与已撤回（台账已退回）可直接删除 */
export async function deleteMergeBatch(batchId: string): Promise<void> {
  const batch = await db.mergeBatches.get(batchId)
  if (!batch) return
  if (batch.state !== '待核对' && batch.state !== '已撤回' && batch.state !== '写入失败') {
    throw new Error('已确认批次请先撤回，再删除批次记录')
  }
  await db.mergeBatches.delete(batchId)
}

/* ------------------------------------------------------------------ */
/* 示例巡检包：供集控室演示「无网机位导出 → 集控室合并」全流程            */
/* ------------------------------------------------------------------ */

/** 基于当前台账首台机组构造一份带分歧 / 新增缺陷的示例外委巡检包 */
export async function buildSampleInspectionPackage(): Promise<{ payload: BackupPayload; sourceName: string }> {
  const [turbines, blades, segments, defects, workOrders] = await Promise.all([
    db.turbines.toArray(),
    db.blades.toArray(),
    db.segments.toArray(),
    db.defects.toArray(),
    db.workOrders.toArray()
  ])
  if (turbines.length === 0) {
    throw new Error('本地暂无机组台账，请先生成演示数据后再导出示例巡检包')
  }

  const turbine = turbines[0]
  const blade = blades
    .filter((item) => item.turbineId === turbine.id)
    .sort((a, b) => a.serial.localeCompare(b.serial))[0]
  if (!blade) throw new Error('首台机组缺少叶片记录，无法构造示例巡检包')
  const bladeSegments = segments
    .filter((segment) => segment.bladeId === blade.id)
    .sort((a, b) => a.index - b.index)
  if (bladeSegments.length === 0) throw new Error('首片叶片缺少展向分段，无法构造示例巡检包')

  const clone = <T>(value: T): T => structuredClone(value)
  const pkgTurbines = turbines.filter((item) => item.id === turbine.id).map(clone)
  const pkgBlades = blades.filter((item) => item.turbineId === turbine.id).map(clone)
  const bladeIds = new Set(pkgBlades.map((item) => item.id))
  const pkgSegments = segments.filter((segment) => bladeIds.has(segment.bladeId)).map(clone)
  const segmentIds = new Set(pkgSegments.map((item) => item.id))
  const pkgDefects = defects.filter((defect) => segmentIds.has(defect.segmentId)).map(clone)
  const pkgDefectIds = new Set(pkgDefects.map((item) => item.id))
  const pkgOrders = workOrders.filter((order) => pkgDefectIds.has(order.defectId)).map(clone)

  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
  const faceCycle: SegmentFace[] = ['PS', 'SS', 'LE', 'TE']

  // 1) 分歧缺陷：取一条既有缺陷，现场复测尺寸变大且面位不同（保持同位置以命中匹配）
  const conflictBase = pkgDefects[0]
  if (conflictBase) {
    conflictBase.lengthMm = Math.round(conflictBase.lengthMm * 1.35)
    conflictBase.widthMm = Math.round(conflictBase.widthMm * 1.5)
    conflictBase.severity = '重度'
    conflictBase.face =
      faceCycle[(faceCycle.indexOf(conflictBase.face) + 1) % faceCycle.length]
    // 现场为该缺陷补派一张工单
    pkgOrders.push({
      id: createId('wo-pkg'),
      defectId: conflictBase.id,
      team: '外委复材检修队',
      dueDate: today,
      state: '待派',
      acceptor: '',
      closedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }

  // 2) 新增缺陷：落在某分段内、错开已有展向位置
  const targetSegment = bladeSegments[0]
  const usedPositions = new Set(
    pkgDefects
      .filter((defect) => defect.segmentId === targetSegment.id)
      .map((defect) => round2(defect.positionM).toFixed(2))
  )
  let candidate = round2(targetSegment.startM + (targetSegment.endM - targetSegment.startM) * 0.82)
  if (usedPositions.has(candidate.toFixed(2))) {
    candidate = round2(targetSegment.startM + (targetSegment.endM - targetSegment.startM) * 0.15)
  }
  const newDefectId = createId('dfc-pkg')
  pkgDefects.push({
    id: newDefectId,
    segmentId: targetSegment.id,
    type: '雷击',
    severity: '中度',
    lengthMm: 210,
    widthMm: 130,
    face: 'LE',
    positionM: candidate,
    foundAt: today,
    state: '待处理',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const payload: BackupPayload = {
    app: 'gbwindblade',
    dbVersion: 3,
    exportedAt: new Date().toISOString(),
    turbines: pkgTurbines,
    blades: pkgBlades,
    segments: pkgSegments,
    defects: pkgDefects,
    workOrders: pkgOrders,
    mergeBatches: []
  }
  const sourceName = `外委巡检包-${turbine.code}-叶片${blade.serial}-${today.replace(/-/g, '')}.json`
  return { payload, sourceName }
}
