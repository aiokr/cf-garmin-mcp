<script setup lang="ts">
import { useRoute } from "vue-router";
import MainLayout from "./layouts/MainLayout.vue";
import ToastViewport from "./components/ToastViewport.vue";

const route = useRoute();
</script>
<template>
  <MainLayout>
    <RouterView :key="route.fullPath" />
  </MainLayout>
  <ToastViewport />
</template>
