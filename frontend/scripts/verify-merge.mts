// 端到端验证：种子台账 → 构造现场包（含同一/分歧/新增/无法定位）
// → 导入待核对批次（台账不变）→ 整批写入（来源与原值保留）→ 撤回（缺陷工单同步退回）
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {
  db,
  seedDemoData,
  type BackupPayload
} from '../src/utils/db.ts'
import {
  buildSampleInspectionPackage,
  checkWithdrawBlockers,
  commitMergeBatch,
  ingestMergeBatch,
  withdrawMergeBatch
} from '../src/utils/merge.ts'

let passed = 0
function ok(name: string, cond: boolean) {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function main() {
  await seedDemoData()
  const defectsBefore = await db.defects.count()
  const ordersBefore = await db.workOrders.count()
  assert.ok(defectsBefore > 0, '应有播种缺陷')

  // 1) 构造并导出现场巡检包（含 1 条分歧 + 1 条新增）
  const { payload, sourceName } = await buildSampleInspectionPackage()
  console.log(`\n[1] 现场包 ${sourceName}：缺陷 ${payload.defects.length} 工单 ${payload.workOrders.length}`)

  // 2) 再加一条指向不存在机组的缺陷，验证「无法定位」
  const pkgSegment = payload.segments[0]
  payload.turbines.push(structuredClone(payload.turbines[0]))
  const ghostTurbineId = 'tbn-ghost'
  payload.turbines[payload.turbines.length - 1].id = ghostTurbineId
  payload.turbines[payload.turbines.length - 1].code = 'WT-Z99'
  payload.blades.push(structuredClone(payload.blades[0]))
  const ghostBladeId = 'bld-ghost'
  payload.blades[payload.blades.length - 1].id = ghostBladeId
  payload.blades[payload.blades.length - 1].turbineId = ghostTurbineId
  payload.segments.push(structuredClone(pkgSegment))
  payload.segments[payload.segments.length - 1].id = 'seg-ghost'
  payload.segments[payload.segments.length - 1].bladeId = ghostBladeId
  payload.defects.push({
    id: 'dfc-ghost',
    segmentId: 'seg-ghost',
    type: '砂眼',
    severity: '轻度',
    lengthMm: 9,
    widthMm: 7,
    face: 'PS',
    positionM: 5,
    foundAt: '2026-09-30',
    state: '待处理',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  // 3) 导入 → 待核对批次，台账数量必须不变
  const ingest = await ingestMergeBatch(payload, sourceName)
  const batchId = ingest.batch.id
  console.log(
    `[2] 批次生成：新增 ${ingest.newCount} 同一 ${ingest.sameCount} 分歧 ${ingest.conflictCount} 无法定位 ${ingest.unlocatableCount}`
  )
  ok('存在分歧条目（尺寸/程度/面位）', ingest.conflictCount >= 1)
  ok('存在新增条目', ingest.newCount >= 1)
  ok('存在无法定位条目（机组 WT-Z99）', ingest.unlocatableCount >= 1)
  ok('确认前不写台账：缺陷数不变', (await db.defects.count()) === defectsBefore)
  ok('确认前不写台账：工单数不变', (await db.workOrders.count()) === ordersBefore)

  const batch = await db.mergeBatches.get(batchId)
  assert.ok(batch)
  ok('批次状态为待核对', batch.state === '待核对')
  const conflictItem = batch.items.find((i) => i.kind === 'conflict')
  assert.ok(conflictItem)
  ok('分歧默认并列保留', conflictItem.resolution === 'both')
  ok('分歧至少标出尺寸/程度/面位中的一项', conflictItem.conflictFields.length >= 1)
  const ghostItem = batch.items.find((i) => i.kind === 'unlocatable')
  assert.ok(ghostItem)
  ok('无法定位条目不写入', ghostItem.resolution === 'skip')

  // 4) 整批写入
  const result = await commitMergeBatch(batchId)
  console.log(
    `[3] 整批写入：ok=${result.ok} 落库 ${result.writtenItems} 跳过 ${result.skippedItems} 新增缺陷 ${result.createdDefects} 新增工单 ${result.createdOrders}`
  )
  ok('整批写入成功', result.ok)
  ok('无法定位条目被跳过', result.skippedItems >= 1)
  ok('新增缺陷数 ≥ 2（新增 + 分歧并列）', result.createdDefects >= 2)
  ok('现场工单随包写入', result.createdOrders >= 1)

  const committed = await db.mergeBatches.get(batchId)
  assert.ok(committed)
  ok('批次状态为已确认', committed.state === '已确认')

  // 台账：新增缺陷带 provenance（来源 + 原值）
  const created = await db.defects.where('id').anyOf(
    committed.items
      .map((i) => i.written?.incomingDefectId)
      .filter((v): v is string => Boolean(v))
  ).toArray()
  ok('并列/新增缺陷带来源标记', created.every((d) => d.provenance?.batchId === batchId))
  ok('来源保留现场记录号', created.every((d) => d.provenance.sourceRecordId.length > 0))
  ok('原值快照完整', created.every((d) => typeof d.provenance.original.lengthMm === 'number'))

  // 工单带 provenance
  const newOrders = await db.workOrders.filter((o) => o.provenance?.batchId === batchId).toArray()
  ok('合并工单带来源标记', newOrders.length === result.createdOrders)

  const defectsAfter = await db.defects.count()
  const ordersAfter = await db.workOrders.count()
  ok('台账缺陷数增加', defectsAfter === defectsBefore + result.createdDefects)
  ok('台账工单数增加', ordersAfter === ordersBefore + result.createdOrders)

  // 5) 幂等重试：已确认批次不能再写
  const retryAgain = await commitMergeBatch(batchId)
  ok('已确认批次拒绝重复写入', retryAgain.ok === false)

  // 6) 撤回批次：缺陷与工单同步退回
  const blockers = await checkWithdrawBlockers(batchId)
  ok('无合并后阻断项', blockers.length === 0)
  const withdraw = await withdrawMergeBatch(batchId)
  console.log(
    `[4] 撤回：ok=${withdraw.ok} 退回 ${withdraw.withdrawnItems} 删缺陷 ${withdraw.deletedDefects} 删工单 ${withdraw.deletedOrders}`
  )
  ok('撤回成功', withdraw.ok)
  ok('撤回后缺陷数还原', (await db.defects.count()) === defectsBefore)
  ok('撤回后工单数还原', (await db.workOrders.count()) === ordersBefore)
  const withdrawn = await db.mergeBatches.get(batchId)
  assert.ok(withdrawn)
  ok('批次状态为已撤回', withdrawn.state === '已撤回')

  // 撤回后合并工单来源标记已不存在
  const remainOrders = await db.workOrders.filter((o) => o.provenance?.batchId === batchId).toArray()
  ok('撤回后无残留合并工单', remainOrders.length === 0)

  // 7) 第二个批次：合并后在现场缺陷上新建台账工单，撤回必须被阻断
  const second = await buildSampleInspectionPackage()
  const ingest2 = await ingestMergeBatch(second.payload, second.sourceName)
  const id2 = ingest2.batch.id
  const commit2 = await commitMergeBatch(id2)
  ok('第二个批次写入成功', commit2.ok)
  const committed2 = await db.mergeBatches.get(id2)
  assert.ok(committed2)
  const incomingDefectId = committed2.items.find((i) => i.written?.incomingDefectId)?.written
    ?.incomingDefectId as string
  assert.ok(incomingDefectId, '应找到现场写入的缺陷')
  await db.workOrders.put({
    id: 'wo-after-merge',
    defectId: incomingDefectId,
    team: '合并后新建班组',
    dueDate: '2026-12-31',
    state: '待派',
    acceptor: '',
    closedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const blockers2 = await checkWithdrawBlockers(id2)
  ok('合并后新建工单阻断撤回', blockers2.some((b) => b.type === 'order-created-after-merge'))
  const withdrawBlocked = await withdrawMergeBatch(id2)
  ok('被阻断时撤回不执行', withdrawBlocked.ok === false)
  ok('阻断时台账缺陷未删', (await db.defects.get(incomingDefectId)) !== undefined)
  await db.workOrders.delete('wo-after-merge')
  const withdraw2 = await withdrawMergeBatch(id2)
  ok('处理阻断工单后撤回成功', withdraw2.ok)

  console.log(`\n全部 ${passed} 项断言通过 ✅`)
  await db.close()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
