<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { Button } from "base-ui-vue";
import Icon from "./Icon.vue";

defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ disconnect: [] }>();
const menuId = useId();
const root = ref<HTMLElement | null>(null);
const open = ref(false);

function close(restoreFocus = false) {
  open.value = false;
  if (restoreFocus)
    root.value?.querySelector<HTMLButtonElement>("button")?.focus();
}
async function show() {
  open.value = true;
  await nextTick();
  root.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target))
    close();
}
function blur(event: FocusEvent) {
  if (
    !(event.relatedTarget instanceof Node) ||
    !root.value?.contains(event.relatedTarget)
  )
    close();
}
function select() {
  close(true);
  emit("disconnect");
}
onMounted(() => document.addEventListener("pointerdown", outside));
onBeforeUnmount(() => document.removeEventListener("pointerdown", outside));
</script>
<template>
  <div
    ref="root"
    class="connection-menu"
    @focusout="blur"
    @keydown.esc.stop.prevent="close(true)"
  >
    <Button
      class="icon-button"
      aria-label="账户操作"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="menuId"
      :disabled="disabled"
      @click="open ? close() : show()"
      @keydown.down.prevent="show"
      @keydown.up.prevent="show"
      ><Icon name="more" :size="18"
    /></Button>
    <div
      v-if="open"
      :id="menuId"
      class="connection-menu-popup"
      role="menu"
      aria-label="账户操作"
    >
      <Button
        class="connection-menu-item"
        role="menuitem"
        :disabled="disabled"
        @click="select"
        @keydown.down.prevent
        @keydown.up.prevent
        ><Icon name="unplug" :size="18" />取消链接账户</Button
      >
    </div>
  </div>
</template>
<style scoped>
.connection-menu {
  position: relative;
}
.icon-button,
.connection-menu-item {
  height: 36px;
}
.connection-menu-popup {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  min-width: 180px;
  padding: 4px;
  border-radius: 8px;
  background: var(--background-1);
  box-shadow: 0 4px 20px rgb(0 0 0 / 14%);
}
.connection-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 12px;
  white-space: nowrap;
}
.connection-menu-item:hover,
.connection-menu-item:focus-visible {
  background: var(--danger-bg);
}
</style>
