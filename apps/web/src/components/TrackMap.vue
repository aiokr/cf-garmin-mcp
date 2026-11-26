<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { Map, LngLatBounds } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
const props = defineProps<{
  coordinates: [number, number][];
  tileUrl: string;
}>();
const element = ref<HTMLElement | null>(null);
const error = ref("");
let map: Map;
onMounted(() => {
  if (!element.value || props.coordinates.length < 2) return;
  try {
    const tile = new URL(props.tileUrl);
    if (tile.protocol !== "https:") throw new Error();
    map = new Map({
      container: element.value,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          osm: { type: "raster", tiles: [props.tileUrl], tileSize: 256 },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: props.coordinates[0],
      zoom: 12,
    });
    map.on("load", () => {
      map.addSource("track", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: props.coordinates },
          properties: {},
        },
      });
      map.addLayer({
        id: "track",
        type: "line",
        source: "track",
        paint: {
          "line-color": getComputedStyle(document.documentElement)
            .getPropertyValue("--primary-600")
            .trim(),
          "line-width": 4,
        },
      });
      const bounds = new LngLatBounds(
        props.coordinates[0],
        props.coordinates[0],
      );
      for (const coordinate of props.coordinates) bounds.extend(coordinate);
      map.fitBounds(bounds, { padding: 35, duration: 0, maxZoom: 16 });
    });
    map.on("error", () => {
      error.value = "地图暂不可用";
    });
  } catch {
    error.value = "地图暂不可用";
  }
});
onBeforeUnmount(() => map?.remove());
</script>
<template>
  <div class="map-panel">
    <div v-if="coordinates.length < 2" class="chart-empty">暂无轨迹</div>
    <div v-else ref="element" class="track-map" aria-label="运动轨迹地图" />
    <p v-if="error" class="map-error" role="status">{{ error }}</p>
    <p class="map-attribution">
      ©
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
        >OpenStreetMap contributors</a
      >
    </p>
  </div>
</template>
