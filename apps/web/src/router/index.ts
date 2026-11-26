import { createRouter, createWebHistory } from "vue-router";
import { useSession } from "../stores/session";
import Login from "../views/Login.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      component: () => import("../views/Overview.vue"),
      meta: { title: "总览", eyebrow: "YOUR DAILY PULSE" },
    },
    { path: "/login", component: Login, meta: { public: true, title: "登录" } },
    {
      path: "/activities",
      component: () => import("../views/Activities.vue"),
      meta: { title: "运动记录", eyebrow: "EVERY MOVE COUNTS" },
    },
    {
      path: "/health",
      component: () => import("../views/Trends.vue"),
      meta: { title: "健康趋势", eyebrow: "LISTEN TO YOUR BODY" },
    },
    {
      path: "/training",
      component: () => import("../views/Trends.vue"),
      meta: { title: "训练状态", eyebrow: "FIND YOUR RHYTHM" },
    },
    {
      path: "/activities/:id",
      component: () => import("../views/ActivityDetail.vue"),
      meta: { title: "活动详情" },
    },
    {
      path: "/consent",
      component: () => import("../views/Consent.vue"),
      meta: { title: "应用授权" },
    },
    {
      path: "/settings",
      component: () => import("../views/Settings.vue"),
      meta: { title: "设置", eyebrow: "MAKE IT YOURS" },
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
router.beforeEach(async (to) => {
  const session = useSession();
  if (!session.ready) {
    try {
      await session.refresh();
    } catch {
      return to.path === "/login" ? true : "/login";
    }
  }
  if (!to.meta.public && !session.owner)
    return { path: "/login", query: to.path === "/consent" ? to.query : {} };
  if (to.path === "/login" && session.owner && !to.query.sig) return "/";
});
