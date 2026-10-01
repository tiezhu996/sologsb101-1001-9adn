<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  ArrowLeft,
  CircleCheck,
  Download,
  RefreshLeft,
  SortDown,
  Upload
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useInspectionBatchStore } from '@/stores/inspectionBatchStore'
import {
  MATCH_KIND_LABEL,
  RESOLUTION_LABEL,
  BATCH_STATE_TAG_TYPE,
  type BatchDefectItem,
  type InspectionBatch,
  type InspectionPack
} from '@/types/inspectionBatch'
import { validateInspectionPack } from '@/utils/inspectionMerge'
import { exportInspectionPackJson, readFileText } from '@/utils/export'
import { formatSize } from '@/utils/severity'

const batchStore = useInspectionBatchStore()
const { batches, summary, busy } = storeToRefs(batchStore)

/* ---------------- 时间 / 文案辅助 ---------------- */

function fmtTime(value: number | string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(typeof value === 'string' ? value : value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`
}

function diffHit(item: BatchDefectItem, key: 'lengthMm' | 'widthMm' | 'severity' | 'face'): boolean {
  return item.diffs.some((diff) => diff.key === key)
}

function itemResolutionTagType(
  resolution: BatchDefectItem['resolution']
): 'info' | 'success' | 'warning' | 'primary' | 'danger' {
  switch (resolution) {
    case 'pending':
      return 'danger'
    case 'new':
      return 'success'
    case 'use-incoming':
      return 'primary'
    case 'duplicate':
      return 'warning'
    default:
      return 'info'
  }
}

/** 批次内工单关联的缺陷核对项 */
function defectItemOf(batch: InspectionBatch, sourceDefectId: string): BatchDefectItem | undefined {
  return batch.defectItems.find((item) => item.sourceDefectId === sourceDefectId)
}

/* ---------------- 导出巡检包 ---------------- */
const exportVisible = ref(false)
const exportTeam = ref('')
const exportSubmitting = ref(false)

async function submitExport(): Promise<void> {
  exportSubmitting.value = true
  try {
    const { fileName, pack } = await exportInspectionPackJson(exportTeam.value)
    ElMessage.success(
      `已导出离线巡检包 ${fileName}（机组 ${pack.turbines.length} · 叶片 ${pack.blades.length} · 缺陷 ${pack.defects.length} · 工单 ${pack.workOrders.length}），可交给外委检修队在无网机位使用`
    )
    exportVisible.value = false
    exportTeam.value = ''
  } finally {
    exportSubmitting.value = false
  }
}

/* ---------------- 导入巡检包 → 待核对批次 ---------------- */
async function handleImportFile(file: UploadFile): Promise<void> {
  const raw = file.raw
  if (!raw) return
  const text = await readFileText(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    ElMessage.error('JSON 解析失败，请确认巡检包内容完整')
    return
  }
  const result = validateInspectionPack(parsed)
  if (!result.ok || !result.pack) {
    ElMessage.error(`巡检包校验未通过：${result.errors.join('；')}`)
    return
  }
  await stagePack(result.pack, raw.name)
}

async function stagePack(pack: InspectionPack, fileName: string): Promise<void> {
  let name = fileName.replace(/\.json$/i, '')
  try {
    const { value } = await ElMessageBox.prompt('为该离线巡检包命名（便于区分不同检修队 / 机位）', '进入待核对批次', {
      confirmButtonText: '进入核对',
      cancelButtonText: '取消',
      inputValue: name,
      inputValidator: (value: string) => value.trim().length > 0 || '批次名称不能为空'
    })
    name = value
  } catch {
    return
  }
  const batch = await batchStore.stagePack(pack, { name, sourceFile: fileName })
  ElMessage.success(
    `巡检包已进入待核对批次「${batch.name}」：${batch.defectItems.length} 条缺陷、${batch.workOrderItems.length} 张工单，确认前不会写入本地台账`
  )
  selectedBatchId.value = batch.id
}

/* ---------------- 列表 → 明细 ---------------- */
const selectedBatchId = ref<string | null>(null)

const selectedBatch = computed<InspectionBatch | null>(
  () => (selectedBatchId.value ? batchStore.batchById(selectedBatchId.value) ?? null : null)
)

watch(
  selectedBatch,
  (batch) => {
    editingName.value = batch?.name ?? ''
    editingTeam.value = batch?.sourceTeam ?? ''
  },
  { immediate: true }
)

function openBatch(id: string): void {
  selectedBatchId.value = id
}

function backToList(): void {
  selectedBatchId.value = null
}

async function handleRename(value: string): Promise<void> {
  if (!selectedBatch.value) return
  const name = value.trim()
  if (!name || name === selectedBatch.value.name) {
    editingName.value = selectedBatch.value.name
    return
  }
  await batchStore.updateBatchMeta(selectedBatch.value.id, { name })
}

async function handleTeamChange(): Promise<void> {
  if (!selectedBatch.value) return
  if (editingTeam.value === selectedBatch.value.sourceTeam) return
  await batchStore.updateBatchMeta(selectedBatch.value.id, { sourceTeam: editingTeam.value })
}

const visibleItems = computed(() => selectedBatch.value?.defectItems ?? [])

/** 可编辑的批次名称 / 来源检修队（本地暂存，change 时落库） */
const editingName = ref('')
const editingTeam = ref('')

const unresolved = computed(() =>
  selectedBatch.value ? batchStore.unresolvedCount(selectedBatch.value) : 0
)

const conflictItems = computed(
  () => selectedBatch.value?.defectItems.filter((item) => item.matchKind === 'conflict') ?? []
)

const batchActionDisabled = computed(
  () => selectedBatch.value?.state === '已写入' || selectedBatch.value?.state === '已撤回'
)

async function handleDecide(item: BatchDefectItem, resolution: BatchDefectItem['resolution']): Promise<void> {
  if (!selectedBatch.value) return
  await batchStore.decideItem(selectedBatch.value.id, item.itemId, resolution)
}

async function handleDecideAll(resolution: 'keep-local' | 'use-incoming' | 'duplicate'): Promise<void> {
  if (!selectedBatch.value) return
  const count = await batchStore.decideAll(selectedBatch.value.id, resolution)
  ElMessage.success(`已将 ${count} 条待核对分歧项统一置为「${RESOLUTION_LABEL[resolution]}」`)
}

async function handleConfirm(): Promise<void> {
  if (!selectedBatch.value) return
  const ok = await batchStore.confirmBatch(selectedBatch.value.id)
  if (ok) ElMessage.success('整批已确认，可写入本地台账；写入前仍可退回继续核对')
}

async function handleReopen(): Promise<void> {
  if (!selectedBatch.value) return
  await batchStore.reopenForReview(selectedBatch.value.id)
}

async function handleCommit(): Promise<void> {
  if (!selectedBatch.value) return
  try {
    await ElMessageBox.confirm(
      `整批写入将把「${selectedBatch.value.name}」确认结果写入本地台账，保留来源与原值；维度一致与维持本地的记录不覆盖，现场工单跟随对应缺陷录入。确认写入？`,
      '整批写入确认',
      { type: 'warning', confirmButtonText: '确认写入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await batchStore.commit(selectedBatch.value.id)
  if (result.ok) ElMessage.success('整批写入完成：完成情况、报告与后续导出均按确认结果计算')
  else ElMessage.error(`写入失败，本地台账未改动，可重试：${result.error ?? '未知错误'}`)
}

async function handleRollback(): Promise<void> {
  if (!selectedBatch.value) return
  try {
    await ElMessageBox.confirm(
      `撤回批次将把「${selectedBatch.value.name}」已写入的缺陷、工单及补建的机组 / 叶片 / 分段坐标一并退回，被覆盖的本地缺陷恢复原值。确认撤回？`,
      '撤回批次确认',
      { type: 'warning', confirmButtonText: '确认撤回', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await batchStore.rollback(selectedBatch.value.id)
  ElMessage.success('批次已撤回，缺陷与工单均已退回，完成情况与报告恢复为撤回前台账')
}

async function handleDiscard(batch: InspectionBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`丢弃批次「${batch.name}」仅删除待核对记录，不影响本地台账。确认丢弃？`, '丢弃批次', {
      type: 'warning',
      confirmButtonText: '丢弃',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  if (selectedBatchId.value === batch.id) selectedBatchId.value = null
  await batchStore.discard(batch.id)
  ElMessage.success('待核对批次已丢弃')
}

async function handlePurge(batch: InspectionBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`已撤回批次「${batch.name}」的审计留痕将被物理删除。确认删除？`, '删除留痕', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  if (selectedBatchId.value === batch.id) selectedBatchId.value = null
  await batchStore.purge(batch.id)
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>离线巡检包合并</h2>
        <p>外委检修队在无网机位导出的巡检包先进待核对批次，按机组编号、叶片序号与展向位置核对，整批确认后才写入本地台账。</p>
      </div>
      <div class="toolbar">
        <el-button :icon="Download" @click="exportVisible = true">导出巡检包</el-button>
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          accept=".json,application/json"
          :on-change="(file: UploadFile) => handleImportFile(file)"
        >
          <el-button type="primary" :icon="Upload">导入巡检包进核对</el-button>
        </el-upload>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="待核对批次" :value="summary.pendingBatches" suffix="批" tone="warning" icon="FolderOpened" />
      <StatBadge label="待核对缺陷" :value="summary.pendingItems" suffix="条" tone="danger" icon="WarningFilled" />
      <StatBadge label="同缺陷有分歧" :value="summary.conflictItems" suffix="条" tone="primary" icon="DataLine" />
      <StatBadge label="现场新缺陷" :value="summary.newItems" suffix="条" tone="success" icon="CircleCheck" />
      <StatBadge label="已写入批次" :value="summary.committedBatches" suffix="批" tone="info" icon="Document" />
      <StatBadge label="随包工单" :value="summary.workOrderItems" suffix="张" tone="default" icon="Files" />
    </div>

    <!-- ============ 批次列表 ============ -->
    <div v-if="!selectedBatch" class="section-card">
      <div class="section-card__head">
        <h3>待核对 / 已写入批次</h3>
        <span class="muted">确认前数据只保存在批次表，缺陷标注、工单、报告与导出均不计入</span>
      </div>
      <EmptyPanel
        v-if="batches.length === 0"
        title="暂无离线巡检包批次"
        description="外委检修队回传巡检包后，点右上角「导入巡检包进核对」；系统会按机组编号、叶片序号与展向位置匹配同一缺陷，尺寸 / 程度 / 面位有分歧时并列保留。"
      />
      <el-table v-else :data="batches" size="small" border>
        <el-table-column label="批次" min-width="200">
          <template #default="{ row }">
            <el-button link type="primary" @click="openBatch(row.id)">{{ row.name }}</el-button>
            <div class="muted" style="font-size: 12px">{{ row.sourceFile }}</div>
          </template>
        </el-table-column>
        <el-table-column label="来源检修队" prop="sourceTeam" width="150">
          <template #default="{ row }">{{ row.sourceTeam || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag :type="BATCH_STATE_TAG_TYPE[row.state as InspectionBatch['state']]" size="small">
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="缺陷 / 工单" width="120">
          <template #default="{ row }">
            <span class="mono">{{ row.defectItems.length }} / {{ row.workOrderItems.length }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待核对" width="90">
          <template #default="{ row }">
            <el-tag v-if="batchStore.unresolvedCount(row) > 0" type="danger" size="small">
              {{ batchStore.unresolvedCount(row) }}
            </el-tag>
            <span v-else class="muted">0</span>
          </template>
        </el-table-column>
        <el-table-column label="暂存时间" width="160">
          <template #default="{ row }">
            <span class="mono">{{ fmtTime(row.stagedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="写入时间" width="160">
          <template #default="{ row }">
            <span class="mono">{{ fmtTime(row.committedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openBatch(row.id)">
              {{ row.state === '待核对' ? '去核对' : row.state === '已写入' ? '查看' : '查看' }}
            </el-button>
            <el-button
              v-if="row.state === '待核对' || row.state === '已确认'"
              link
              type="danger"
              size="small"
              @click="handleDiscard(row)"
            >
              丢弃
            </el-button>
            <el-button v-if="row.state === '已撤回'" link type="danger" size="small" @click="handlePurge(row)">
              删除留痕
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- ============ 批次明细 / 核对 ============ -->
    <template v-else>
      <div class="section-card">
        <div class="section-card__head">
          <div class="toolbar">
            <el-button :icon="ArrowLeft" @click="backToList">返回批次列表</el-button>
            <el-input
              v-model="editingName"
              class="name-input"
              :disabled="batchActionDisabled"
              @change="(value: string) => handleRename(value)"
            />
            <el-tag :type="BATCH_STATE_TAG_TYPE[selectedBatch.state]" size="small">{{ selectedBatch.state }}</el-tag>
          </div>
          <div class="toolbar">
            <template v-if="selectedBatch.state === '待核对'">
              <el-dropdown @command="(command: 'keep-local' | 'use-incoming' | 'duplicate') => handleDecideAll(command)">
                <el-button :icon="SortDown" :disabled="conflictItems.length === 0">分歧项统一结论</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="keep-local">全部维持本地原值</el-dropdown-item>
                    <el-dropdown-item command="use-incoming">全部采用现场值</el-dropdown-item>
                    <el-dropdown-item command="duplicate">全部并列新增</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button type="primary" :icon="CircleCheck" :disabled="unresolved > 0" @click="handleConfirm">
                整批确认{{ unresolved > 0 ? `（剩 ${unresolved} 条待核对）` : '' }}
              </el-button>
            </template>
            <template v-else-if="selectedBatch.state === '已确认'">
              <el-button :icon="RefreshLeft" @click="handleReopen">退回继续核对</el-button>
              <el-button type="primary" :loading="busy" @click="handleCommit">整批写入本地台账</el-button>
            </template>
            <template v-else-if="selectedBatch.state === '已写入'">
              <el-button type="warning" plain :icon="RefreshLeft" :loading="busy" @click="handleRollback">
                撤回批次（缺陷 + 工单一起退回）
              </el-button>
            </template>
            <el-tag v-else type="info" size="small">已撤回，缺陷与工单已退回台账</el-tag>
          </div>
        </div>

        <el-alert
          v-if="selectedBatch.commitError"
          type="error"
          show-icon
          :closable="false"
          class="batch-alert"
          :title="`上次整批写入失败（已尝试 ${selectedBatch.commitAttempts} 次）：${selectedBatch.commitError}；本地台账未改动，可点「整批写入」重试。`"
        />
        <el-alert
          v-if="selectedBatch.state === '待核对'"
          type="info"
          show-icon
          :closable="false"
          class="batch-alert"
          title="核对规则：按机组编号 + 叶片序号 + 展向位置（容差 0.5 m）匹配同一缺陷；尺寸、程度或面位有分歧时本地原值与现场值并列保留，逐条给出结论后才能整批确认。"
        />

        <el-descriptions :column="4" size="small" border>
          <el-descriptions-item label="来源检修队">
            <el-input
              v-model="editingTeam"
              size="small"
              class="team-input"
              :disabled="batchActionDisabled"
              placeholder="填写检修队 / 机位"
              @change="handleTeamChange"
            />
          </el-descriptions-item>
          <el-descriptions-item label="现场包导出时间">
            <span class="mono">{{ fmtTime(selectedBatch.sourceExportedAt) }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="随包层级">
            机组 {{ selectedBatch.sourceCounts.turbines }} · 叶片 {{ selectedBatch.sourceCounts.blades }} · 分段
            {{ selectedBatch.sourceCounts.segments }}
          </el-descriptions-item>
          <el-descriptions-item label="暂存 / 写入时间">
            <span class="mono">{{ fmtTime(selectedBatch.stagedAt) }} ／ {{ fmtTime(selectedBatch.committedAt) }}</span>
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <div class="section-card">
        <div class="section-card__head">
          <h3>缺陷核对（{{ visibleItems.length }} 条）</h3>
          <div class="toolbar">
            <el-tag v-if="unresolved > 0" type="danger" size="small">待核对 / 阻塞 {{ unresolved }} 条</el-tag>
            <el-tag v-else type="success" size="small">全部已核对</el-tag>
          </div>
        </div>
        <el-table :data="visibleItems" size="small" border row-key="itemId" :row-class-name="() => ''">
          <el-table-column label="定位" width="200">
            <template #default="{ row }">
              <div><strong>{{ row.turbineCode }}</strong> · 叶片 {{ row.bladeSerial }}</div>
              <div class="muted" style="font-size: 12px">第 {{ row.segmentIndex }} 段 · {{ row.positionM }} m</div>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="100">
            <template #default="{ row }">{{ row.incoming.type }}</template>
          </el-table-column>
          <el-table-column label="发现日期（现场 / 本地）" width="180">
            <template #default="{ row }">
              <span class="mono">{{ row.incoming.foundAt }}</span>
              <span v-if="row.local" class="muted"> ／ {{ row.local.foundAt }}</span>
            </template>
          </el-table-column>
          <el-table-column label="匹配结论" width="140">
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="row.matchKind === 'conflict' ? 'danger' : row.matchKind === 'same' ? 'success' : 'warning'"
              >
                {{ MATCH_KIND_LABEL[row.matchKind as BatchDefectItem['matchKind']] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="本地台账原值" min-width="210">
            <template #default="{ row }">
              <template v-if="row.local">
                <div :class="{ 'diff-hit': diffHit(row, 'lengthMm') || diffHit(row, 'widthMm') }">
                  尺寸 <span class="mono">{{ formatSize(row.local.lengthMm, row.local.widthMm) }}</span>
                </div>
                <div :class="{ 'diff-hit': diffHit(row, 'severity') }">
                  程度 <SeverityTag :severity="row.local.severity" size="small" />
                </div>
                <div :class="{ 'diff-hit': diffHit(row, 'face') }">面位 {{ row.local.face }}</div>
                <div class="muted" style="font-size: 12px">发现 {{ row.local.foundAt }} · {{ row.local.state }}</div>
              </template>
              <span v-else class="muted">无本地记录</span>
            </template>
          </el-table-column>
          <el-table-column label="现场巡检值" min-width="210">
            <template #default="{ row }">
              <div :class="{ 'diff-hit': diffHit(row, 'lengthMm') || diffHit(row, 'widthMm') }">
                尺寸 <span class="mono">{{ formatSize(row.incoming.lengthMm, row.incoming.widthMm) }}</span>
              </div>
              <div :class="{ 'diff-hit': diffHit(row, 'severity') }">
                程度 <SeverityTag :severity="row.incoming.severity" size="small" />
              </div>
              <div :class="{ 'diff-hit': diffHit(row, 'face') }">面位 {{ row.incoming.face }}</div>
              <div class="muted" style="font-size: 12px">
                记录号 <span class="mono">{{ row.sourceDefectId.slice(-8) }}</span> · 发现 {{ row.incoming.foundAt }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="核对结论 / 操作" width="300" fixed="right">
            <template #default="{ row }">
              <el-alert
                v-if="row.blocked"
                type="error"
                :title="row.blockReason"
                :closable="false"
                show-icon
                class="item-alert"
              />
              <el-alert
                v-else-if="row.positionNote"
                type="warning"
                :title="row.positionNote"
                :closable="false"
                show-icon
                class="item-alert"
              />
              <template v-else>
                <el-tag :type="itemResolutionTagType(row.resolution)" size="small" class="resolution-tag">
                  {{ RESOLUTION_LABEL[row.resolution as BatchDefectItem['resolution']] }}
                </el-tag>
                <div v-if="!batchActionDisabled" class="decision-buttons">
                  <template v-if="row.matchKind === 'new'">
                    <el-button
                      size="small"
                      :type="row.resolution === 'new' ? 'success' : 'default'"
                      @click="handleDecide(row, 'new')"
                    >
                      录入为新缺陷
                    </el-button>
                  </template>
                  <template v-else>
                    <el-button
                      size="small"
                      :type="row.resolution === 'keep-local' ? 'info' : 'default'"
                      @click="handleDecide(row, 'keep-local')"
                    >
                      维持本地
                    </el-button>
                    <el-button
                      size="small"
                      :type="row.resolution === 'use-incoming' ? 'primary' : 'default'"
                      :disabled="row.matchKind === 'same'"
                      @click="handleDecide(row, 'use-incoming')"
                    >
                      采用现场
                    </el-button>
                    <el-button
                      size="small"
                      :type="row.resolution === 'duplicate' ? 'warning' : 'default'"
                      @click="handleDecide(row, 'duplicate')"
                    >
                      并列新增
                    </el-button>
                  </template>
                </div>
                <div v-else-if="row.writtenAction" class="muted" style="font-size: 12px">
                  写入动作：{{ row.writtenAction === 'inserted' ? '新增' : row.writtenAction === 'updated' ? '覆盖（原值已留痕）' : '跳过未覆盖' }}
                </div>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="section-card">
        <div class="section-card__head">
          <h3>随包维修工单（{{ selectedBatch.workOrderItems.length }} 张）</h3>
          <span class="muted">维持本地 / 一致跳过的缺陷，其现场工单不写入，避免覆盖本地处置结果；其余随缺陷确认结果录入</span>
        </div>
        <el-table :data="selectedBatch.workOrderItems" size="small" border>
          <el-table-column label="现场工单号" width="140">
            <template #default="{ row }">
              <span class="mono">#{{ row.sourceOrderId.slice(-6) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="缺陷记录" min-width="240">
            <template #default="{ row }">
              <span class="mono">#{{ row.sourceDefectId.slice(-8) }}</span>
              <span v-if="defectItemOf(selectedBatch, row.sourceDefectId)" class="muted">
                {{ defectItemOf(selectedBatch, row.sourceDefectId)?.turbineCode }} · 叶片
                {{ defectItemOf(selectedBatch, row.sourceDefectId)?.bladeSerial }} ·
                {{ defectItemOf(selectedBatch, row.sourceDefectId)?.positionM }} m ·
                {{ defectItemOf(selectedBatch, row.sourceDefectId)?.incoming.type }}
              </span>
              <span v-else class="text-danger">现场包内找不到对应缺陷</span>
            </template>
          </el-table-column>
          <el-table-column label="班组" prop="incoming.team" width="150" />
          <el-table-column label="限期" width="120">
            <template #default="{ row }"><span class="mono">{{ row.incoming.dueDate }}</span></template>
          </el-table-column>
          <el-table-column label="现场状态" width="100">
            <template #default="{ row }">{{ row.incoming.state }}</template>
          </el-table-column>
          <el-table-column label="验收人" width="100">
            <template #default="{ row }">{{ row.incoming.acceptor || '—' }}</template>
          </el-table-column>
          <el-table-column label="核对状态" width="110">
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="
                  row.status === '已写入'
                    ? 'success'
                    : row.status === '已撤回'
                      ? 'info'
                      : row.status === '不录入'
                        ? 'info'
                        : 'warning'
                "
              >
                {{ row.status }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <!-- 导出巡检包对话框 -->
    <el-dialog v-model="exportVisible" title="导出离线巡检包" width="480px" destroy-on-close>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="巡检包包含当前已确认的本地台账（五张业务表），不含待核对批次；外委检修队在无网机位标注后回传，再导入进待核对批次。"
        class="batch-alert"
      />
      <el-input v-model="exportTeam" placeholder="填写导出方，如：叶片检修一班 / 集控室主机" class="team-export-input" />
      <template #footer>
        <el-button @click="exportVisible = false">取消</el-button>
        <el-button type="primary" :loading="exportSubmitting" @click="submitExport">导出 JSON</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.name-input {
  width: 260px;
}

.team-input {
  width: 100%;
}

.team-export-input {
  margin-top: 12px;
}

.batch-alert,
.item-alert {
  margin-bottom: 12px;
}

.diff-hit {
  color: #c0392b;
  font-weight: 600;
}

.resolution-tag {
  margin-bottom: 6px;
}

.decision-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

:deep(.decision-buttons .el-button) {
  margin-left: 0;
}
</style>
