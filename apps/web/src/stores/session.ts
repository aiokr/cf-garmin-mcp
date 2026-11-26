import { defineStore } from "pinia";
import { ref } from "vue";
import { api, ApiError } from "../api";
import type { InstanceStatus, Owner } from "../../../../packages/shared/src";

export const useSession = defineStore("session", () => {
  const owner = ref<Owner | null>(null);
  const instance = ref<InstanceStatus | null>(null);
  const error = ref("");
  const ready = ref(false);
  async function refresh() {
    error.value = "";
    try {
      instance.value = await api<InstanceStatus>("/api/v1/instance");
      try {
        owner.value = await api<Owner>("/api/v1/me");
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "AUTH_REQUIRED") throw e;
        owner.value = null;
      }
      ready.value = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "无法连接服务。";
      throw e;
    }
  }
  async function signOut() {
    await api("/api/auth/sign-out", { method: "POST", body: "{}" });
    owner.value = null;
  }
  return { owner, instance, ready, error, refresh, signOut };
});
