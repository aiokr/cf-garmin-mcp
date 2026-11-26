<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useConnections } from "../stores/connections";
import { Button } from "base-ui-vue";
import { api } from "../api";
import type { ActivitySummary } from "../../../../packages/shared/src";
import ActivityTable from "../components/ActivityTable.vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
const connections = useConnections();
const route = useRoute();
const connectionId = ref(
  typeof route.query.connectionId === "string" ? route.query.connectionId : "",
);
const items = ref<ActivitySummary[]>([]);
const cursor = ref<string | null>(null);
const loading = ref(false);
const error = ref("");
const search = ref("");
const sport = ref("");
const start = ref("");
const end = ref("");
async function load(more = false) {
  loading.value = true;
  error.value = "";
  try {
    const query = new URLSearchParams({ limit: "25" });
    if (connectionId.value) query.set("connectionId", connectionId.value);
    if (search.value) query.set("search", search.value);
    if (sport.value) query.set("sport", sport.value);
    if (start.value) query.set("start", start.value);
    if (end.value) query.set("end", end.value);
    if (more && cursor.value) query.set("cursor", cursor.value);
    const data = await api<{
      items: ActivitySummary[];
      nextCursor: string | null;
    }>(`/api/v1/activities?${query}`);
    items.value = more ? [...items.value, ...data.items] : data.items;
    cursor.value = data.nextCursor;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    loading.value = false;
  }
}
watch([search, sport, start, end, connectionId], () => {
  cursor.value = null;
});
onMounted(() => load());
</script>
<template>
  <div class="page-heading">
    <div>
      <span class="eyebrow">EVERY MOVE COUNTS</span>
      <h1>运动记录<span class="warm-dot">。</span></h1>
    </div>
    <Button
      class="icon-button"
      aria-label="刷新记录"
      :disabled="loading"
      @click="load()"
      ><Icon name="refresh"
    /></Button>
  </div>
  <form class="filter-bar" @submit.prevent="load()">
    <select
      v-if="connections.items.length > 1"
      v-model="connectionId"
      aria-label="数据账号"
      @change="load()"
    >
      <option value="">当前账号</option>
      <option
        v-for="connection in connections.items"
        :key="connection.id"
        :value="connection.id"
      >
        {{ connection.display_name || "Garmin" }} · {{ connection.region }}
      </option>
    </select>
    <input
      v-model="search"
      aria-label="搜索运动名称"
      placeholder="搜索运动…"
      maxlength="100"
    /><select v-model="sport" aria-label="运动类型">
      <option value="">全部运动</option>
      <option value="running">跑步</option>
      <option value="cycling">骑行</option>
      <option value="walking">步行</option>
      <option value="hiking">徒步</option>
      <option value="swimming">游泳</option></select
    ><input v-model="start" type="date" aria-label="开始日期" /><span>—</span
    ><input v-model="end" type="date" aria-label="结束日期" /><Button
      type="submit"
      class="button secondary"
      :disabled="loading"
      ><Icon name="search" :size="16" />筛选</Button
    >
  </form>
  <p v-if="error" role="alert" class="error-text">{{ error }}</p>
  <section class="panel">
    <p v-if="loading && !items.length" class="chart-empty" role="status">
      读取中…
    </p>
    <ActivityTable v-else-if="items.length" :items="items" /><EmptyState
      v-else
      icon="activity"
      title="暂无运动记录"
      description=""
    />
    <div v-if="cursor" class="load-more">
      <Button
        class="button secondary"
        :disabled="loading"
        @click="load(true)"
        >{{ loading ? "读取中…" : "加载更多" }}</Button
      >
    </div>
  </section>
</template>
