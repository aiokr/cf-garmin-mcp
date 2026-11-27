import { readonly, ref } from "vue";

export type Toast = { id: number; message: string; type: "success" | "error" };
const items = ref<Toast[]>([]);
let nextId = 0;
export function useToasts() {
  function dismiss(id: number) {
    items.value = items.value.filter((item) => item.id !== id);
  }
  function add(message: string, type: Toast["type"] = "success") {
    if (!message) return;
    items.value = [...items.value, { id: ++nextId, message, type }].slice(-3);
  }
  return { items: readonly(items), add, dismiss };
}
