<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { Button } from "base-ui-vue";
import { api } from "../api";
import MetricChart from "../components/MetricChart.vue";
import { numeric } from "../lib/format";
const route = useRoute();
const training = computed(() => route.path === "/training");
const end = ref(new Date().toLocaleDateString("en-CA"));
const start = ref(
  new Date(Date.now() - 29 * 86400_000).toLocaleDateString("en-CA"),
);
const items = ref<Record<string, unknown>[]>([]);
const error = ref("");
const loading = ref(false);
const charts = computed(() =>
  training.value
    ? [
        {
          title: "VO₂ Max",
          key: "vo2max",
          unit: "ml/kg/min",
          color: "--primary-500",
        },
        {
          title: "训练准备度",
          key: "readiness",
          unit: "",
          color: "--accent-cold-400",
        },
        {
          title: "训练负荷",
          key: "training_load",
          unit: "",
          color: "--accent-warm-400",
        },
      ]
    : [
        { title: "步数", key: "steps", unit: "步", color: "--primary-500" },
        {
          title: "静息心率",
          key: "resting_hr",
          unit: "bpm",
          color: "--accent-warm-400",
        },
        {
          title: "睡眠",
          key: "sleep_seconds",
          unit: "小时",
          color: "--accent-cold-400",
        },
        { title: "HRV", key: "hrv", unit: "ms", color: "--primary-600" },
        { title: "压力", key: "stress", unit: "", color: "--accent-warm-500" },
        {
          title: "Body Battery",
          key: "body_battery",
          unit: "",
          color: "--accent-cold-500",
        },
      ],
);
const labels = computed(() =>
  items.value.map((row) => String(row.local_date).slice(5)),
);
function series(chart: { title: string; key: string; color: string }) {
  return [
    {
      name: chart.title,
      color: chart.color,
      data: items.value.map((row) =>
        typeof row[chart.key] === "number"
          ? (row[chart.key] as number) /
            (chart.key === "sleep_seconds" ? 3600 : 1)
          : null,
      ),
    },
  ];
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    items.value = (
      await api<{ items: Record<string, unknown>[] }>(
        `/api/v1/${training.value ? "training" : "health"}?${new URLSearchParams({ start: start.value, end: end.value })}`,
      )
    ).items;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(training, load);
</script>
<template>
  <div class="page-heading">
    <div>
      <span class="eyebrow">{{
        training ? "FIND YOUR RHYTHM" : "LISTEN TO YOUR BODY"
      }}</span>
      <h1>
        {{ training ? "训练状态" : "健康趋势" }}<span class="warm-dot">。</span>
      </h1>
    </div>
  </div>
  <form class="filter-bar" @submit.prevent="load">
    <input v-model="start" type="date" aria-label="开始日期" required /><span
      >—</span
    ><input v-model="end" type="date" aria-label="结束日期" required /><Button
      type="submit"
      class="button secondary"
      :disabled="loading"
      >{{ loading ? "读取中…" : "查看" }}</Button
    >
  </form>
  <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  <div class="trend-grid">
    <section v-for="chart in charts" :key="chart.key" class="panel">
      <div class="panel-heading">
        <h2>{{ chart.title }}</h2>
        <strong
          >{{
            numeric(
              items.at(-1)?.[chart.key] == null
                ? null
                : Number(items.at(-1)?.[chart.key]) /
                    (chart.key === "sleep_seconds" ? 3600 : 1),
              1,
            )
          }}
          <small class="muted-label">{{ chart.unit }}</small></strong
        >
      </div>
      <MetricChart
        :labels="labels"
        :series="series(chart)"
        :title="chart.title"
        :unit="chart.unit"
      />
    </section>
  </div>
  <section v-if="training && items.length" class="panel recent-panel">
    <div class="panel-heading"><h2>训练状态记录</h2></div>
    <div class="table-scroll">
      <table class="activity-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>状态</th>
            <th>采集时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in [...items].reverse()" :key="String(row.local_date)">
            <td>{{ row.local_date }}</td>
            <td>{{ row.training_status ?? "—" }}</td>
            <td>{{ row.fetched_at }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
