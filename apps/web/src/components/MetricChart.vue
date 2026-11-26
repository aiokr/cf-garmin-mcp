<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { init, use, type ECharts } from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
const props = defineProps<{
  labels: string[];
  series: { name: string; data: (number | null)[]; color: string }[];
  title: string;
  unit?: string;
  kind?: "line" | "bar";
}>();
const element = ref<HTMLElement | null>(null);
let chart: ECharts | undefined;
let resize: ResizeObserver;
let theme: MutationObserver;
const hasData = computed(() =>
  props.series.some((series) => series.data.some((value) => value !== null)),
);
function render() {
  if (!element.value || !hasData.value) {
    chart?.dispose();
    chart = undefined;
    return;
  }
  chart ||= init(element.value);
  const style = getComputedStyle(document.documentElement);
  chart.setOption(
    {
      animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
      color: props.series.map((series) =>
        style.getPropertyValue(series.color).trim(),
      ),
      textStyle: {
        fontFamily: "system-ui",
        color: style.getPropertyValue("--text-2").trim(),
      },
      grid: { top: 36, left: 45, right: 20, bottom: 34 },
      tooltip: {
        trigger: "axis",
        valueFormatter: (value: unknown) =>
          value == null ? "—" : `${value}${props.unit || ""}`,
      },
      legend: {
        top: 0,
        textStyle: { color: style.getPropertyValue("--text-2").trim() },
      },
      xAxis: {
        type: "category",
        data: props.labels,
        axisLine: {
          lineStyle: { color: style.getPropertyValue("--border-1").trim() },
        },
        axisLabel: {
          color: style.getPropertyValue("--text-2").trim(),
          fontSize: 10,
        },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        name: props.unit || "",
        splitLine: {
          lineStyle: {
            color: style.getPropertyValue("--border-1").trim(),
            type: "dashed",
          },
        },
        axisLabel: { fontSize: 10 },
      },
      series: props.series.map((series) => ({
        name: series.name,
        type: props.kind || "line",
        data: series.data,
        connectNulls: false,
        smooth: false,
        symbolSize: 5,
        lineStyle: { width: 2 },
        barMaxWidth: 22,
      })),
    },
    true,
  );
}
watch(() => [props.labels, props.series, hasData.value], render, {
  deep: true,
  flush: "post",
});
onMounted(() => {
  render();
  resize = new ResizeObserver(() => chart?.resize());
  if (element.value) resize.observe(element.value);
  theme = new MutationObserver(render);
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
});
onBeforeUnmount(() => {
  resize?.disconnect();
  theme?.disconnect();
  chart?.dispose();
});
</script>
<template>
  <div class="chart-wrap">
    <div
      v-show="hasData"
      ref="element"
      class="metric-chart"
      role="img"
      :aria-label="title"
    />
    <div v-if="!hasData" class="chart-empty">暂无数据</div>
    <table v-if="hasData" class="sr-only">
      <caption>
        {{
          title
        }}
      </caption>
      <thead>
        <tr>
          <th>日期</th>
          <th v-for="series in series" :key="series.name">{{ series.name }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(label, index) in labels" :key="index">
          <th>{{ label }}</th>
          <td v-for="series in series" :key="series.name">
            {{ series.data[index] ?? "无数据" }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
