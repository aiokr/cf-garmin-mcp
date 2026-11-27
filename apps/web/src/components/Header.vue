<script setup lang="ts">
import { Button } from "base-ui-vue";
import { Menu } from "@lucide/vue";
import Icon from "./Icon.vue";

defineProps<{ title: string; sidebarOpen: boolean; dark: boolean }>();
const emit = defineEmits<{ "toggle-sidebar": []; "toggle-theme": [] }>();
</script>
<template>
  <header class="topbar">
    <div class="topbar-left">
      <button
        type="button"
        class="icon-button menu-button"
        :aria-label="sidebarOpen ? '收起侧边栏' : '展开侧边栏'"
        aria-controls="app-sidebar"
        :aria-expanded="sidebarOpen"
        @click="emit('toggle-sidebar')"
      >
        <Menu :size="20" aria-hidden="true" />
      </button>
      <span class="breadcrumb">{{ title }}</span>
    </div>
    <div class="topbar-actions">
      <Button
        class="icon-button"
        :aria-label="dark ? '切换浅色主题' : '切换深色主题'"
        @click="emit('toggle-theme')"
        ><Icon :name="dark ? 'sun' : 'moon'"
      /></Button>
    </div>
  </header>
</template>
