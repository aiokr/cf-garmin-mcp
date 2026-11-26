<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { Button } from "base-ui-vue";
import { api } from "../api";
import type { ActivitySummary } from "../../../../packages/shared/src";
import Icon from "../components/Icon.vue";
import MetricChart from "../components/MetricChart.vue";
import { duration, numeric, sportName, pace } from "../lib/format";
const TrackMap = defineAsyncComponent(
  () => import("../components/TrackMap.vue"),
);
const route = useRoute();
const activity = ref<
  (ActivitySummary & { files: { id: string; status: string }[] }) | null
>(null);
const details = ref<{
  samples: Record<string, unknown>[];
  laps: Record<string, unknown>[];
  sampleCount: number;
} | null>(null);
const error = ref("");
const fileError = ref("");
const mapError = ref("");
const coordinates = ref<[number, number][]>([]);
const mapVisible = ref(false);
const tileUrl = ref("");
const mapLoading = ref(false);
const labels = computed(
  () =>
    details.value?.samples.map((row) =>
      new Date(String(row.timestamp)).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    ) || [],
);
const series = (key: string, name: string, color: string) => [
  {
    name,
    color,
    data:
      details.value?.samples.map((row) =>
        typeof row[key] === "number" ? (row[key] as number) : null,
      ) || [],
  },
];
async function load() {
  error.value = "";
  fileError.value = "";
  try {
    activity.value = await api(
      `/api/v1/activities/${encodeURIComponent(String(route.params.id))}`,
    );
    if (activity.value?.files.some((file) => file.status === "ready")) {
      try {
        details.value = await api(
          `/api/v1/activities/${encodeURIComponent(String(route.params.id))}/details`,
        );
      } catch (e) {
        fileError.value = e instanceof Error ? e.message : "曲线不可用";
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  }
}
async function showMap() {
  mapLoading.value = true;
  mapError.value = "";
  try {
    const [track, settings] = await Promise.all([
      api<{ geometry: { coordinates: [number, number][] } }>(
        `/api/v1/activities/${encodeURIComponent(String(route.params.id))}/track`,
      ),
      api<{ mapTileUrl: string }>("/api/v1/settings"),
    ]);
    coordinates.value = track.geometry.coordinates;
    tileUrl.value = settings.mapTileUrl;
    mapVisible.value = true;
  } catch (e) {
    mapError.value = e instanceof Error ? e.message : "轨迹不可用";
  } finally {
    mapLoading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <RouterLink class="text-link back-link" to="/activities"
    ><Icon name="previous" :size="16" />运动记录</RouterLink
  >
  <p v-if="error" role="alert" class="error-text">{{ error }}</p>
  <template v-if="activity"
    ><div class="page-heading">
      <div>
        <span class="eyebrow">{{ sportName(activity.sport_type) }}</span>
        <h1>{{ activity.name }}</h1>
        <p>
          {{ activity.local_date }} ·
          {{ new Date(activity.start_time_utc).toLocaleTimeString("zh-CN") }}
        </p>
      </div>
      <div class="heading-actions">
        <a
          v-for="file in activity.files.filter(
            (file) => file.status === 'ready',
          )"
          :key="file.id"
          class="button secondary"
          :href="`/api/v1/activities/${activity.id}/files/${file.id}`"
          download
          ><Icon name="download" :size="16" />FIT</a
        ><Button class="icon-button" aria-label="刷新详情" @click="load"
          ><Icon name="refresh"
        /></Button>
      </div>
    </div>
    <div class="detail-metrics">
      <article
        v-for="metric in [
          {
            label: '距离',
            value: numeric(
              activity.distance_m == null ? null : activity.distance_m / 1000,
              2,
            ),
            unit: 'km',
          },
          { label: '时长', value: duration(activity.duration_s), unit: '' },
          { label: '配速', value: pace(activity.avg_speed_mps), unit: '/km' },
          { label: '平均心率', value: numeric(activity.avg_hr), unit: 'bpm' },
          {
            label: '爬升',
            value: numeric(activity.elevation_gain_m),
            unit: 'm',
          },
          {
            label: '平均功率',
            value: numeric(activity.avg_power_w),
            unit: 'W',
          },
        ]"
        :key="metric.label"
        class="metric-card"
      >
        <span class="muted-label">{{ metric.label }}</span>
        <div class="detail-value">
          {{ metric.value }} <small>{{ metric.unit }}</small>
        </div>
      </article>
    </div>
    <section class="panel settings-panel">
      <div class="panel-heading">
        <h2>轨迹</h2>
        <Button
          v-if="!mapVisible"
          class="button secondary"
          :disabled="
            mapLoading ||
            !activity.files.some((file) => file.status === 'ready')
          "
          @click="showMap"
          ><Icon name="location" :size="16" />{{
            mapLoading ? "读取中…" : "显示轨迹"
          }}</Button
        >
      </div>
      <p v-if="mapError" class="error-text" role="alert">{{ mapError }}</p>
      <TrackMap
        v-if="mapVisible"
        :coordinates="coordinates"
        :tile-url="tileUrl"
      />
      <p v-else class="chart-empty">
        {{
          activity.files.some((file) => file.status === "ready")
            ? "点击显示轨迹"
            : "暂无轨迹"
        }}
      </p>
    </section>
    <p v-if="fileError" class="error-text" role="alert">{{ fileError }}</p>
    <div class="trend-grid">
      <section class="panel">
        <div class="panel-heading"><h2>心率</h2></div>
        <MetricChart
          :labels="labels"
          :series="series('hr_bpm', '心率', '--accent-warm-400')"
          title="活动心率"
          unit="bpm"
        />
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>速度</h2></div>
        <MetricChart
          :labels="labels"
          :series="series('speed_mps', '速度', '--primary-500')"
          title="活动速度"
          unit="m/s"
        />
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>海拔</h2></div>
        <MetricChart
          :labels="labels"
          :series="series('elevation_m', '海拔', '--accent-cold-400')"
          title="活动海拔"
          unit="m"
        />
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>功率</h2></div>
        <MetricChart
          :labels="labels"
          :series="series('power_w', '功率', '--primary-600')"
          title="活动功率"
          unit="W"
        />
      </section>
    </div>
    <section class="panel recent-panel">
      <div class="panel-heading"><h2>分段</h2></div>
      <div v-if="details?.laps.length" class="table-scroll">
        <table class="activity-table">
          <thead>
            <tr>
              <th>分段</th>
              <th>距离</th>
              <th>时长</th>
              <th>配速</th>
              <th>平均心率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="lap in details.laps" :key="String(lap.index)">
              <td>{{ lap.index }}</td>
              <td>
                {{
                  numeric(
                    lap.distance_m == null
                      ? null
                      : Number(lap.distance_m) / 1000,
                    2,
                  )
                }}
                km
              </td>
              <td>{{ duration(lap.duration_s as number | null) }}</td>
              <td>{{ pace(lap.avg_speed_mps as number | null) }}</td>
              <td>{{ numeric(lap.avg_hr) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="chart-empty">暂无分段</p>
    </section>
    <p class="data-source">
      Garmin · {{ new Date(activity.synced_at).toLocaleString("zh-CN") }}
    </p></template
  >
</template>
