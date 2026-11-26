<script setup lang="ts">
import type { ActivitySummary } from "../../../../packages/shared/src";
import { duration, numeric, sportName, pace } from "../lib/format";
import Icon from "./Icon.vue";
defineProps<{ items: ActivitySummary[] }>();
</script>
<template>
  <div class="table-scroll">
    <table class="activity-table">
      <thead>
        <tr>
          <th>运动</th>
          <th>日期</th>
          <th>距离</th>
          <th>时长</th>
          <th>配速</th>
          <th>平均心率</th>
          <th><span class="sr-only">详情</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.id">
          <td>
            <RouterLink :to="`/activities/${item.id}`" class="activity-title">{{
              item.name
            }}</RouterLink><small>{{ sportName(item.sport_type) }}</small>
          </td>
          <td>{{ item.local_date }}</td>
          <td>
            {{
              numeric(
                item.distance_m === null ? null : item.distance_m / 1000,
                2,
              )
            }}
            <small>km</small>
          </td>
          <td>{{ duration(item.duration_s) }}</td>
          <td>{{ pace(item.avg_speed_mps) }} <small>/km</small></td>
          <td>{{ numeric(item.avg_hr) }} <small>bpm</small></td>
          <td>
            <RouterLink
              :to="`/activities/${item.id}`"
              :aria-label="`查看${item.name}`"
              ><Icon name="arrow" :size="16"
            /></RouterLink>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
