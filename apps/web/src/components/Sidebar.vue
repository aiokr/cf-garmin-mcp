<script setup lang="ts">
import { useRoute } from "vue-router";
import { Button } from "base-ui-vue";
import type { Owner } from "../../../../packages/shared/src";
import Icon from "./Icon.vue";

defineProps<{ owner: Owner }>();
const emit = defineEmits<{ navigate: []; logout: [] }>();
const route = useRoute();
const navigation = [
  { path: "/", title: "总览", icon: "grid" },
  { path: "/activities", title: "运动记录", icon: "activity" },
  { path: "/health", title: "健康趋势", icon: "heart" },
  { path: "/training", title: "训练状态", icon: "training" },
  { path: "/mcp-service", title: "MCP 服务", icon: "link" },
  { path: "/settings", title: "设置", icon: "settings" },
];
function isActive(path: string) {
  return path === "/"
    ? route.path === "/"
    : route.path === path || route.path.startsWith(path + "/");
}
</script>
<template>
  <div class="sidebar-top">
    <RouterLink to="/" class="brand" @click="emit('navigate')">
      CF-Garmin-MCP
    </RouterLink>
  </div>
  <nav class="sidebar-nav" aria-label="主导航">
    <RouterLink
      v-for="item in navigation"
      :key="item.path"
      :to="item.path"
      class="nav-link"
      :class="{ active: isActive(item.path) }"
      :aria-current="isActive(item.path) ? 'page' : undefined"
      @click="emit('navigate')"
    >
      <Icon :name="item.icon" :size="18" /><span>{{ item.title }}</span>
    </RouterLink>
  </nav>
  <div class="sidebar-bottom">
    <div class="owner-card">
      <div>
        <strong :title="owner.name">{{ owner.name }}</strong>
      </div>
      <Button class="icon-button" aria-label="退出登录" @click="emit('logout')">
        <Icon name="logout" :size="18" />
      </Button>
    </div>
  </div>
</template>
