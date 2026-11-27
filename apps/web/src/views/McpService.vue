<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Button } from "base-ui-vue";
import { api } from "../api";
import { useToasts } from "../stores/toasts";
import Icon from "../components/Icon.vue";
import {
  MCP_SCOPES,
  type PersonalAccessToken,
} from "../../../../packages/shared/src";

const toasts = useToasts();
const loading = ref(false);
const busy = ref(false);
const mcpUrl = ref("");
const method = ref<"oauth" | "pat">("oauth");
const pats = ref<PersonalAccessToken[]>([]);
const name = ref("");
const expiresInDays = ref(30);
const selectedScopes = ref<string[]>(["profile:read", "activities:read"]);
const createdToken = ref("");
const scopeLabels: Record<string, string> = {
  "profile:read": "基本资料",
  "activities:read": "运动记录与分段",
  "health:read": "日常健康与心率",
  "sleep:read": "睡眠",
  "training:read": "训练指标",
  "location:read": "GPS 位置与轨迹",
  "files:read": "原始活动文件（预留权限）",
};
const date = (value: number) => new Date(value).toLocaleString("zh-CN");
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

async function load() {
  loading.value = true;
  try {
    const [config, appData, patData] = await Promise.all([
      api<{ mcpUrl: string }>("/api/v1/settings"),
      api<{ items: typeof apps.value }>("/api/v1/connected-apps"),
      api<{ items: PersonalAccessToken[] }>("/api/v1/mcp/pats"),
    ]);
    mcpUrl.value = config.mcpUrl;
    apps.value = appData.items;
    pats.value = patData.items;
  } catch (error) {
    toasts.add(error instanceof Error ? error.message : "加载失败", "error");
  } finally {
    loading.value = false;
  }
}
async function generatePat() {
  busy.value = true;
  createdToken.value = "";
  try {
    const result = await api<PersonalAccessToken & { token: string }>(
      "/api/v1/mcp/pats",
      {
        method: "POST",
        body: JSON.stringify({
          name: name.value,
          scopes: selectedScopes.value,
          expiresInDays: expiresInDays.value,
        }),
      },
    );
    createdToken.value = result.token;
    name.value = "";
    toasts.add("PAT Key 已创建，请保存密钥");
    await load();
  } catch (error) {
    toasts.add(error instanceof Error ? error.message : "创建失败", "error");
  } finally {
    busy.value = false;
  }
}
async function copyToken() {
  try {
    await navigator.clipboard.writeText(createdToken.value);
    toasts.add("密钥已复制");
  } catch {
    toasts.add("请手动复制密钥", "error");
  }
}
async function revokePat(item: PersonalAccessToken) {
  if (
    !confirm(`撤销“${item.name}”的 PAT Key？使用此密钥的客户端将无法继续访问。`)
  )
    return;
  busy.value = true;
  try {
    await api(`/api/v1/mcp/pats/${item.id}/revoke`, {
      method: "POST",
      body: "{}",
    });
    createdToken.value = "";
    toasts.add("PAT Key 已撤销");
    await load();
  } catch (error) {
    toasts.add(error instanceof Error ? error.message : "撤销失败", "error");
  } finally {
    busy.value = false;
  }
}
async function copyUrl() {
  try {
    await navigator.clipboard.writeText(mcpUrl.value);
    toasts.add("已复制");
  } catch {
    toasts.add("请手动复制连接地址", "error");
  }
}
async function revoke(clientId: string) {
  if (!confirm("撤销此应用的访问权限？")) return;
  busy.value = true;
  try {
    await api(`/api/v1/connected-apps/${encodeURIComponent(clientId)}/revoke`, {
      method: "POST",
      body: "{}",
    });
    toasts.add("授权已撤销");
    await load();
  } catch (error) {
    toasts.add(error instanceof Error ? error.message : "撤销失败", "error");
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="mcp-service">
    <div class="page-heading">
      <div>
        <span class="eyebrow">MCP SERVICE</span>
        <h1>MCP 服务<span class="warm-dot">。</span></h1>
      </div>
      <Button
        class="button secondary"
        aria-label="刷新 MCP 服务"
        :disabled="loading || busy"
        @click="load"
        ><Icon name="refresh" :size="16" />刷新</Button
      >
    </div>
    <section aria-label="MCP 连接">
      <label for="mcp-url">MCP 连接地址</label>
      <div class="mcp-address">
        <input id="mcp-url" :value="mcpUrl" readonly />
        <Button
          class="button secondary"
          :disabled="!mcpUrl || loading"
          @click="copyUrl"
        >
          <Icon name="copy" :size="16" />复制
        </Button>
      </div>
    </section>
    <section class="auth-method" aria-labelledby="auth-heading">
      <h2 id="auth-heading">认证方式</h2>
      <div class="method-options">
        <Button
          class="button secondary"
          :aria-pressed="method === 'oauth'"
          @click="method = 'oauth'"
          >OAuth</Button
        >
        <Button
          class="button secondary"
          :aria-pressed="method === 'pat'"
          @click="method = 'pat'"
          >PAT Key</Button
        >
      </div>
      <p v-if="method === 'oauth'" class="method-help">
        在支持 OAuth 的客户端添加上方地址，登录后选择访问权限。
      </p>
      <p v-else class="method-help">
        在客户端的 PAT_key 或 Bearer Token 配置中填写密钥，请求头使用
        <code>Authorization: Bearer &lt;PAT_key&gt;</code>。
      </p>
    </section>
    <section
      v-if="method === 'oauth'"
      class="mcp-clients"
      aria-labelledby="clients-heading"
      :aria-busy="loading"
    >
      <h2 id="clients-heading">OAuth 已授权应用</h2>
      <div v-for="client in apps" :key="client.clientId" class="client-row">
        <div>
          <strong>{{ client.name || client.clientId }}</strong>
          <small>{{ client.clientId }}</small>
          <div class="scope-chips">
            <span v-for="scope in client.scopes" :key="scope">{{ scope }}</span>
          </div>
          <small>
            授权 {{ new Date(client.createdAt).toLocaleDateString("zh-CN") }}
            <template v-if="client.last_accessed_at">
              · 最近访问
              {{ new Date(client.last_accessed_at).toLocaleString("zh-CN") }}
            </template>
          </small>
        </div>
        <Button
          class="button secondary"
          :disabled="busy || loading"
          @click="revoke(client.clientId)"
        >
          撤销授权
        </Button>
      </div>
      <p v-if="loading && !apps.length" class="mcp-empty" role="status">
        读取中…
      </p>
      <p v-else-if="!apps.length" class="mcp-empty">暂无已授权应用</p>
    </section>
    <section
      v-else
      class="mcp-clients"
      aria-labelledby="pat-heading"
      :aria-busy="loading || busy"
    >
      <h2 id="pat-heading">个人访问密钥</h2>
      <div v-if="createdToken" class="created-token" role="status">
        <strong>密钥只在创建后显示一次，请立即保存。</strong>
        <div class="mcp-address">
          <input
            aria-label="新建的 PAT Key"
            :value="createdToken"
            readonly
            spellcheck="false"
          />
          <Button class="button secondary" @click="copyToken"
            ><Icon name="copy" :size="16" />复制密钥</Button
          >
        </div>
        <Button class="button secondary" @click="createdToken = ''"
          >已保存，关闭</Button
        >
      </div>
      <form class="pat-form" @submit.prevent="generatePat">
        <div class="pat-fields">
          <label
            >名称<input
              v-model="name"
              required
              maxlength="80"
              placeholder="例如：桌面客户端"
              :disabled="busy || loading"
          /></label>
          <label
            >有效期<select
              v-model.number="expiresInDays"
              :disabled="busy || loading"
            >
              <option :value="30">30 天</option>
              <option :value="90">90 天</option>
              <option :value="365">365 天</option>
            </select></label
          >
        </div>
        <fieldset>
          <legend>访问权限</legend>
          <div class="pat-scopes">
            <label v-for="scope in MCP_SCOPES" :key="scope"
              ><input
                v-model="selectedScopes"
                type="checkbox"
                :value="scope"
                :disabled="busy || loading"
              />{{ scopeLabels[scope] }}</label
            >
          </div>
        </fieldset>
        <Button
          class="button secondary"
          type="submit"
          :disabled="
            busy ||
            loading ||
            !name.trim() ||
            !selectedScopes.length ||
            !!createdToken
          "
          >创建 PAT Key</Button
        >
      </form>
      <div v-for="item in pats" :key="item.id" class="client-row">
        <div>
          <strong>{{ item.name }}</strong>
          <small
            >••••{{ item.hint }} ·
            {{
              item.revokedAt
                ? "已撤销"
                : item.expiresAt <= Date.now()
                  ? "已过期"
                  : "有效"
            }}</small
          >
          <div class="scope-chips">
            <span v-for="scope in item.scopes" :key="scope">{{ scope }}</span>
          </div>
          <small
            >到期 {{ date(item.expiresAt) }} ·
            {{
              item.lastUsedAt ? `最近使用 ${date(item.lastUsedAt)}` : "尚未使用"
            }}</small
          >
        </div>
        <Button
          v-if="!item.revokedAt && item.expiresAt > Date.now()"
          class="button secondary"
          :disabled="busy || loading"
          @click="revokePat(item)"
          >撤销密钥</Button
        >
      </div>
      <p v-if="!pats.length && !loading" class="mcp-empty">暂无个人访问密钥</p>
    </section>
  </div>
</template>
<style scoped>
label {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
}
.mcp-address {
  max-width: 680px;
  margin: 0;
}
.mcp-clients {
  margin-top: 32px;
}
.auth-method {
  margin-top: 32px;
}
.method-options,
.pat-fields {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.method-options [aria-pressed="true"] {
  border-color: var(--primary-300);
  background: var(--list-hover);
}
.method-help {
  margin-top: 12px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.pat-form {
  max-width: 680px;
  margin-bottom: 24px;
}
.pat-fields label {
  display: grid;
  gap: 8px;
}
.pat-fields label:first-child {
  flex: 1;
  min-width: 200px;
}
.pat-fields select {
  height: 36px;
  padding-block: 0;
}
fieldset {
  margin: 12px 0 20px;
  padding: 0;
  border: 0;
}
legend {
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 500;
}
.pat-scopes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.pat-scopes label {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-weight: 400;
}
.pat-scopes input {
  width: 16px;
  height: 16px;
  min-height: 16px;
}
.created-token {
  margin-bottom: 24px;
  padding: 16px;
  background: var(--input);
  border: 1px solid var(--border-1);
  border-radius: 6px;
}
.created-token strong {
  display: block;
  font-size: 13px;
}
.created-token .mcp-address {
  margin: 12px 0;
}
h2 {
  margin-bottom: 14px;
  font-size: 16px;
  font-weight: 600;
}
.client-row {
  padding: 16px 0;
  border: 0;
}
.client-row small {
  font-size: 11px;
  line-height: 1.5;
}
.mcp-empty {
  color: var(--text-2);
  font-size: 13px;
}
input,
.button {
  height: 36px;
  min-height: 36px;
  padding-block: 0;
}
.button {
  gap: 8px;
  background: var(--input);
  font-size: 12px;
  white-space: nowrap;
}
.button:hover {
  background: var(--list-hover);
}
</style>
