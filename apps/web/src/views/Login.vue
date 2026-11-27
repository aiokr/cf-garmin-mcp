<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "base-ui-vue";
import { useRouter } from "vue-router";
import { useSession } from "../stores/session";
import { useToasts } from "../stores/toasts";
import { api } from "../api";
import Icon from "../components/Icon.vue";
import { authClient } from "../api/auth";

const session = useSession();
const toasts = useToasts();
const router = useRouter();
const setup = computed(() => session.instance && !session.instance.initialized);
const name = ref("");
const email = ref("");
const password = ref("");
const busy = ref(false);
async function submit() {
  busy.value = true;
  try {
    if (!session.ready) {
      await session.refresh();
      return;
    }
    if (setup.value) {
      await api("/api/v1/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          name: name.value,
          email: email.value,
          password: password.value,
        }),
      });
      password.value = "";
      await session.refresh();
      toasts.add("账户已创建，请使用刚才的邮箱和密码登录。");
    } else {
      const result = await authClient.signIn.email({
        email: email.value,
        password: password.value,
      });
      if (result.error) throw new Error(result.error.message || "登录失败");
      password.value = "";
      await session.refresh();
      if (!window.location.search.includes("sig=")) await router.push("/");
    }
  } catch (e) {
    toasts.add(
      e instanceof Error ? e.message : "操作失败，请稍后重试。",
      "error",
    );
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="auth-page">
    <section class="auth-story">
      <div class="brand">
        <span class="brand-symbol"><Icon name="pulse" :size="28" /></span>Garmin
        / personal
      </div>
      <span class="eyebrow">A SPACE FOR YOUR EVERYDAY</span>
      <h1>每一步，<br />都值得被看见。</h1>
      <p>把运动、恢复与日常的节奏，<br />收进一个只属于你的空间。</p>
      <div class="story-line" aria-hidden="true">
        <svg viewBox="0 0 500 130">
          <path
            d="M0 95C65 95 70 45 120 55S170 115 220 65 275 25 310 50 360 80 395 35 450 45 500 10"
          />
        </svg>
      </div>
    </section>
    <section class="auth-form-panel">
      <div class="auth-form">
        <h2>
          {{
            !session.ready
              ? "连接你的空间"
              : setup
                ? "创建你的空间"
                : "欢迎回来"
          }}
        </h2>
        <p>
          {{
            !session.ready
              ? "服务暂时不可用，请确认部署配置后重试。"
              : setup
                ? "设置唯一 Owner 的邮箱和密码，无需初始化 Key。部署后请立即创建账户，首个完成创建的访问者将成为 Owner。"
                : "登录后，继续探索你的运动与健康。"
          }}
        </p>
        <form @submit.prevent="submit">
          <template v-if="session.ready"
            ><label v-if="setup" for="name"
              >你的名字<input
                id="name"
                v-model="name"
                autocomplete="name"
                required
                maxlength="80" /></label
            ><label for="email"
              >邮箱<input
                id="email"
                v-model="email"
                type="email"
                autocomplete="username"
                required
                maxlength="254" /></label
            ><label for="password"
              >密码<input
                id="password"
                v-model="password"
                type="password"
                :autocomplete="setup ? 'new-password' : 'current-password'"
                required
                :minlength="setup ? 12 : undefined"
                maxlength="128"
              /><small v-if="setup">至少 12 个字符。</small></label
            ></template
          >
          <p v-if="session.error" class="form-message error-text" role="alert">
            {{ session.error }}
          </p>
          <p
            v-if="setup && !session.instance?.bootstrapAvailable"
            class="error-text"
            role="alert"
          >
            初始化暂不可用，请刷新页面确认实例状态。
          </p>
          <Button
            class="button primary full-width"
            type="submit"
            :disabled="
              busy || Boolean(setup && !session.instance?.bootstrapAvailable)
            "
            >{{
              busy
                ? "请稍候…"
                : !session.ready
                  ? "重新连接"
                  : setup
                    ? "创建账户"
                    : "登录"
            }}<Icon name="arrow" :size="18"
          /></Button>
        </form>
      </div>
    </section>
  </div>
</template>
