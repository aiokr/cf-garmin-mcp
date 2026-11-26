<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { Button } from "base-ui-vue";
import { api } from "../api";
import { useSession } from "../stores/session";
import { useConnections } from "../stores/connections";
import Icon from "../components/Icon.vue";
import EmptyState from "../components/EmptyState.vue";
const session = useSession();
const connections = useConnections();
const error = ref("");
const message = ref("");
const busy = ref(false);
const mfa = ref<{ id: string; challengeId: string; method: string } | null>(
  null,
);
const code = ref("");
const apps = ref<
  {
    clientId: string;
    name: string | null;
    uri: string | null;
    scopes: string[];
    createdAt: number;
    last_accessed_at: string | null;
  }[]
>([]);
const runs = ref<
  {
    id: string;
    stream: string;
    status: string;
    started_at: string;
    connection_id: string;
    start_date: string;
    end_date: string;
    mode: string;
    counts: number;
    error_code: string | null;
  }[]
>([]);
const settings = ref({
  health_history_days: 90,
  activity_history_days: 365,
  auto_sync: true,
  archive_fit: true,
});
const mcpUrl = ref("");
const start = ref(
  new Date(Date.now() - 89 * 86400_000).toLocaleDateString("en-CA"),
);
const end = ref(new Date().toLocaleDateString("en-CA"));
const stream = ref("all");
let settingsLoaded = false;
const currentPassword = ref("");
const newPassword = ref("");
const passwordMessage = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
const statuses: Record<string, string> = {
  connected: "已连接",
  pending: "等待验证",
  needs_reauth: "需要重新验证",
  revoked: "已断开",
  error: "连接失败",
  queued: "等待中",
  running: "同步中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};
const streams: Record<string, string> = {
  activities: "运动记录",
  health: "健康",
  training: "训练",
  files: "原始文件",
  devices: "设备与纪录",
};
async function load() {
  try {
    const [, appData, runData, config] = await Promise.all([
      connections.load(),
      api<{ items: typeof apps.value }>("/api/v1/connected-apps"),
      api<{ items: typeof runs.value }>("/api/v1/sync/runs"),
      api<{
        health_history_days: number;
        activity_history_days: number;
        auto_sync: number;
        archive_fit: number;
        mcpUrl: string;
      }>("/api/v1/settings"),
    ]);
    apps.value = appData.items;
    runs.value = runData.items;
    mcpUrl.value = config.mcpUrl;
    if (!settingsLoaded)
      settings.value = {
        health_history_days: config.health_history_days,
        activity_history_days: config.activity_history_days,
        auto_sync: Boolean(config.auto_sync),
        archive_fit: Boolean(config.archive_fit),
      };
    settingsLoaded = true;
    clearTimeout(timer);
    if (runs.value.some((run) => ["queued", "running"].includes(run.status)))
      timer = setTimeout(load, 10_000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载失败";
  }
}
async function action(operation: () => Promise<unknown>, success = "") {
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await operation();
    message.value = success;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "操作失败";
  } finally {
    busy.value = false;
  }
}
async function connect(id?: string) {
  await action(async () => {
    const result = await api<{
      id?: string;
      status: string;
      challengeId?: string;
      method?: string;
    }>(id ? `/api/v1/connections/${id}/verify` : "/api/v1/connections", {
      method: "POST",
      body: "{}",
    });
    if (result.status === "mfa")
      mfa.value = {
        id: result.id || id!,
        challengeId: result.challengeId!,
        method: result.method || "email",
      };
    else mfa.value = null;
  });
}
async function submitMfa() {
  if (!mfa.value) return;
  const challenge = mfa.value;
  await action(async () => {
    await api(`/api/v1/connections/${challenge.id}/mfa`, {
      method: "POST",
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        code: code.value,
      }),
    });
    mfa.value = null;
    code.value = "";
  }, "已连接");
}
async function disconnect(id: string) {
  if (!confirm("断开 Garmin 连接？")) return;
  await action(
    () => api(`/api/v1/connections/${id}`, { method: "DELETE" }),
    "连接已断开",
  );
  mfa.value = null;
}
async function revoke(clientId: string) {
  if (!confirm("撤销此应用的访问权限？")) return;
  await action(
    () =>
      api(`/api/v1/connected-apps/${encodeURIComponent(clientId)}/revoke`, {
        method: "POST",
        body: "{}",
      }),
    "授权已撤销",
  );
}
async function sync(backfill: boolean) {
  await action(
    () =>
      api("/api/v1/sync", {
        method: "POST",
        body: JSON.stringify(
          backfill
            ? {
                mode: "backfill",
                stream: stream.value,
                start: start.value,
                end: end.value,
              }
            : { stream: "all" },
        ),
      }),
    "同步已开始",
  );
}
async function changePassword() {
  passwordMessage.value = "";
  await action(async () => {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
        revokeOtherSessions: true,
      }),
    });
    currentPassword.value = "";
    newPassword.value = "";
    passwordMessage.value = "密码已更新";
  });
}
async function copyUrl() {
  try {
    await navigator.clipboard.writeText(mcpUrl.value);
    message.value = "已复制";
  } catch {
    error.value = "请手动复制连接地址";
  }
}
onMounted(load);
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <div class="page-heading">
    <div>
      <span class="eyebrow">MAKE IT YOURS</span>
      <h1>设置与连接<span class="warm-dot">。</span></h1>
    </div>
    <Button
      class="icon-button"
      aria-label="刷新设置"
      :disabled="busy"
      @click="load"
      ><Icon name="refresh"
    /></Button>
  </div>
  <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  <p v-if="message" class="success-text" role="status">{{ message }}</p>
  <section class="panel settings-panel">
    <div class="panel-heading">
      <h2>Garmin 连接</h2>
      <Button
        v-if="
          !connections.items.some((item) =>
            ['connected', 'pending'].includes(item.status),
          )
        "
        class="button primary"
        :disabled="busy || !connections.provider?.configured"
        @click="connect()"
        ><Icon name="link" :size="16" />连接 Garmin</Button
      >
    </div>
    <dl class="settings-details">
      <div>
        <dt>认证方式</dt>
        <dd>
          {{
            connections.provider?.mode === "personal_api"
              ? "Personal API"
              : connections.provider?.mode === "credentials"
                ? "账号密码"
                : "—"
          }}
        </dd>
      </div>
      <div>
        <dt>服务区域</dt>
        <dd>
          {{
            connections.provider?.region === "CN"
              ? "中国大陆"
              : connections.provider?.region === "GLOBAL"
                ? "全球"
                : "—"
          }}
        </dd>
      </div>
      <div>
        <dt>凭据配置</dt>
        <dd>
          {{
            connections.provider?.configured
              ? "已配置"
              : connections.provider?.code ===
                  "CONFLICTING_PROVIDER_CREDENTIALS"
                ? "配置冲突"
                : "未配置"
          }}
        </dd>
      </div>
      <div>
        <dt>连接状态</dt>
        <dd>{{ connections.connected ? "已连接" : "未连接" }}</dd>
      </div>
    </dl>
    <div
      v-for="connection in connections.items"
      :key="connection.id"
      class="connection-row"
    >
      <div>
        <strong>{{ connection.display_name || "Garmin" }}</strong><small
          >{{ statuses[connection.status] || connection.status }} ·
          {{ connection.region }}</small
        ><small v-if="connection.last_synced_at">{{
          new Date(connection.last_synced_at).toLocaleString("zh-CN")
        }}</small>
      </div>
      <div class="row-actions">
        <RouterLink
          v-if="connection.status === 'revoked'"
          :to="`/activities?connectionId=${connection.id}`"
          class="text-link"
          >历史记录</RouterLink
        ><template v-else
          ><Button
            class="button secondary"
            :disabled="busy || !connections.provider?.configured"
            @click="connect(connection.id)"
            >重新验证</Button
          ><Button
            class="icon-button"
            aria-label="断开连接"
            :disabled="busy"
            @click="disconnect(connection.id)"
            ><Icon name="unplug" :size="18" /></Button
        ></template>
      </div>
    </div>
    <form v-if="mfa" class="mfa-form" @submit.prevent="submitMfa">
      <label for="mfa-code"
        >Garmin 验证码<input
          id="mfa-code"
          v-model="code"
          autocomplete="one-time-code"
          required
          minlength="4"
          maxlength="12"
          inputmode="text" /></label
      ><Button type="submit" class="button primary" :disabled="busy"
        >验证</Button
      >
    </form>
  </section>
  <section class="panel settings-panel">
    <div class="panel-heading">
      <h2>数据同步</h2>
      <Button
        class="button secondary"
        :disabled="busy || !connections.connected"
        @click="sync(false)"
        ><Icon name="refresh" :size="16" />立即同步</Button
      >
    </div>
    <form
      class="sync-settings"
      @submit.prevent="
        action(
          () =>
            api('/api/v1/settings', {
              method: 'PUT',
              body: JSON.stringify(settings),
            }),
          '设置已保存',
        )
      "
    >
      <label class="checkbox-label"
        ><input v-model="settings.auto_sync" type="checkbox" />自动同步</label
      ><label class="checkbox-label"
        ><input v-model="settings.archive_fit" type="checkbox" />保存原始
        FIT</label
      >
      <div class="settings-fields">
        <label
          >健康历史
          <span class="input-suffix"
            ><input
              v-model.number="settings.health_history_days"
              type="number"
              min="1"
              max="365"
              required
            />天</span
          ></label
        ><label
          >运动历史
          <span class="input-suffix"
            ><input
              v-model.number="settings.activity_history_days"
              type="number"
              min="1"
              max="7300"
              required
            />天</span
          ></label
        ><Button class="button secondary" type="submit" :disabled="busy"
          >保存</Button
        >
      </div>
    </form>
    <form class="filter-bar backfill-form" @submit.prevent="sync(true)">
      <select v-model="stream" aria-label="补录类型">
        <option value="all">全部数据</option>
        <option value="activities">运动记录</option>
        <option value="health">健康</option>
        <option value="training">训练</option>
        <option value="files">原始文件</option></select
      ><input
        v-model="start"
        type="date"
        aria-label="补录开始日期"
        required
      /><span>—</span
      ><input
        v-model="end"
        type="date"
        aria-label="补录结束日期"
        required
      /><Button
        type="submit"
        class="button secondary"
        :disabled="busy || !connections.connected"
        >补录历史</Button
      >
    </form>
    <div v-if="runs.length" class="table-scroll">
      <table class="activity-table">
        <thead>
          <tr>
            <th>数据</th>
            <th>状态</th>
            <th>记录</th>
            <th>开始时间</th>
            <th>诊断</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.id">
            <td>{{ streams[run.stream] || run.stream }}</td>
            <td>{{ statuses[run.status] || run.status }}</td>
            <td>{{ run.counts }}</td>
            <td>{{ new Date(run.started_at).toLocaleString("zh-CN") }}</td>
            <td>
              <code>{{ run.error_code || "—" }}</code><Button
                v-if="['failed', 'partial'].includes(run.status)"
                class="text-button"
                :disabled="busy"
                @click="
                  action(
                    () =>
                      api('/api/v1/sync', {
                        method: 'POST',
                        body: JSON.stringify({
                          connectionId: run.connection_id,
                          stream: run.stream,
                          mode: run.mode,
                          start: run.start_date,
                          end: run.end_date,
                        }),
                      }),
                    '重试已开始',
                  )
                "
                >重试</Button
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="chart-empty">暂无同步记录</p>
  </section>
  <section class="panel settings-panel">
    <div class="panel-heading">
      <h2>AI 客户端</h2>
      <Icon name="shield" />
    </div>
    <div class="mcp-address">
      <input :value="mcpUrl" aria-label="MCP 连接地址" readonly /><Button
        class="button secondary"
        @click="copyUrl"
        ><Icon name="copy" :size="16" />复制</Button
      >
    </div>
    <div v-for="client in apps" :key="client.clientId" class="client-row">
      <div>
        <strong>{{ client.name || client.clientId }}</strong><small>{{
          client.clientId
        }}</small>
        <div class="scope-chips">
          <span v-for="scope in client.scopes" :key="scope">{{ scope }}</span>
        </div>
        <small
          >授权 {{ new Date(client.createdAt).toLocaleDateString("zh-CN") }}
          <template v-if="client.last_accessed_at"
            >· 最近访问
            {{
              new Date(client.last_accessed_at).toLocaleString("zh-CN")
            }}</template
          ></small
        >
      </div>
      <Button
        class="button secondary"
        :disabled="busy"
        @click="revoke(client.clientId)"
        >撤销授权</Button
      >
    </div>
    <EmptyState
      v-if="!apps.length"
      icon="shield"
      title="暂无已授权应用"
      description=""
    />
  </section>
  <section class="panel settings-panel">
    <div class="panel-heading">
      <h2>账户安全</h2>
      <span class="muted-label">{{ session.owner?.email }}</span>
    </div>
    <form class="password-form" @submit.prevent="changePassword">
      <label for="current-password"
        >当前密码<input
          id="current-password"
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
          required
          maxlength="128" /></label
      ><label for="new-password"
        >新密码<input
          id="new-password"
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="12"
          maxlength="128" /></label
      ><Button class="button secondary" type="submit" :disabled="busy"
        >更新密码</Button
      >
      <p v-if="passwordMessage" class="success-text" role="status">
        {{ passwordMessage }}
      </p>
    </form>
  </section>
</template>
