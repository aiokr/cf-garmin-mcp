<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Button } from "base-ui-vue";
import { useSession } from "./stores/session";
import Icon from "./components/Icon.vue";
import { useConnections } from "./stores/connections";

const route = useRoute();
const router = useRouter();
const session = useSession();
const connections = useConnections();
watch(
  () => session.owner?.id,
  (id) => {
    if (id) connections.load().catch(() => undefined);
    else connections.clear();
  },
  { immediate: true },
);
const dark = ref(
  localStorage.getItem("theme") === "dark" ||
    (!localStorage.getItem("theme") &&
      matchMedia("(prefers-color-scheme: dark)").matches),
);
function applyTheme() {
  document.documentElement.dataset.theme = dark.value ? "dark" : "light";
}
applyTheme();
function toggleTheme() {
  dark.value = !dark.value;
  localStorage.setItem("theme", dark.value ? "dark" : "light");
  applyTheme();
}
const navigation = [
  { path: "/", title: "总览", icon: "grid" },
  { path: "/activities", title: "运动记录", icon: "activity" },
  { path: "/health", title: "健康趋势", icon: "heart" },
  { path: "/training", title: "训练状态", icon: "training" },
];
const logoutError = ref("");
async function logout() {
  try {
    await session.signOut();
    await router.push("/login");
  } catch {
    logoutError.value = "退出失败，请重试。";
  }
}
</script>
<template>
  <a class="skip-link" href="#main">跳转到主要内容</a>
  <div v-if="session.owner && route.path !== '/login'" class="app-shell">
    <aside class="sidebar">
      <RouterLink to="/" class="brand"
        ><span class="brand-symbol"><Icon name="pulse" :size="25" /></span
        ><span
          >Garmin<span class="brand-suffix"> / personal</span></span
        ></RouterLink
      >
      <p class="nav-caption">我的空间</p>
      <nav aria-label="主导航">
        <RouterLink
          v-for="item in navigation"
          :key="item.path"
          :to="item.path"
          :class="{
            active:
              item.path === '/'
                ? route.path === '/'
                : route.path.startsWith(item.path),
          }"
          ><Icon :name="item.icon" />{{ item.title
          }}<span
            v-if="
              item.path === '/'
                ? route.path === '/'
                : route.path.startsWith(item.path)
            "
            class="nav-dot"
        /></RouterLink>
      </nav>
      <div class="sidebar-bottom">
        <RouterLink class="settings-link" to="/settings"
          ><Icon name="settings" />设置与连接</RouterLink
        >
        <div class="owner-card">
          <span class="avatar">{{
            session.owner.name.slice(0, 1).toUpperCase()
          }}</span>
          <div>
            <strong>{{ session.owner.name }}</strong><small></small>
          </div>
          <Button class="icon-button" aria-label="退出登录" @click="logout"
            ><Icon name="logout" :size="18"
          /></Button>
        </div>
        <p v-if="logoutError" role="alert" class="error-text">
          {{ logoutError }}
        </p>
      </div>
    </aside>
    <div class="main-column">
      <header class="topbar">
        <span class="breadcrumb"
          >我的空间 <span>/</span> {{ route.meta.title }}</span
        >
        <div class="topbar-actions">
          <span class="connection-label"
            ><span class="status-dot" />{{
              connections.connected ? "已连接" : "未连接"
            }}</span
          ><RouterLink
            class="icon-button mobile-only"
            to="/settings"
            aria-label="设置与连接"
            ><Icon name="settings" /></RouterLink
          ><Button
            class="icon-button"
            :aria-label="dark ? '切换浅色主题' : '切换深色主题'"
            @click="toggleTheme"
            ><Icon :name="dark ? 'sun' : 'moon'" /></Button
          ><Button
            class="icon-button mobile-only"
            aria-label="退出登录"
            @click="logout"
            ><Icon name="logout" :size="18"
          /></Button>
        </div>
      </header>
      <main id="main" class="page">
        <p v-if="logoutError" class="error-text mobile-only" role="alert">
          {{ logoutError }}
        </p>
        <RouterView :key="route.fullPath" />
      </main>
      <footer class="page-footer">
        <span>cf-garmin-mcp</span><span>让运动留下回响。</span>
      </footer>
    </div>
  </div>
  <main v-else id="main"><RouterView :key="route.fullPath" /></main>
</template>
