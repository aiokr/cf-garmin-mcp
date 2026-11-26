<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Button } from "base-ui-vue";
import { api } from "../api";
import { authClient } from "../api/auth";
import Icon from "../components/Icon.vue";
const request = ref<{
  clientId: string;
  name: string;
  redirectUri: string;
  scopes: string[];
  oauthQuery: string;
} | null>(null);
const selected = ref<string[]>([]);
const error = ref("");
const busy = ref(false);
const labels: Record<string, string> = {
  "profile:read": "基本资料",
  "activities:read": "运动记录与分段",
  "health:read": "日常健康与心率",
  "sleep:read": "睡眠",
  "training:read": "训练指标",
  "location:read": "GPS 位置与轨迹",
  "files:read": "原始活动文件",
  offline_access: "保持访问授权",
};
const destination = computed(() => {
  try {
    return (
      new URL(request.value?.redirectUri || "").host ||
      request.value?.redirectUri
    );
  } catch {
    return request.value?.redirectUri;
  }
});
onMounted(async () => {
  try {
    request.value = await api(`/api/v1/oauth/request${window.location.search}`);
    selected.value = request.value!.scopes.filter(
      (scope) => scope === "profile:read" || scope === "activities:read",
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : "授权请求无效";
  }
});
async function consent(accept: boolean) {
  if (!request.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await authClient.oauth2.consent({
      accept,
      scope: selected.value.join(" "),
      oauth_query: request.value.oauthQuery,
    });
    if (result.error) throw new Error(result.error.message);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "授权失败";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="panel consent-panel">
    <Icon name="shield" :size="32" />
    <h1>授权应用</h1>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <template v-if="request"
      ><h2>{{ request.name }}</h2>
      <dl class="consent-identity">
        <dt>客户端 ID</dt>
        <dd>{{ request.clientId }}</dd>
        <dt>回调地址</dt>
        <dd>{{ destination }}</dd>
      </dl>
      <div class="scope-list">
        <label
          v-for="scope in request.scopes"
          :key="scope"
          class="checkbox-label"
          ><input v-model="selected" type="checkbox" :value="scope" /><span>{{
            labels[scope] || scope
          }}</span
          ><small>{{ scope }}</small></label
        >
      </div>
      <div class="consent-actions">
        <Button
          class="button secondary"
          :disabled="busy"
          @click="consent(false)"
          >拒绝</Button
        ><Button
          class="button primary"
          :disabled="busy || !selected.length"
          @click="consent(true)"
          >允许所选权限<Icon name="arrow" :size="16"
        /></Button></div
    ></template>
  </section>
</template>
