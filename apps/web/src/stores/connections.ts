import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "../api";
import type { ProviderStatus } from "../../../../packages/shared/src";
export type ConnectionSummary = {
  id: string;
  region: string;
  auth_type: string;
  display_name: string | null;
  status: string;
  last_verified_at: string | null;
  last_synced_at: string | null;
  last_error_code: string | null;
};
export const useConnections = defineStore("connections", () => {
  const provider = ref<ProviderStatus | null>(null);
  const items = ref<ConnectionSummary[]>([]);
  const connected = computed(() =>
    items.value.find((row) => row.status === "connected"),
  );
  async function load() {
    const data = await api<{
      provider: ProviderStatus;
      connections: ConnectionSummary[];
    }>("/api/v1/connections");
    provider.value = data.provider;
    items.value = data.connections;
  }
  function clear() {
    provider.value = null;
    items.value = [];
  }
  return { provider, items, connected, load, clear };
});
