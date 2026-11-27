<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from "vue";
import { Button } from "base-ui-vue";
import { api } from "../api";
import { useToasts } from "../stores/toasts";
import { useSession } from "../stores/session";
import { useConnections } from "../stores/connections";
import Icon from "../components/Icon.vue";
import ConnectionActions from "../components/ConnectionActions.vue";
const session = useSession();
const connections = useConnections();
const toasts = useToasts();
const busy = ref(false);
const sections = [
  { id: "connection", title: "Garmin 连接", icon: "link" },
  { id: "sync", title: "数据同步", icon: "refresh" },
  { id: "history", title: "同步记录", icon: "clock" },
  { id: "security", title: "账户安全", icon: "shield" },
] as const;
const activeSection = ref<(typeof sections)[number]["id"]>("connection");
let sectionFrame: number | undefined;
function updateActiveSection() {
  sectionFrame = undefined;
  let current: (typeof sections)[number]["id"] = "connection";
  for (const section of sections) {
    const element = document.getElementById(`settings-${section.id}`);
    if (element && element.getBoundingClientRect().top <= 110)
      current = section.id;
  }
  activeSection.value = current;
}
function scheduleSectionUpdate() {
  if (sectionFrame === undefined)
    sectionFrame = requestAnimationFrame(updateActiveSection);
}
function scrollToSection(id: (typeof sections)[number]["id"]) {
  const element = document.getElementById(`settings-${id}`);
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "start",
  });
}
const accountInitial = computed(() =>
  (session.owner?.name || session.owner?.email || "G")
    .slice(0, 1)
    .toUpperCase(),
);
const mfa = ref<{ id: string; challengeId: string; method: string } | null>(
  null,
);
const code = ref("");
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
    unavailable_sources?: string[];
  }[]
>([]);
const historyPage = ref(1);
const historyPages = computed(() =>
  Math.max(1, Math.ceil(runs.value.length / 10)),
);
const visibleRuns = computed(() =>
  runs.value.slice((historyPage.value - 1) * 10, historyPage.value * 10),
);
const settings = ref({
  health_history_days: 90,
  activity_history_days: 365,
  auto_sync: true,
  archive_fit: true,
});
const start = ref(
  new Date(Date.now() - 89 * 86400_000).toLocaleDateString("en-CA"),
);
const end = ref(new Date().toLocaleDateString("en-CA"));
const stream = ref("all");
const showBackfill = ref(false);
let settingsLoaded = false;
const currentPassword = ref("");
const newPassword = ref("");
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
    const [, runData, config] = await Promise.all([
      connections.load(),
      api<{ items: typeof runs.value }>("/api/v1/sync/runs"),
      api<{
        health_history_days: number;
        activity_history_days: number;
        auto_sync: number;
        archive_fit: number;
      }>("/api/v1/settings"),
    ]);
    runs.value = runData.items;
    historyPage.value = Math.min(historyPage.value, historyPages.value);
    if (!settingsLoaded)
      settings.value = {
        health_history_days: config.health_history_days,
        activity_history_days: config.activity_history_days,
        auto_sync: Boolean(config.auto_sync),
        archive_fit: Boolean(config.archive_fit),
      };
    settingsLoaded = true;
    scheduleSectionUpdate();
    clearTimeout(timer);
    if (runs.value.some((run) => ["queued", "running"].includes(run.status)))
      timer = setTimeout(load, 10_000);
  } catch (e) {
    toasts.add(e instanceof Error ? e.message : "加载失败", "error");
  }
}
async function action(operation: () => Promise<unknown>, success = "") {
  busy.value = true;
  try {
    await operation();
    toasts.add(success);
    await load();
  } catch (e) {
    toasts.add(e instanceof Error ? e.message : "操作失败", "error");
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
  if (
    !confirm(
      "取消链接 Garmin 账户？\n取消后将停止同步并取消进行中的同步任务，已同步的历史数据会保留。",
    )
  )
    return;
  await action(
    () => api(`/api/v1/connections/${id}`, { method: "DELETE" }),
    "连接已断开",
  );
  mfa.value = null;
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
    toasts.add("密码已更新");
  });
}
onMounted(() => {
  load();
  scheduleSectionUpdate();
  window.addEventListener("scroll", scheduleSectionUpdate, { passive: true });
  window.addEventListener("resize", scheduleSectionUpdate);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  if (sectionFrame !== undefined) cancelAnimationFrame(sectionFrame);
  window.removeEventListener("scroll", scheduleSectionUpdate);
  window.removeEventListener("resize", scheduleSectionUpdate);
});
</script>
<template>
  <div class="settings-page">
    <header class="settings-header">
      <div class="settings-owner">
        <span class="settings-avatar" aria-hidden="true">{{
          accountInitial
        }}</span>
        <div>
          <h1>{{ session.owner?.name || "我的账户" }}</h1>
          <p>账户设置</p>
        </div>
      </div>
      <Button
        class="button secondary"
        aria-label="刷新设置"
        :disabled="busy"
        @click="load"
      >
        <Icon name="refresh" :size="16" />刷新
      </Button>
    </header>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="本页目录">
        <a
          v-for="section in sections"
          :key="section.id"
          class="settings-nav-item"
          :class="{ active: activeSection === section.id }"
          :href="`#settings-${section.id}`"
          :aria-current="activeSection === section.id ? 'location' : undefined"
          @click.prevent="scrollToSection(section.id)"
        >
          <Icon :name="section.icon" :size="16" />{{ section.title }}
        </a>
      </nav>
      <div class="settings-content">
        <section
          id="settings-connection"
          tabindex="-1"
          class="settings-section"
          aria-labelledby="connection-heading"
        >
          <div class="panel-heading">
            <h2 id="connection-heading">Garmin 连接</h2>
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
          <h3 v-if="connections.items.length" class="settings-subheading">
            已链接账户
          </h3>
          <div
            v-for="connection in connections.items"
            :key="connection.id"
            class="connection-row"
          >
            <div class="connection-details">
              <strong
                class="connection-name"
                :title="connection.display_name || 'Garmin'"
                >{{ connection.display_name || "Garmin" }}</strong><small
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
              ><template v-else>
                <ConnectionActions
                  :disabled="busy"
                  @disconnect="disconnect(connection.id)"
                />
                <Button
                  class="button secondary"
                  :disabled="busy || !connections.provider?.configured"
                  @click="connect(connection.id)"
                  >重新验证</Button
                ></template
              >
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
        <section
          id="settings-sync"
          tabindex="-1"
          class="settings-section"
          aria-labelledby="sync-heading"
        >
          <div class="panel-heading">
            <h2 id="sync-heading">数据同步</h2>
            <div class="row-actions">
              <Button
                class="button secondary"
                :disabled="busy || !connections.connected"
                @click="sync(false)"
                ><Icon name="refresh" :size="16" />立即同步</Button
              >
              <Button
                class="button secondary"
                :aria-expanded="showBackfill"
                aria-controls="sync-backfill"
                @click="showBackfill = !showBackfill"
                >{{ showBackfill ? "收起补录" : "补录历史" }}</Button
              >
            </div>
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
              ><input
                v-model="settings.auto_sync"
                type="checkbox"
              />自动同步</label
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
          <form
            v-if="showBackfill"
            id="sync-backfill"
            class="filter-bar backfill-form"
            @submit.prevent="sync(true)"
          >
            <select v-model="stream" aria-label="补录类型">
              <option value="all">全部数据</option>
              <option value="activities">运动记录</option>
              <option value="health">健康</option>
              <option
                value="training"
                :disabled="connections.provider?.mode === 'personal_api'"
              >
                训练{{
                  connections.provider?.mode === "personal_api"
                    ? "（Personal API 不支持）"
                    : ""
                }}
              </option>
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
        </section>
        <section
          id="settings-history"
          tabindex="-1"
          class="settings-section"
          aria-labelledby="history-heading"
        >
          <div class="panel-heading">
            <h2 id="history-heading">同步记录</h2>
            <span class="settings-count">{{ runs.length }} 条记录</span>
          </div>
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
                <tr v-for="run in visibleRuns" :key="run.id">
                  <td>{{ streams[run.stream] || run.stream }}</td>
                  <td>
                    <span class="sync-status" :data-status="run.status">{{
                      statuses[run.status] || run.status
                    }}</span>
                  </td>
                  <td>{{ run.counts }}</td>
                  <td>
                    {{ new Date(run.started_at).toLocaleString("zh-CN") }}
                  </td>
                  <td>
                    <div class="sync-diagnostic-heading">
                      <code>{{ run.error_code || "—" }}</code>
                      <Button
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
                    </div>
                    <small
                      v-if="run.unavailable_sources?.length"
                      class="sync-missing-sources"
                    >
                      {{ run.unavailable_sources.join("、") }}
                    </small>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="settings-empty">暂无同步记录</p>
          <div v-if="runs.length" class="pagination" aria-label="同步历史分页">
            <Button
              class="button secondary"
              :disabled="historyPage <= 1"
              @click="historyPage--"
              >上一页</Button
            >
            <span aria-live="polite"
              >第 {{ historyPage }} / {{ historyPages }} 页 · 共
              {{ runs.length }} 条 · 每页 10 条</span
            >
            <Button
              class="button secondary"
              :disabled="historyPage >= historyPages"
              @click="historyPage++"
              >下一页</Button
            >
          </div>
        </section>
        <section
          id="settings-security"
          tabindex="-1"
          class="settings-section"
          aria-labelledby="security-heading"
        >
          <div class="panel-heading">
            <h2 id="security-heading">账户安全</h2>
          </div>
          <dl class="security-account">
            <dt>登录邮箱</dt>
            <dd>{{ session.owner?.email }}</dd>
          </dl>
          <h3 class="settings-subheading">修改密码</h3>
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
          </form>
        </section>
      </div>
    </div>
  </div>
</template>
<style scoped>
.settings-page {
  max-width: 1120px;
  margin: 0 auto;
  padding-bottom: 40px;
}
.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 32px;
}
.settings-owner {
  display: flex;
  align-items: center;
  gap: 12px;
}
.settings-avatar {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--primary-50);
  color: var(--primary-600);
  font-size: 18px;
  font-weight: 500;
}
.settings-owner h1 {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1.5;
}
.settings-owner p {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
}
.settings-layout {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 40px;
  align-items: start;
}
.settings-nav {
  position: sticky;
  top: 90px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.settings-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 36px;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: var(--input);
  color: var(--text-1);
  font-size: 13px;
  text-align: left;
}
.settings-nav-item :deep(svg) {
  color: var(--text-2);
}
.settings-nav-item:hover {
  background: var(--list-hover);
}
.settings-nav-item.active {
  background: var(--background-2);
  font-weight: 600;
}
.settings-nav-item.active::before {
  content: "";
  position: absolute;
  left: -7px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 2px;
  background: var(--primary-500);
}
.settings-content,
.settings-section {
  min-width: 0;
}
.settings-section {
  scroll-margin-top: 16px;
}
.settings-section:focus {
  outline: none;
}
.settings-section + .settings-section {
  margin-top: 48px;
}
.settings-section:last-child {
  min-height: calc(100dvh - 114px);
}
.settings-section > .panel-heading {
  min-height: 46px;
  padding: 0 0 12px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--border-1);
  flex-wrap: wrap;
  gap: 12px;
}
.settings-section h2 {
  font-size: 23px;
  line-height: 1.4;
  font-weight: 400;
  letter-spacing: -0.4px;
}
.settings-subheading {
  margin: 28px 0 14px;
  font-size: 14px;
  font-weight: 600;
}
.settings-details {
  margin: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px 32px;
  max-width: 600px;
}
.settings-details dt {
  margin-bottom: 6px;
  font-size: 12px;
}
.settings-details dd {
  font-size: 13px;
  font-weight: 500;
}
.connection-row {
  border: 0;
  padding: 14px 0;
}
.connection-row:first-of-type {
  padding-top: 0;
}
.connection-name {
  font-size: 13px;
}
.connection-row small {
  font-size: 11px;
  line-height: 1.5;
}
.settings-section label,
.security-account dt {
  font-size: 13px;
  font-weight: 500;
}
.sync-settings {
  margin: 0;
  gap: 24px;
}
.sync-settings > .checkbox-label {
  gap: 8px;
}
.settings-fields {
  gap: 16px;
}
.settings-fields input {
  width: 80px;
}
.backfill-form {
  margin: 28px 0 0;
  border-top: 0;
  padding-top: 0;
}
.backfill-form select {
  max-width: 200px;
}
.table-scroll {
  padding: 0;
}
.activity-table {
  font-size: 12px;
}
.activity-table th,
.activity-table td {
  border: 0;
  padding: 12px 10px;
}
.activity-table th {
  font-size: 11px;
}
.activity-table :is(th, td):first-child {
  padding-left: 0;
}
.activity-table :is(th, td):last-child {
  padding-right: 0;
}
.activity-table td:last-child {
  min-width: 200px;
  max-width: 340px;
  white-space: normal;
}
.activity-table code {
  font-size: 10px;
  overflow-wrap: anywhere;
}
.sync-diagnostic-heading .text-button {
  flex-shrink: 0;
  font-size: 11px;
}
.settings-count {
  color: var(--text-2);
  font-size: 12px;
}
.pagination {
  padding: 20px 0;
  gap: 12px;
  font-size: 11px;
}
.settings-empty {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
}
.security-account {
  margin: 0;
}
.security-account dd {
  margin: 7px 0 0;
  color: var(--text-2);
  font-size: 13px;
}
.password-form,
.mfa-form {
  max-width: 440px;
  margin: 0;
}
.mfa-form {
  margin-top: 24px;
}
.password-form label {
  margin-bottom: 20px;
}
input:not([type="checkbox"]),
select,
.button,
.icon-button {
  height: 36px;
  min-height: 36px;
  padding-block: 0;
}
.button {
  font-size: 12px;
  gap: 8px;
  white-space: nowrap;
}
.button.secondary {
  background: var(--input);
}
.button.secondary:hover {
  background: var(--list-hover);
}
input:not([type="checkbox"]),
select {
  border: 1px solid var(--border-1);
  background: var(--input);
  font-size: 13px;
}
@media (max-width: 1100px) {
  .settings-layout {
    grid-template-columns: 156px minmax(0, 1fr);
    gap: 28px;
  }
  .sync-settings {
    gap: 20px;
  }
}
@media (max-width: 800px) {
  .settings-header {
    margin-bottom: 24px;
  }
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
  }
  .settings-nav {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px;
  }
  .settings-nav-item {
    padding-inline: 10px;
  }
  .settings-nav-item.active::before {
    left: 10px;
    right: 10px;
    top: auto;
    bottom: 0;
    height: 2px;
    width: auto;
  }
  .settings-section h2 {
    font-size: 21px;
  }
  .settings-section > .panel-heading > .row-actions {
    justify-content: flex-start;
  }
  .settings-details {
    gap: 22px;
  }
  .settings-fields {
    gap: 12px;
  }
  .connection-row {
    flex-wrap: wrap;
  }
  .connection-details {
    flex-basis: 100%;
  }
  .pagination {
    padding-bottom: 20px;
  }
}
</style>
