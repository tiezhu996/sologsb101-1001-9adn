import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  batchReadyToCommit,
  batchReadyToConfirm,
  commitBatch,
  pendingItemCount,
  rollbackBatch,
  stageInspectionPack
} from '@/utils/inspectionMerge'
import {
  BATCH_STATE_LABEL,
  type BatchDefectItem,
  type BatchResolution,
  type BatchState,
  type BatchSummary,
  type InspectionBatch,
  type InspectionPack
} from '@/types/inspectionBatch'
import type { Blade } from '@/types/blade'
import type { Defect } from '@/types/defect'
import type { Segment } from '@/types/segment'
import type { Turbine } from '@/types/turbine'

/** 待核对批次 store：离线巡检包暂存、逐条核对、整批确认 / 写入 / 撤回 */
export const useInspectionBatchStore = defineStore('inspectionBatch', () => {
  const batchesTable = useIdbTable<InspectionBatch>((database) => database.inspectionBatches)
  const turbinesTable = useIdbTable<Turbine>((database) => database.turbines, { sortByUpdatedAt: false })
  const bladesTable = useIdbTable<Blade>((database) => database.blades, { sortByUpdatedAt: false })
  const segmentsTable = useIdbTable<Segment>((database) => database.segments, { sortByUpdatedAt: false })
  const defectsTable = useIdbTable<Defect>((database) => database.defects, { sortByUpdatedAt: false })

  const batches = computed<InspectionBatch[]>(() => batchesTable.rows.value)
  const loading = computed(() => batchesTable.loading.value)
  const busy = ref(false)

  const openBatches = computed(() =>
    batches.value.filter((batch) => batch.state === '待核对' || batch.state === '已确认')
  )

  const summary = computed<BatchSummary>(() => {
    const defectItems = batches.value.flatMap((batch) =>
      batch.state === '已撤回' ? [] : batch.defectItems
    )
    return {
      total: batches.value.length,
      pendingBatches: openBatches.value.length,
      committedBatches: batches.value.filter((batch) => batch.state === '已写入').length,
      defectItems: defectItems.length,
      pendingItems: defectItems.filter((item) => item.resolution === 'pending' || item.blocked).length,
      conflictItems: defectItems.filter((item) => item.matchKind === 'conflict').length,
      newItems: defectItems.filter((item) => item.matchKind === 'new').length,
      workOrderItems: batches.value
        .filter((batch) => batch.state !== '已撤回')
        .reduce((sum, batch) => sum + batch.workOrderItems.length, 0)
    }
  })

  function batchById(id: string): InspectionBatch | undefined {
    return batches.value.find((batch) => batch.id === id)
  }

  function itemOf(batch: InspectionBatch, itemId: string): BatchDefectItem | undefined {
    return batch.defectItems.find((item) => item.itemId === itemId)
  }

  function stateLabel(state: BatchState): string {
    return BATCH_STATE_LABEL[state]
  }

  function readyToConfirm(batch: InspectionBatch): boolean {
    return batchReadyToConfirm(batch)
  }

  function readyToCommit(batch: InspectionBatch): boolean {
    return batchReadyToCommit(batch)
  }

  function unresolvedCount(batch: InspectionBatch): number {
    return pendingItemCount(batch)
  }

  /** 离线巡检包合并：先进待核对批次（不写任何业务表） */
  async function stagePack(pack: InspectionPack, meta: { name: string; sourceFile: string }): Promise<InspectionBatch> {
    const batch = stageInspectionPack(pack, meta, {
      turbines: turbinesTable.rows.value,
      blades: bladesTable.rows.value,
      segments: segmentsTable.rows.value,
      defects: defectsTable.rows.value
    })
    await batchesTable.upsert(batch)
    return batch
  }

  async function updateBatchMeta(id: string, patch: { name?: string; sourceTeam?: string }): Promise<void> {
    const batch = batchById(id)
    if (!batch) return
    await batchesTable.update(id, { name: patch.name ?? batch.name, sourceTeam: patch.sourceTeam ?? batch.sourceTeam })
  }

  /** 逐条给出核对结论；未写入台账前可反复修改 */
  async function decideItem(batchId: string, itemId: string, resolution: BatchResolution): Promise<void> {
    const batch = batchById(batchId)
    if (!batch || batch.state === '已写入' || batch.state === '已撤回') return
    const next: InspectionBatch = JSON.parse(JSON.stringify(batch)) as InspectionBatch
    const item = next.defectItems.find((entry) => entry.itemId === itemId)
    if (!item || item.blocked) return
    item.resolution = resolution
    item.decidedAt = Date.now()
    item.status = '已确认'
    next.updatedAt = Date.now()
    await batchesTable.upsert(next)
  }

  /** 一键把本批所有「待核对」分歧项统一给结论（阻塞项除外） */
  async function decideAll(
    batchId: string,
    resolution: Extract<BatchResolution, 'keep-local' | 'use-incoming' | 'duplicate'>
  ): Promise<number> {
    const batch = batchById(batchId)
    if (!batch || batch.state === '已写入' || batch.state === '已撤回') return 0
    const next: InspectionBatch = JSON.parse(JSON.stringify(batch)) as InspectionBatch
    let count = 0
    const now = Date.now()
    next.defectItems.forEach((item) => {
      if (item.resolution !== 'pending' || item.blocked) return
      item.resolution = resolution
      item.decidedAt = now
      item.status = '已确认'
      count += 1
    })
    next.updatedAt = now
    await batchesTable.upsert(next)
    return count
  }

  /** 整批确认：所有条目都有结论后进入「已确认待写入」，确认前不写本地台账 */
  async function confirmBatch(batchId: string): Promise<boolean> {
    const batch = batchById(batchId)
    if (!batch || !batchReadyToConfirm(batch)) return false
    const next: InspectionBatch = JSON.parse(JSON.stringify(batch)) as InspectionBatch
    const now = Date.now()
    next.defectItems.forEach((item) => {
      if (!item.blocked) item.status = '已确认'
    })
    next.workOrderItems.forEach((item) => {
      item.status = '已确认'
    })
    next.state = '已确认'
    next.updatedAt = now
    await batchesTable.upsert(next)
    return true
  }

  /** 已确认批次退回继续核对 */
  async function reopenForReview(batchId: string): Promise<void> {
    const batch = batchById(batchId)
    if (!batch || batch.state !== '已确认') return
    const next: InspectionBatch = JSON.parse(JSON.stringify(batch)) as InspectionBatch
    next.state = '待核对'
    next.updatedAt = Date.now()
    await batchesTable.upsert(next)
  }

  /** 整批写入本地台账（单事务，失败保留批次与原值，可重试） */
  async function commit(batchId: string): Promise<{ ok: boolean; error: string | null }> {
    const batch = batchById(batchId)
    if (!batch) return { ok: false, error: '批次不存在' }
    if (batch.state === '已写入') return { ok: true, error: null }
    if (!batchReadyToCommit(batch) || unresolvedCount(batch) > 0) {
      return { ok: false, error: '请先完成整批确认（仍有待核对 / 阻塞项）' }
    }
    busy.value = true
    try {
      const next = await commitBatch(batch)
      await batchesTable.upsert(next)
      return next.state === '已写入'
        ? { ok: true, error: null }
        : { ok: false, error: next.commitError ?? '写入失败' }
    } finally {
      busy.value = false
    }
  }

  /** 撤回批次：缺陷、工单、补建坐标在同一事务内一起退回 */
  async function rollback(batchId: string): Promise<void> {
    const batch = batchById(batchId)
    if (!batch || batch.state !== '已写入') return
    busy.value = true
    try {
      const next = await rollbackBatch(batch)
      await batchesTable.upsert(next)
    } finally {
      busy.value = false
    }
  }

  /** 删除未写入的批次（待核对 / 已确认）；已写入须先撤回 */
  async function discard(batchId: string): Promise<void> {
    const batch = batchById(batchId)
    if (!batch) return
    if (batch.state === '已写入' || batch.state === '已撤回') return
    await batchesTable.remove(batchId)
  }

  /** 物理删除已撤回批次（仅审计留痕清理） */
  async function purge(batchId: string): Promise<void> {
    const batch = batchById(batchId)
    if (!batch || batch.state !== '已撤回') return
    await batchesTable.remove(batchId)
  }

  return {
    batches,
    openBatches,
    loading,
    busy,
    summary,
    batchById,
    itemOf,
    stateLabel,
    readyToConfirm,
    readyToCommit,
    unresolvedCount,
    stagePack,
    updateBatchMeta,
    decideItem,
    decideAll,
    confirmBatch,
    reopenForReview,
    commit,
    rollback,
    discard,
    purge
  }
})
