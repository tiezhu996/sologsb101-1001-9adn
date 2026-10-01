import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { BackupPayload } from '@/utils/db'
import {
  buildSampleInspectionPackage,
  commitMergeBatch,
  deleteMergeBatch,
  ingestMergeBatch,
  setMergeItemResolution,
  withdrawMergeBatch,
  type CommitResult,
  type WithdrawResult
} from '@/utils/merge'
import {
  MERGE_BATCH_STATES,
  type MergeBatch,
  type MergeBatchState,
  type MergeItemKind,
  type MergeResolution
} from '@/types/mergeBatch'

/**
 * 离线巡检包批次 store：订阅 mergeBatches 表并维护批次维度统计。
 * 跨页状态（待核对数量徽标）由此统一提供；具体合并算法在 utils/merge.ts。
 */
export const useMergeBatchStore = defineStore('mergeBatch', () => {
  const batchesTable = useIdbTable<MergeBatch>((database) => database.mergeBatches)

  const batches = computed<MergeBatch[]>(() => batchesTable.rows.value)
  const loading = computed(() => batchesTable.loading.value)
  const ready = computed(() => batchesTable.ready.value)

  /** 待核对 / 写入失败（仍需集控室处理）的批次数量，用于顶部导航徽标 */
  const pendingCount = computed(
    () => batches.value.filter((batch) => batch.state === '待核对' || batch.state === '写入失败').length
  )

  /** 待核对批次内尚未核对（保留默认结论）的分歧条目总数，徽标补充提示用 */
  const conflictItemCount = computed(() => {
    let count = 0
    batches.value
      .filter((batch) => batch.state === '待核对')
      .forEach((batch) => {
        count += batch.items.filter((item) => item.kind === 'conflict').length
      })
    return count
  })

  const stateCounts = computed<Record<MergeBatchState, number>>(() => {
    const counts: Record<MergeBatchState, number> = {
      待核对: 0,
      写入失败: 0,
      已确认: 0,
      已撤回: 0
    }
    batches.value.forEach((batch) => {
      counts[batch.state] += 1
    })
    return counts
  })

  function batchById(id: string): MergeBatch | undefined {
    return batches.value.find((batch) => batch.id === id)
  }

  /** 批次内条目录属统计 */
  function kindStats(batch: MergeBatch): Record<MergeItemKind, number> {
    const stats: Record<MergeItemKind, number> = { new: 0, same: 0, conflict: 0, unlocatable: 0 }
    batch.items.forEach((item) => {
      stats[item.kind] += 1
    })
    return stats
  }

  /** 批次内待写入 / 已写入 / 已跳过 / 失败统计 */
  function writeStats(batch: MergeBatch): {
    pending: number
    written: number
    skipped: number
    failed: number
    withdrawn: number
  } {
    const stats = { pending: 0, written: 0, skipped: 0, failed: 0, withdrawn: 0 }
    batch.items.forEach((item) => {
      if (item.writeState === '待写入') stats.pending += 1
      else if (item.writeState === '已写入') stats.written += 1
      else if (item.writeState === '已跳过') stats.skipped += 1
      else if (item.writeState === '写入失败') stats.failed += 1
      else if (item.writeState === '已撤回') stats.withdrawn += 1
    })
    return stats
  }

  /** 导入巡检包，生成待核对批次（不写台账） */
  async function ingest(payload: BackupPayload, sourceName: string) {
    return ingestMergeBatch(payload, sourceName)
  }

  /** 整批确认写入 */
  async function commit(batchId: string): Promise<CommitResult> {
    return commitMergeBatch(batchId)
  }

  /** 撤回已确认批次（缺陷与工单同步退回） */
  async function withdraw(batchId: string): Promise<WithdrawResult> {
    return withdrawMergeBatch(batchId)
  }

  /** 修改单条核对结论 */
  async function setResolution(batchId: string, itemId: string, resolution: MergeResolution): Promise<void> {
    await setMergeItemResolution(batchId, itemId, resolution)
  }

  async function remove(batchId: string): Promise<void> {
    await deleteMergeBatch(batchId)
  }

  /** 构造示例巡检包（不落库，供页面导出给检修队流程演示） */
  async function samplePackage(): Promise<{ payload: BackupPayload; sourceName: string }> {
    return buildSampleInspectionPackage()
  }

  return {
    batches,
    loading,
    ready,
    pendingCount,
    conflictItemCount,
    stateCounts,
    batchById,
    kindStats,
    writeStats,
    ingest,
    commit,
    withdraw,
    setResolution,
    remove,
    samplePackage,
    batchStates: MERGE_BATCH_STATES
  }
})
