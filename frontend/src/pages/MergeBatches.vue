<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
import {
  CircleCheck,
  Delete,
  MagicStick,
  RefreshLeft,
  Select,
  Upload,
  View
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMergeBatchStore } from '@/stores/mergeBatchStore'
import { checkWithdrawBlockers } from '@/utils/merge'
import { downloadJsonFile, readFileText, validateBackup } from '@/utils/export'
import {
  MERGE_BATCH_TAG_TYPE,
  MERGE_KIND_LABEL,
  MERGE_KIND_TAG_TYPE,
  MERGE_RESOLUTION_LABEL,
  MERGE_RESOLUTIONS,
  MERGE_WRITE_STATE_LABEL,
  allowedResolutions,
  type MergeBatch,
  type MergeConflictField,
  type MergeItem,
  type MergeResolution
} from '@/types/mergeBatch'
import { formatDefectSize } from '@/types/defect'
import { FACE_LABEL, type SegmentFace } from '@/types/segment'

const mergeStore = useMergeBatchStore()

/* ---------------- 时间与统计 ---------------- */
function formatDateTime(value: number | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const stateFilter = ref<string>('')
const stateOptions = ['待核对', '写入失败', '已确认', '已撤回']

const filteredBatches = computed(() =>
  [...mergeStore.batches]
    .filter((batch) => (stateFilter.value ? batch.state === stateFilter.value : true))
    .sort((a, b) => b.importedAt - a.importedAt)
)

const totals = computed(() => ({
  all: mergeStore.batches.length,
  pending: mergeStore.stateCounts['待核对'],
  failed: mergeStore.stateCounts['写入失败'],
  confirmed: mergeStore.stateCounts['已确认'],
  withdrawn: mergeStore.stateCounts['已撤回'],
  conflictItems: mergeStore.conflictItemCount
}))

function kindSummary(batch: MergeBatch): string {
  const stats = mergeStore.kindStats(batch)
  return `新增 ${stats.new} · 同一 ${stats.same} · 分歧 ${stats.conflict} · 无法定位 ${stats.unlocatable}`
}

/* ---------------- 导入巡检包 ---------------- */
const importing = ref(false)

async function handleUploadFile(file: UploadFile): Promise<void> {
  const raw = file.raw
  if (!raw) return
  importing.value = true
  try {
    const text = await readFileText(raw)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      ElMessage.error('JSON 解析失败，请确认巡检包内容完整')
      return
    }
    const result = validateBackup(parsed)
    if (!result.ok || !result.payload) {
      ElMessageBox.alert(result.errors.join('<br/>'), '巡检包校验未通过', {
        type: 'error',
        dangerouslyUseHTMLString: true
      })
      return
    }
    const ingest = await mergeStore.ingest(result.payload, raw.name)
    ElMessageBox.alert(
      `巡检包 ${raw.name} 已进入待核对批次，确认前不会写入本地台账。<br/>` +
        `新增 ${ingest.newCount} 条 · 同一 ${ingest.sameCount} 条 · 分歧 ${ingest.conflictCount} 条 · 无法定位 ${ingest.unlocatableCount} 条`,
      '已生成待核对批次',
      { type: ingest.conflictCount > 0 ? 'warning' : 'success', dangerouslyUseHTMLString: true }
    )
    reviewBatchId.value = ingest.batch.id
    detailVisible.value = true
  } finally {
    importing.value = false
  }
}

/* ---------------- 示例巡检包 ---------------- */
const sampling = ref(false)

async function handleSamplePackage(): Promise<void> {
  sampling.value = true
  try {
    const { payload, sourceName } = await mergeStore.samplePackage()
    downloadJsonFile(sourceName, JSON.stringify(payload, null, 2))
    ElMessage.success(`已导出示例巡检包 ${sourceName}，可再次「导入巡检包」走核对流程`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '示例巡检包生成失败')
  } finally {
    sampling.value = false
  }
}

/* ---------------- 批次详情与核对 ---------------- */
const detailVisible = ref(false)
const reviewBatchId = ref<string | null>(null)
const detailKindFilter = ref<string>('')

const reviewBatch = computed<MergeBatch | null>(() =>
  reviewBatchId.value ? mergeStore.batchById(reviewBatchId.value) ?? null : null
)

const detailItems = computed<MergeItem[]>(() => {
  if (!reviewBatch.value) return []
  const order: Record<MergeItem['kind'], number> = { conflict: 0, new: 1, unlocatable: 2, same: 3 }
  return [...reviewBatch.value.items]
    .filter((item) => (detailKindFilter.value ? item.kind === detailKindFilter.value : true))
    .sort((a, b) => order[a.kind] - order[b.kind] || a.target.positionM - b.target.positionM)
})

const detailKindOptions = [
  { value: 'conflict', label: '仅看分歧' },
  { value: 'new', label: '仅看新增' },
  { value: 'same', label: '仅看同一' },
  { value: 'unlocatable', label: '仅看无法定位' }
]

function openReview(batch: MergeBatch): void {
  reviewBatchId.value = batch.id
  detailKindFilter.value = ''
  detailVisible.value = true
}

async function changeResolution(item: MergeItem, resolution: MergeResolution): Promise<void> {
  if (!reviewBatch.value || item.resolution === resolution) return
  if (!allowedResolutions(item.kind).includes(resolution)) return
  await mergeStore.setResolution(reviewBatch.value.id, item.id, resolution)
  ElMessage.success(
    `${item.target.turbineCode} 叶片${item.target.bladeSerial} ${item.target.positionM}m：已改为「${MERGE_RESOLUTION_LABEL[resolution]}」`
  )
}

/** 批量把当前筛选视图内的分歧条目统一设为并列保留 */
async function batchKeepBoth(): Promise<void> {
  const batch = reviewBatch.value
  if (!batch) return
  const targets = detailItems.value.filter(
    (item) => item.kind === 'conflict' && item.resolution !== 'both'
  )
  if (targets.length === 0) {
    ElMessage.info('当前视图没有需要改为并列保留的分歧条目')
    return
  }
  for (const item of targets) {
    await mergeStore.setResolution(batch.id, item.id, 'both')
  }
  ElMessage.success(`已把 ${targets.length} 条分歧条目设为并列保留`)
}

/* ---------------- 整批写入 / 撤回 / 删除 ---------------- */
const committing = ref(false)

async function handleCommit(): Promise<void> {
  const batch = reviewBatch.value
  if (!batch) return
  const stats = mergeStore.kindStats(batch)
  const unconfirmedConflicts = batch.items.filter(
    (item) => item.kind === 'conflict' && item.resolution === 'both'
  ).length
  try {
    await ElMessageBox.confirm(
      `整批写入「${batch.sourceName}」？<br/>` +
        `新增 ${stats.new} 条 / 同一 ${stats.same} 条 / 分歧 ${stats.conflict} 条 / 无法定位 ${stats.unlocatable} 条。<br/>` +
        `其中 ${unconfirmedConflicts} 条分歧将并列保留（台账与现场值同时存在）。<br/>` +
        `写入后完成情况、报告与后续导出均按确认结果计算。`,
      '整批确认写入',
      {
        type: 'warning',
        confirmButtonText: '确认整批写入',
        cancelButtonText: '再核一核',
        dangerouslyUseHTMLString: true
      }
    )
  } catch {
    return
  }
  committing.value = true
  try {
    const result = await mergeStore.commit(batch.id)
    if (result.ok) {
      ElMessage.success(
        `整批写入完成：落库条目 ${result.writtenItems} · 跳过 ${result.skippedItems} · 新增缺陷 ${result.createdDefects} 条 · 新增工单 ${result.createdOrders} 张`
      )
    } else {
      ElMessageBox.alert(
        (result.errors.length > 0 ? result.errors.slice(0, 8).join('<br/>') : '批次状态不允许写入') +
          (result.errors.length > 8 ? `<br/>…另有 ${result.errors.length - 8} 条` : ''),
        `写入失败，可修正后重试（失败 ${result.failedItems} 条）`,
        { type: 'error', dangerouslyUseHTMLString: true }
      )
    }
  } finally {
    committing.value = false
  }
}

async function retryFailed(): Promise<void> {
  await handleCommit()
}

const withdrawing = ref(false)

async function handleWithdraw(batch: MergeBatch): Promise<void> {
  const blockers = await checkWithdrawBlockers(batch.id)
  if (blockers.length > 0) {
    ElMessageBox.alert(
      blockers.map((item) => item.message).join('<br/>'),
      `撤回被阻断（${blockers.length} 项）`,
      { type: 'warning', dangerouslyUseHTMLString: true }
    )
    return
  }
  try {
    await ElMessageBox.confirm(
      `撤回批次「${batch.sourceName}」会同步退回本次写入的缺陷与工单，被覆盖的台账记录还原为原值，且撤回后不再计入完成情况与报告。确认撤回？`,
      '撤回批次确认',
      { type: 'warning', confirmButtonText: '确认撤回', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  withdrawing.value = true
  try {
    const result = await mergeStore.withdraw(batch.id)
    if (result.ok) {
      ElMessage.success(
        `批次已撤回：退回条目 ${result.withdrawnItems ?? 0} · 删除缺陷 ${result.deletedDefects ?? 0} 条 · 删除工单 ${result.deletedOrders ?? 0} 张`
      )
    } else {
      ElMessage.error(result.blockers[0]?.message ?? '撤回失败')
    }
  } finally {
    withdrawing.value = false
  }
}

async function handleDelete(batch: MergeBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除批次「${batch.sourceName}」仅清除核对记录${
        batch.state === '已撤回' ? '（台账已退回）' : '（确认前批次未写入台账）'
      }，确认删除？`,
      '删除批次',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await mergeStore.remove(batch.id)
  if (reviewBatchId.value === batch.id) detailVisible.value = false
  ElMessage.success('批次记录已删除')
}

/* ---------------- 对比表格辅助 ---------------- */

function isDiff(item: MergeItem, field: MergeConflictField): boolean {
  return item.conflictFields.includes(field)
}

function faceText(face: string): string {
  return FACE_LABEL[face as SegmentFace] ?? face
}

function sizeText(item: { lengthMm: number; widthMm: number }): string {
  return formatDefectSize(item.lengthMm, item.widthMm)
}

function resolutionOptions(item: MergeItem): MergeResolution[] {
  return MERGE_RESOLUTIONS.filter((resolution) => allowedResolutions(item.kind).includes(resolution))
}

function incomingOrdersText(item: MergeItem): string {
  if (item.incomingOrders.length === 0) return '无现场工单'
  return item.incomingOrders.map((order) => `${order.team}｜${order.state}｜限期 ${order.dueDate}`).join('；')
}

function localOrdersText(item: MergeItem): string {
  if (item.localOrders.length === 0) return '台账无工单'
  return item.localOrders.map((order) => `${order.team}｜${order.state}｜限期 ${order.dueDate}`).join('；')
}

function writeTagType(state: MergeItem['writeState']): 'info' | 'success' | 'warning' | 'danger' {
  switch (state) {
    case '已写入':
      return 'success'
    case '已跳过':
      return 'info'
    case '已撤回':
      return 'info'
    case '写入失败':
      return 'danger'
    case '待写入':
      return 'warning'
  }
}

function writeStateLabel(state: MergeItem['writeState']): string {
  return MERGE_WRITE_STATE_LABEL[state]
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>离线巡检包合并</h2>
        <p>
          外委检修队在无网机位导出的巡检包先进入待核对批次，按机组编号、叶片序号与展向位置匹配同一缺陷；
          尺寸、程度或面位有分歧时并列保留，确认前不写本地台账。
        </p>
      </div>
      <div class="toolbar">
        <el-button :icon="MagicStick" :loading="sampling" @click="handleSamplePackage">
          导出示例巡检包
        </el-button>
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          accept=".json,application/json"
          :on-change="(file: UploadFile) => handleUploadFile(file)"
        >
          <el-button type="primary" :icon="Upload" :loading="importing">导入巡检包</el-button>
        </el-upload>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="批次总数" :value="totals.all" suffix="个" tone="default" icon="Files" />
      <StatBadge label="待核对" :value="totals.pending" suffix="个" tone="warning" icon="Clock" />
      <StatBadge label="写入失败" :value="totals.failed" suffix="个" tone="danger" icon="CircleCloseFilled" />
      <StatBadge label="已确认" :value="totals.confirmed" suffix="个" tone="success" icon="CircleCheck" />
      <StatBadge label="已撤回" :value="totals.withdrawn" suffix="个" tone="info" icon="RefreshLeft" />
      <StatBadge label="待核对分歧" :value="totals.conflictItems" suffix="条" tone="danger" icon="WarningFilled" />
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>待核对 / 历史批次</h3>
        <div class="toolbar">
          <el-select v-model="stateFilter" placeholder="全部状态" clearable size="small" class="state-select">
            <el-option v-for="state in stateOptions" :key="state" :label="state" :value="state" />
          </el-select>
        </div>
      </div>

      <EmptyPanel
        v-if="filteredBatches.length === 0"
        title="暂无离线巡检包批次"
        description="外委检修队在无网机位导出巡检包后，集控室在此导入；包会先进入待核对批次，确认后才写入台账。"
        :show-seed="false"
      />

      <el-table v-else :data="filteredBatches" border>
        <el-table-column label="来源巡检包" min-width="240">
          <template #default="{ row }">
            <div class="cell-stack">
              <strong>{{ row.sourceName }}</strong>
              <span class="muted">导入于 {{ formatDateTime(row.importedAt) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="MERGE_BATCH_TAG_TYPE[row.state as MergeBatch['state']]" effect="dark">
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="包内记录" width="150">
          <template #default="{ row }">
            缺陷 {{ row.sourceDefectCount }} 条<br />工单 {{ row.sourceWorkOrderCount }} 张
          </template>
        </el-table-column>
        <el-table-column label="核对分布" min-width="280">
          <template #default="{ row }">
            <span>{{ kindSummary(row) }}</span>
            <div v-if="row.lastError" class="error-text">上次写入：{{ row.lastError }}</div>
          </template>
        </el-table-column>
        <el-table-column label="确认 / 撤回时间" width="170">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="muted">确认 {{ formatDateTime(row.committedAt) }}</span>
              <span class="muted">撤回 {{ formatDateTime(row.withdrawnAt) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :icon="View"
              :disabled="row.state === '已撤回'"
              @click="openReview(row)"
            >
              {{ row.state === '待核对' || row.state === '写入失败' ? '核对并写入' : '查看结果' }}
            </el-button>
            <el-button
              link
              type="warning"
              :icon="RefreshLeft"
              :disabled="row.state !== '已确认'"
              :loading="withdrawing"
              @click="handleWithdraw(row)"
            >
              撤回
            </el-button>
            <el-button
              link
              type="danger"
              :icon="Delete"
              :disabled="row.state === '已确认'"
              @click="handleDelete(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 批次核对抽屉 -->
    <el-drawer
      v-model="detailVisible"
      :title="reviewBatch ? `批次核对 · ${reviewBatch.sourceName}` : '批次核对'"
      size="92%"
      destroy-on-close
    >
      <template v-if="reviewBatch">
        <el-alert
          v-if="reviewBatch.state === '待核对'"
          type="info"
          :closable="false"
          show-icon
          title="当前批次尚未写入本地台账：缺陷标注、完成情况、报告与后续导出均不包含本批数据。"
          class="batch-alert"
        />
        <el-alert
          v-else-if="reviewBatch.state === '写入失败'"
          type="error"
          :closable="false"
          show-icon
          :title="`上次整批写入存在失败条目（${reviewBatch.lastError ?? '原因未知'}），已写入的条目保持幂等，修正后可重试。`"
          class="batch-alert"
        />
        <el-alert
          v-else-if="reviewBatch.state === '已确认'"
          type="success"
          :closable="false"
          show-icon
          title="本批次已整批写入；完成情况、报告与后续导出均按确认结果计算。撤回批次会同步退回缺陷与工单。"
          class="batch-alert"
        />
        <el-alert
          v-else
          type="warning"
          :closable="false"
          show-icon
          title="本批次已撤回：合并写入的缺陷与工单已退回台账，被覆盖的记录已还原原值。"
          class="batch-alert"
        />

        <div class="detail-toolbar">
          <div class="toolbar">
            <el-radio-group v-model="detailKindFilter" size="small">
              <el-radio-button label="">全部</el-radio-button>
              <el-radio-button
                v-for="option in detailKindOptions"
                :key="option.value"
                :label="option.value"
              >
                {{ option.label }}
              </el-radio-button>
            </el-radio-group>
            <el-button
              size="small"
              :icon="CircleCheck"
              :disabled="reviewBatch.state !== '待核对' && reviewBatch.state !== '写入失败'"
              @click="batchKeepBoth"
            >
              分歧统一并列保留
            </el-button>
          </div>
          <div class="toolbar">
            <el-button
              v-if="reviewBatch.state === '写入失败'"
              type="warning"
              :icon="RefreshLeft"
              :loading="committing"
              @click="retryFailed"
            >
              重试写入
            </el-button>
            <el-button
              type="primary"
              :icon="Select"
              :loading="committing"
              :disabled="reviewBatch.state !== '待核对' && reviewBatch.state !== '写入失败'"
              @click="handleCommit"
            >
              整批确认写入
            </el-button>
          </div>
        </div>

        <el-table :data="detailItems" border size="small" class="detail-table">
          <el-table-column label="定位" width="200">
            <template #default="{ row }">
              <div class="cell-stack">
                <strong>{{ row.target.turbineCode }}</strong>
                <span class="muted">叶片 {{ row.target.bladeSerial }}｜{{ row.target.positionM }} m</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="判定" width="90">
            <template #default="{ row }">
              <el-tag :type="MERGE_KIND_TAG_TYPE[row.kind as MergeItem['kind']]" size="small">
                {{ MERGE_KIND_LABEL[row.kind as MergeItem['kind']] }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="现场（巡检包原值）" min-width="280">
            <template #default="{ row }">
              <div class="side-cell">
                <div :class="{ diff: isDiff(row, 'type') }">类型：{{ row.incoming.type }}</div>
                <div :class="{ diff: isDiff(row, 'severity') }">
                  程度：
                  <SeverityTag :severity="row.incoming.severity" size="small" />
                </div>
                <div :class="{ diff: isDiff(row, 'lengthMm') || isDiff(row, 'widthMm') }">
                  尺寸：<span class="mono">{{ sizeText(row.incoming) }}</span>
                </div>
                <div :class="{ diff: isDiff(row, 'face') }">面位：{{ faceText(row.incoming.face) }}</div>
                <div class="muted">发现：{{ row.incoming.foundAt }}｜状态：{{ row.incoming.state }}</div>
                <div class="muted">记录号：{{ row.incoming.id }}</div>
                <div class="orders-cell">{{ incomingOrdersText(row) }}</div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="本地台账（当前值）" min-width="280">
            <template #default="{ row }">
              <div v-if="row.local" class="side-cell">
                <div :class="{ diff: isDiff(row, 'type') }">类型：{{ row.local.type }}</div>
                <div :class="{ diff: isDiff(row, 'severity') }">
                  程度：
                  <SeverityTag :severity="row.local.severity" size="small" />
                </div>
                <div :class="{ diff: isDiff(row, 'lengthMm') || isDiff(row, 'widthMm') }">
                  尺寸：<span class="mono">{{ sizeText(row.local) }}</span>
                </div>
                <div :class="{ diff: isDiff(row, 'face') }">面位：{{ faceText(row.local.face) }}</div>
                <div class="muted">发现：{{ row.local.foundAt }}｜状态：{{ row.local.state }}</div>
                <div class="muted">记录号：{{ row.local.id }}</div>
                <div class="orders-cell">{{ localOrdersText(row) }}</div>
              </div>
              <el-alert
                v-else
                :title="row.reason ?? '台账中无同位置缺陷，将作为新增写入'"
                :type="row.kind === 'unlocatable' ? 'error' : 'info'"
                :closable="false"
                show-icon
                class="inline-alert"
              />
            </template>
          </el-table-column>

          <el-table-column label="核对结论" width="230">
            <template #default="{ row }">
              <el-radio-group
                :model-value="row.resolution"
                :disabled="reviewBatch.state === '已确认' || reviewBatch.state === '已撤回'"
                size="small"
                @change="(value: MergeResolution) => changeResolution(row, value)"
              >
                <el-radio
                  v-for="resolution in resolutionOptions(row)"
                  :key="resolution"
                  :value="resolution"
                  class="resolution-radio"
                >
                  {{ MERGE_RESOLUTION_LABEL[resolution] }}
                </el-radio>
              </el-radio-group>
              <el-tag
                v-if="row.writeState !== '待写入'"
                :type="writeTagType(row.writeState)"
                size="small"
                class="write-tag"
              >
                {{ writeStateLabel(row.writeState) }}
              </el-tag>
              <div v-if="row.error" class="error-text">{{ row.error }}</div>
            </template>
          </el-table-column>
        </el-table>

        <div class="detail-footer muted">
          分歧字段以 <span class="diff-inline">红字</span> 标出；并列保留会新增一条带来源标记的缺陷，
          台账原值不动；以现场为准会覆盖台账字段但保留原值快照；撤回批次时可整体还原。
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.state-select {
  width: 150px;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.error-text {
  color: #c0392b;
  font-size: 12px;
  margin-top: 2px;
}

.batch-alert {
  margin-bottom: 12px;
}

.detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.detail-table {
  width: 100%;
}

.side-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12.5px;
  line-height: 1.5;
}

.side-cell .diff,
.diff-inline {
  color: #c0392b;
  font-weight: 700;
}

.orders-cell {
  margin-top: 2px;
  padding: 4px 6px;
  background: #f5f9fb;
  border-radius: 6px;
  color: #4a5b63;
  font-size: 12px;
}

.inline-alert {
  margin: 0;
}

.resolution-radio {
  display: block;
  margin: 2px 0;
}

.write-tag {
  margin-top: 6px;
}

.detail-footer {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.8;
}
</style>
