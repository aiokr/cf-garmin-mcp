<script setup lang="ts">
import ToastItem from "./ToastItem.vue";
import { useToasts } from "../stores/toasts";
const toasts = useToasts();
</script>
<template>
  <Teleport to="body">
    <ol class="toast-viewport" aria-label="通知">
      <TransitionGroup name="toast">
        <ToastItem
          v-for="toast in toasts.items.value"
          :key="toast.id"
          :toast="toast"
          @dismiss="toasts.dismiss"
        />
      </TransitionGroup>
    </ol>
  </Teleport>
</template>
