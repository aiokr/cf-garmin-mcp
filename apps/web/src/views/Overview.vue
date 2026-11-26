<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { Button } from "base-ui-vue";
import { useSession } from "../stores/session";
import { useConnections } from "../stores/connections";
import { api } from "../api";
import type { Dashboard } from "../../../../packages/shared/src";
import Icon from "../components/Icon.vue";
import EmptyState from "../components/EmptyState.vue";
import MetricChart from "../components/MetricChart.vue";
import ActivityTable from "../components/ActivityTable.vue";
import { numeric } from "../lib/format";
const session = useSession();
const connections = useConnections();
const data = ref<Dashboard | null>(null);
const error = ref("");
const loading = ref(true);
const syncing = ref(false);
const notice = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
const cards = computed(() => [
  {
    label: "今日步数",
    icon: "steps",
    unit: "步",
    tone: "blue",
    value: numeric(data.value?.metrics.steps),
  },
  {
    label: "日常距离",
    icon: "distance",
    unit: "km",
    tone: "warm",
    value: numeric(
      data.value?.metrics.distanceM == null
        ? null
        : data.value.metrics.distanceM / 1000,
      2,
    ),
  },
  {
    label: "睡眠时长",
    icon: "moon",
    unit: "小时",
    tone: "cold",
    value: numeric(
      data.value?.metrics.sleepSeconds == null
        ? null
        : data.value.metrics.sleepSeconds / 3600,
      1,
    ),
  },
  {
    label: "静息心率",
    icon: "heart",
    unit: "bpm",
    tone: "rose",
    value: numeric(data.value?.metrics.restingHr),
  },
]);
const trendLabels = computed(
  () => data.value?.trends.map((row) => String(row.local_date).slice(5)) || [],
);
const trends = computed(() => [
  {
    name: "步数",
    color: "--primary-500",
    data:
      data.value?.trends.map((row) =>
        typeof row.steps === "number" ? row.steps : null,
      ) || [],
  },
]);
async function load() {
  error.value = "";
  try {
    data.value = await api<Dashboard>("/api/v1/dashboard");
    await connections.load();
    const runs = await api<{ items: { status: string }[] }>(
      "/api/v1/sync/runs",
    );
    const active = runs.items.some((run) =>
      ["queued", "running"].includes(run.status),
    );
    if (active) {
      clearTimeout(timer);
      timer = setTimeout(load, 10_000);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败。";
  } finally {
    loading.value = false;
  }
}
async function sync() {
  syncing.value = true;
  notice.value = "";
  try {
    await api("/api/v1/sync", {
      method: "POST",
      body: JSON.stringify({ stream: "all" }),
    });
    notice.value = "同步已开始";
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "同步失败";
  } finally {
    syncing.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <div class="page-heading">
    <div>
      <span class="eyebrow">YOUR DAILY PULSE</span>
      <h1>{{ session.owner?.name }}，你好<span class="warm-dot">。</span></h1>
      <p>
        {{ data?.date || "今天" }}
        <span v-if="data">· {{ data.timezone }}</span>
      </p>
    </div>
    <div class="heading-actions">
      <Button
        class="icon-button"
        aria-label="刷新数据"
        :disabled="loading"
        @click="load"
        ><Icon name="refresh" :size="18" /></Button
      ><Button
        v-if="connections.connected"
        class="button secondary"
        :disabled="syncing"
        @click="sync"
        ><Icon name="refresh" :size="16" />{{
          syncing ? "提交中…" : "同步"
        }}</Button
      >
    </div>
  </div>
  <div v-if="error" class="notice error-text" role="alert">
    {{ error }}<Button class="text-button" @click="load">重试</Button>
  </div>
  <p v-if="notice" class="success-text" role="status">{{ notice }}</p>
  <section v-if="!connections.connected" class="welcome-banner">
    <div class="banner-symbol"><Icon name="link" :size="26" /></div>
    <div>
      <h2>连接 Garmin</h2>
      <p>查看运动、健康与训练数据。</p>
    </div>
    <RouterLink class="button primary" to="/settings"
      >连接账号<Icon name="arrow" :size="17"
    /></RouterLink>
  </section>
  <section class="metric-grid" aria-label="今日指标" :aria-busy="loading">
    <article v-for="card in cards" :key="card.label" class="metric-card">
      <div class="metric-top">
        <span>{{ card.label }}</span><span :class="['metric-icon', card.tone]"
          ><Icon :name="card.icon" :size="19"
        /></span>
      </div>
      <div class="metric-value">
        {{ loading ? "…" : card.value }}<small>{{ card.unit }}</small>
      </div>
      <p>
        {{ loading ? "读取中" : card.value === "—" ? "暂无数据" : data?.date }}
      </p>
    </article>
  </section>
  <div class="overview-grid">
    <section class="panel trend-panel">
      <div class="panel-heading">
        <h2>日常活动</h2>
        <span class="muted-label">最近 7 天</span>
      </div>
      <MetricChart
        :labels="trendLabels"
        :series="trends"
        title="最近七天步数"
        kind="bar"
        unit="步"
      />
    </section>
    <section class="panel recovery-panel">
      <div class="panel-heading">
        <h2>恢复与训练</h2>
        <RouterLink to="/training" class="text-link"
          >查看<Icon name="arrow" :size="16"
        /></RouterLink>
      </div>
      <div class="recovery-ring">
        <Icon name="training" :size="28" /><strong>{{
          numeric(data?.training?.readiness)
        }}</strong
        ><span>训练准备度</span>
      </div>
      <p class="recovery-note">
        VO₂ Max {{ numeric(data?.training?.vo2max, 1) }}<br />训练负荷
        {{ numeric(data?.training?.training_load) }}
      </p>
    </section>
  </div>
  <section class="panel recent-panel">
    <div class="panel-heading">
      <h2>最近的运动</h2>
      <RouterLink class="text-link" to="/activities"
        >全部记录 <Icon name="arrow" :size="16"
      /></RouterLink>
    </div>
    <ActivityTable
      v-if="data?.activities.length"
      :items="data.activities"
    /><EmptyState v-else icon="activity" title="暂无运动记录" description="" />
  </section>
  <p class="data-source">
    <span class="status-dot" />Garmin ·
    {{
      data?.freshness.lastSuccessfulSync
        ? `上次同步 ${new Date(data.freshness.lastSuccessfulSync).toLocaleString("zh-CN")}`
        : "尚未同步"
    }}<span v-if="data?.freshness.status === 'stale'">· 数据可能已过期</span>
  </p>
</template>
