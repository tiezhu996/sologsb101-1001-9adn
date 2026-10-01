// 端到端验证离线巡检包批次合并流程（node + fake-indexeddb，不经过浏览器）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'

// 路径别名 @/* 由 Node 直接跑 TS 不识别，用相对路径
import { db, clearAllTables } from '../src/utils/db.ts'
import {
  buildLocalIndex,
  commitBatch,
  rollbackBatch,
  stageInspectionPack,
  validateInspectionPack
} from '../src/utils/inspectionMerge.ts'
import type { InspectionPack } from '../src/types/inspectionBatch.ts'
import type { Defect } from '../src/types/defect.ts'
import type { WorkOrder } from '../src/types/workOrder.ts'

const now = Date.now()

function turbine(id: string, code: string) {
  return { id, code, model: 'GW155-4.5MW', hubHeightM: 110, commissionDate: '2021-01-01', bladeCount: 1, createdAt: now, updatedAt: now }
}
function blade(id: string, turbineId: string) {
  return { id, turbineId, serial: 'A' as const, lengthM: 60, material: '玻璃纤维' as const, segmentCount: 1, createdAt: now, updatedAt: now }
}
function segment(id: string, bladeId: string) {
  return { id, bladeId, index: 1, startM: 0, endM: 60, airfoil: 'DU', face: 'PS' as const, sectionImage: '', createdAt: now, updatedAt: now }
}
function defect(partial: Partial<Defect> & { id: string; segmentId: string }): Defect {
  return {
    type: '裂纹',
    severity: '中度',
    lengthMm: 100,
    widthMm: 5,
    face: 'PS',
    positionM: 10,
    foundAt: '2026-09-01',
    state: '待处理',
    createdAt: now,
    updatedAt: now,
    ...partial
  }
}
function order(partial: Partial<WorkOrder> & { id: string; defectId: string }): WorkOrder {
  return {
    team: '外委一班',
    dueDate: '2026-10-10',
    state: '待派',
    acceptor: '',
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    ...partial
  }
}

await (async () => {
  await clearAllTables()
  // 本地台账：机组 WT-X1 + 叶片 A + 第 1 段 + 两条缺陷
  await db.turbines.put(turbine('t1', 'WT-X1'))
  await db.blades.put(blade('b1', 't1'))
  await db.segments.put(segment('s1', 'b1'))
  await db.defects.put(
    defect({
      id: 'd-same',
      segmentId: 's1',
      type: '裂纹',
      positionM: 10.2,
      lengthMm: 100,
      widthMm: 5,
      severity: '中度',
      face: 'PS'
    })
  )
  await db.defects.put(
    defect({
      id: 'd-conflict',
      segmentId: 's1',
      type: '雷击',
      positionM: 20,
      lengthMm: 200,
      widthMm: 10,
      severity: '轻度',
      face: 'PS'
    })
  )
})()

test('巡检包先进待核对批次：同一缺陷匹配与分歧并列，不写台账', async () => {
  const pack: InspectionPack = {
    app: 'gbwindblade',
    kind: 'offline-inspection-pack',
    dbVersion: 3,
    exportedAt: new Date().toISOString(),
    sourceTeam: '外委检修一班',
    turbines: [turbine('pt1', 'WT-X1')],
    blades: [blade('pb1', 'pt1')],
    segments: [segment('ps1', 'pb1')],
    defects: [
      // 与 d-same 同类型同位置、值一致
      defect({ id: 'pd-same', segmentId: 'ps1', type: '裂纹', positionM: 10.3, lengthMm: 100, widthMm: 5 }),
      // 与 d-conflict 同类型同位置、尺寸/程度/面位分歧
      defect({
        id: 'pd-conflict',
        segmentId: 'ps1',
        type: '雷击',
        positionM: 20.1,
        lengthMm: 500,
        widthMm: 30,
        severity: '重度',
        face: 'LE'
      }),
      // 新位置 → 新缺陷
      defect({ id: 'pd-new', segmentId: 'ps1', type: '砂眼', positionM: 40, lengthMm: 8, widthMm: 6 })
    ],
    workOrders: [
      order({ id: 'po1', defectId: 'pd-conflict', team: '外委一班', state: '处理中' }),
      order({ id: 'po2', defectId: 'pd-new', team: '外委一班', state: '待派' })
    ]
  }

  assert.ok(validateInspectionPack(pack).ok)
  assert.ok(!validateInspectionPack({ app: 'x' }).ok)

  const local = {
    turbines: await db.turbines.toArray(),
    blades: await db.blades.toArray(),
    segments: await db.segments.toArray(),
    defects: await db.defects.toArray()
  }
  const batch = stageInspectionPack(pack, { name: '测试批次', sourceFile: 'pack.json' }, local)

  // 暂存期间台账不增加任何缺陷 / 工单
  assert.equal(await db.defects.count(), 2)
  assert.equal(await db.workOrders.count(), 0)
  assert.equal(batch.state, '待核对')
  assert.equal(batch.defectItems.length, 3)

  const sameItem = batch.defectItems.find((i) => i.sourceDefectId === 'pd-same')!
  const conflictItem = batch.defectItems.find((i) => i.sourceDefectId === 'pd-conflict')!
  const newItem = batch.defectItems.find((i) => i.sourceDefectId === 'pd-new')!

  assert.equal(sameItem.matchKind, 'same')
  assert.equal(sameItem.localDefectId, 'd-same')
  assert.equal(sameItem.diffs.length, 0)
  assert.equal(conflictItem.matchKind, 'conflict')
  assert.equal(conflictItem.localDefectId, 'd-conflict')
  const diffKeys = conflictItem.diffs.map((d) => d.key).sort()
  assert.deepEqual(diffKeys, ['face', 'lengthMm', 'severity', 'widthMm'])
  assert.equal(newItem.matchKind, 'new')
  assert.equal(newItem.resolution, 'new')
  // 分歧项默认待核对
  assert.equal(conflictItem.resolution, 'pending')

  // 整批确认前必须给分歧结论：先确认应失败（pending 存在）
  conflictItem.resolution = 'use-incoming'
  conflictItem.status = '已确认'
  sameItem.resolution = 'keep-local'
  sameItem.status = '已确认'
  newItem.status = '已确认'
  batch.state = '已确认'

  // 持久化批次
  await db.inspectionBatches.put(batch)

  // 整批写入
  const committed = await commitBatch(batch)
  assert.equal(committed.state, '已写入', committed.commitError ?? '')
  await db.inspectionBatches.put(committed)

  // d-same 维持本地：尺寸不变，无来源戳记；现场工单（该缺陷无工单）——
  const sameAfter = await db.defects.get('d-same')
  assert.equal(sameAfter!.lengthMm, 100)
  assert.equal(sameAfter!.sourceBatchId, undefined)

  // d-conflict 被现场值覆盖，本地原值留痕、来源保留
  const conflictAfter = await db.defects.get('d-conflict')
  assert.equal(conflictAfter!.lengthMm, 500)
  assert.equal(conflictAfter!.widthMm, 30)
  assert.equal(conflictAfter!.severity, '重度')
  assert.equal(conflictAfter!.face, 'LE')
  assert.equal(conflictAfter!.sourceBatchId, committed.id)
  assert.equal(conflictAfter!.sourceTeam, '外委检修一班')
  assert.equal(conflictAfter!.sourceRecordId, 'pd-conflict')
  assert.deepEqual(conflictAfter!.originalBeforeMerge, {
    lengthMm: 200,
    widthMm: 10,
    severity: '轻度',
    face: 'PS'
  })
  // 现场工单为处理中 → 缺陷推进到已派工
  assert.equal(conflictAfter!.state, '已派工')

  // pd-new 新增为新缺陷
  const allDefects = await db.defects.toArray()
  const insertedNew = allDefects.find((d) => d.sourceRecordId === 'pd-new')
  assert.ok(insertedNew)
  assert.equal(insertedNew!.segmentId, 's1') // 坐标正确映射到本地分段
  assert.equal(insertedNew!.state, '已派工') // 跟随待派工单推进

  // 工单 2 张都写入（没有任何缺陷选择维持本地/一致跳过；d-same 无现场工单）
  const orders = await db.workOrders.toArray()
  assert.equal(orders.length, 2)
  assert.deepEqual(
    orders.map((o) => o.team).sort(),
    ['外委一班', '外委一班']
  )
  assert.ok(orders.every((o) => o.sourceBatchId === committed.id))

  // 已写入批次重复写入会被拦截，不产生重复缺陷 / 工单
  const again = await commitBatch(committed)
  assert.equal(again.state, '已写入')
  assert.ok(again.commitError)
  assert.equal(await db.workOrders.count(), 2)

  // 撤回批次：新增缺陷 + 工单退回，覆盖缺陷恢复原值
  const rolled = await rollbackBatch(committed)
  assert.equal(rolled.state, '已撤回')
  await db.inspectionBatches.put(rolled)

  assert.equal(await db.workOrders.count(), 0)
  const afterDefects = await db.defects.toArray()
  assert.equal(afterDefects.length, 2)
  assert.ok(!afterDefects.some((d) => d.sourceRecordId === 'pd-new'))
  const conflictRestored = await db.defects.get('d-conflict')
  assert.equal(conflictRestored!.lengthMm, 200)
  assert.equal(conflictRestored!.severity, '轻度')
  assert.equal(conflictRestored!.face, 'PS')
  assert.equal(conflictRestored!.originalBeforeMerge, null)
  assert.equal(conflictRestored!.sourceBatchId, undefined)
  const sameRestored = await db.defects.get('d-same')
  assert.equal(sameRestored!.state, '待处理')
})

test('现场包带本地缺失机组：写入时补建坐标，撤回时一并退回', async () => {
  await clearAllTables()
  const pack: InspectionPack = {
    app: 'gbwindblade',
    kind: 'offline-inspection-pack',
    dbVersion: 3,
    exportedAt: new Date().toISOString(),
    sourceTeam: '外委二班',
    turbines: [turbine('nt', 'WT-NEW')],
    blades: [blade('nb', 'nt')],
    segments: [segment('ns', 'nb')],
    defects: [defect({ id: 'nd1', segmentId: 'ns', positionM: 30 })],
    workOrders: []
  }
  const batch = stageInspectionPack(
    pack,
    { name: '新机组批次', sourceFile: 'n.json' },
    { turbines: [], blades: [], segments: [], defects: [] }
  )
  assert.equal(batch.defectItems[0].matchKind, 'new')
  batch.defectItems[0].status = '已确认'
  batch.state = '已确认'

  const committed = await commitBatch(batch)
  assert.equal(committed.state, '已写入', committed.commitError ?? '')
  assert.equal(await db.turbines.count(), 1)
  assert.equal(await db.blades.count(), 1)
  assert.equal(await db.segments.count(), 1)
  assert.equal(await db.defects.count(), 1)
  assert.equal(committed.onboarded.turbineIds.length, 1)

  const rolled = await rollbackBatch(committed)
  assert.equal(rolled.state, '已撤回')
  assert.equal(await db.defects.count(), 0)
  assert.equal(await db.segments.count(), 0)
  assert.equal(await db.blades.count(), 0)
  assert.equal(await db.turbines.count(), 0)
})

test('事务中途失败：整体回滚不污染台账，修正后可重试成功', async () => {
  await clearAllTables()
  await db.turbines.put(turbine('t1', 'WT-R1'))
  await db.blades.put(blade('b1', 't1'))
  await db.segments.put(segment('s1', 'b1'))
  await db.defects.put(defect({ id: 'd1', segmentId: 's1', type: '砂眼', positionM: 5 }))

  const pack: InspectionPack = {
    app: 'gbwindblade',
    kind: 'offline-inspection-pack',
    dbVersion: 3,
    exportedAt: new Date().toISOString(),
    sourceTeam: '外委三班',
    turbines: [turbine('pt1', 'WT-R1')],
    blades: [blade('pb1', 'pt1')],
    segments: [segment('ps1', 'pb1')],
    defects: [defect({ id: 'pd1', segmentId: 'ps1', type: '砂眼', positionM: 5.2, lengthMm: 900 })],
    workOrders: []
  }
  const staged = stageInspectionPack(
    pack,
    { name: '重试批次', sourceFile: 'r.json' },
    {
      turbines: await db.turbines.toArray(),
      blades: await db.blades.toArray(),
      segments: await db.segments.toArray(),
      defects: await db.defects.toArray()
    }
  )
  staged.defectItems[0].resolution = 'use-incoming'
  staged.defectItems[0].status = '已确认'
  staged.state = '已确认'

  // 人为删除被覆盖的本地缺陷，使事务在「读取原缺陷 → 留痕」阶段抛错
  await db.defects.delete('d1')
  const failed = await commitBatch(staged)
  assert.equal(failed.state, '已确认')
  assert.ok(failed.commitError)
  assert.equal(failed.commitAttempts, 1)
  // 失败不污染：没有多余缺陷落库
  assert.equal(await db.defects.count(), 0)

  // 恢复本地缺陷后重试成功
  await db.defects.put(defect({ id: 'd1', segmentId: 's1', type: '砂眼', positionM: 5 }))
  const ok = await commitBatch(failed)
  assert.equal(ok.state, '已写入', ok.commitError ?? '')
  assert.equal((await db.defects.get('d1'))!.lengthMm, 900)
})

test('buildLocalIndex 按机组编号 + 叶片序号 + 分段序号建立坐标', async () => {
  await clearAllTables()
  await db.turbines.put(turbine('t', 'WT-Z9'))
  await db.blades.put(blade('b', 't'))
  await db.segments.put(segment('s', 'b'))
  const idx = buildLocalIndex(await db.turbines.toArray(), await db.blades.toArray(), await db.segments.toArray())
  assert.ok(idx.turbineByCode.has('WT-Z9'))
  assert.ok(idx.bladeByKey.has('WT-Z9::A'))
  assert.ok(idx.segmentByKey.has('WT-Z9::A::1'))
})
