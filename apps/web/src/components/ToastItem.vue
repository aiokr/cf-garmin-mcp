<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { Button } from "base-ui-vue";
import Icon from "./Icon.vue";
import type { Toast } from "../stores/toasts";
const props = defineProps<{ toast: Toast }>();
const emit = defineEmits<{ dismiss: [id: number] }>();
let remaining = props.toast.type === "error" ? 8000 : 4000;
let started = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let hovered = false;
let focused = false;
function mouseEnter() {
  hovered = true;
  pause();
}
function mouseLeave() {
  hovered = false;
  resume();
}
function focusIn() {
  focused = true;
  pause();
}
function focusOut(event: FocusEvent) {
  if (
    !(event.relatedTarget instanceof Node) ||
    !(event.currentTarget as HTMLElement).contains(event.relatedTarget)
  ) {
    focused = false;
    resume();
  }
}
function pause() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  remaining = Math.max(0, remaining - (Date.now() - started));
}
function resume() {
  if (hovered || focused || timer !== undefined || document.hidden) return;
  started = Date.now();
  timer = setTimeout(() => emit("dismiss", props.toast.id), remaining);
}
function visibilityChanged() {
  if (document.hidden) pause();
  else resume();
}
onMounted(() => {
  resume();
  document.addEventListener("visibilitychange", visibilityChanged);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", visibilityChanged);
});
</script>
<template>
  <li
    class="app-toast"
    :data-type="toast.type"
    @mouseenter="mouseEnter"
    @mouseleave="mouseLeave"
    @focusin="focusIn"
    @focusout="focusOut"
    @keydown.esc.stop="emit('dismiss', toast.id)"
  >
    <Icon
      :name="toast.type === 'success' ? 'check' : 'close'"
      :size="18"
      class="toast-indicator"
    />
    <p :role="toast.type === 'error' ? 'alert' : 'status'" aria-atomic="true">
      {{ toast.message }}
    </p>
    <Button
      class="icon-button toast-close"
      aria-label="关闭通知"
      @click="emit('dismiss', toast.id)"
      ><Icon name="close" :size="16"
    /></Button>
  </li>
</template>
