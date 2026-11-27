<script setup lang="ts">
import Header from "../components/Header.vue";
import Sidebar from "../components/Sidebar.vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../stores/session";
import { useConnections } from "../stores/connections";
import { useToasts } from "../stores/toasts";

const route = useRoute();
const router = useRouter();
const session = useSession();
const connections = useConnections();
const toasts = useToasts();
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
const mobileQuery = matchMedia("(max-width: 800px)");
const isMobile = ref(mobileQuery.matches);
const sidebarOpen = ref(!isMobile.value);
const sidebar = ref<HTMLElement | null>(null);
const drawerOpen = computed(
  () =>
    isMobile.value &&
    sidebarOpen.value &&
    !!session.owner &&
    route.path !== "/login",
);
function focusMenu() {
  document.querySelector<HTMLButtonElement>(".menu-button")?.focus();
}
async function closeSidebar() {
  sidebarOpen.value = false;
  await nextTick();
  focusMenu();
}
async function toggleSidebar() {
  if (sidebarOpen.value) return closeSidebar();
  sidebarOpen.value = true;
  await nextTick();
  if (isMobile.value)
    sidebar.value?.querySelector<HTMLElement>("a[href], button")?.focus();
}
async function updateViewport() {
  isMobile.value = mobileQuery.matches;
  sidebarOpen.value = !isMobile.value;
  await nextTick();
  if (isMobile.value && sidebar.value?.contains(document.activeElement))
    focusMenu();
}
mobileQuery.addEventListener("change", updateViewport);
watch(
  () => route.fullPath,
  async () => {
    if (!isMobile.value || !sidebarOpen.value) return;
    sidebarOpen.value = false;
    await nextTick();
    document.getElementById("main")?.focus();
  },
);
async function onNavigate() {
  if (isMobile.value) {
    sidebarOpen.value = false;
    await nextTick();
    document.getElementById("main")?.focus();
  }
}
function trapFocus(event: KeyboardEvent) {
  if (!drawerOpen.value) return;
  const items = Array.from(
    sidebar.value?.querySelectorAll<HTMLElement>("button, a[href]") ?? [],
  ).filter(
    (item) => item.getClientRects().length && !item.hasAttribute("disabled"),
  );
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
watch(drawerOpen, (open, _, onCleanup) => {
  if (!open) return;
  const overflow = document.body.style.overflow;
  const notifications = document.querySelector<HTMLElement>(".toast-viewport");
  const notificationsInert = notifications?.inert;
  document.body.style.overflow = "hidden";
  if (notifications) notifications.inert = true;
  onCleanup(() => {
    document.body.style.overflow = overflow;
    if (notifications) notifications.inert = notificationsInert ?? false;
  });
});
onBeforeUnmount(() =>
  mobileQuery.removeEventListener("change", updateViewport),
);
async function logout() {
  try {
    await session.signOut();
    await router.push("/login");
  } catch {
    toasts.add("退出失败，请重试。", "error");
  }
}
</script>
<template>
  <a class="skip-link" href="#main" :inert="drawerOpen">跳转到主要内容</a>
  <div
    v-if="session.owner && route.path !== '/login'"
    class="app-shell"
    :class="{ 'is-sidebar-open': sidebarOpen }"
  >
    <aside
      id="app-sidebar"
      ref="sidebar"
      class="sidebar"
      :inert="!sidebarOpen"
      :role="drawerOpen ? 'dialog' : undefined"
      :aria-modal="drawerOpen ? true : undefined"
      aria-label="主导航侧栏"
      @keydown.esc.stop.prevent="closeSidebar"
      @keydown.tab="trapFocus"
    >
      <Sidebar :owner="session.owner" @navigate="onNavigate" @logout="logout" />
    </aside>
    <div
      v-if="drawerOpen"
      class="sidebar-backdrop"
      aria-hidden="true"
      @click="closeSidebar"
    />
    <div class="main-column" :inert="drawerOpen">
      <Header
        :title="String(route.meta.title || '')"
        :sidebar-open="sidebarOpen"
        :dark="dark"
        @toggle-sidebar="toggleSidebar"
        @toggle-theme="toggleTheme"
      />
      <main id="main" class="page" tabindex="-1">
        <slot />
      </main>
    </div>
  </div>
  <main v-else id="main" tabindex="-1">
    <slot />
  </main>
</template>
