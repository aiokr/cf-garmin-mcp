<script setup lang="ts">
import {
  Activity,
  LayoutGrid,
  ChartNoAxesCombined,
  Heart,
  Sparkles,
  Settings,
  ArrowRight,
  Moon,
  Sun,
  LogOut,
  Link,
  ShieldCheck,
  CalendarDays,
  Footprints,
  Ruler,
  RefreshCw,
  Download,
  MapPin,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  LoaderCircle,
  Unplug,
  Search,
  Filter,
  Trophy,
  Clock,
  Mountain,
  Flame,
  Gauge,
  ExternalLink,
  Copy,
} from "@lucide/vue";
import type { Component } from "vue";
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const icons: Record<string, Component> = {
  pulse: Activity,
  grid: LayoutGrid,
  activity: ChartNoAxesCombined,
  heart: Heart,
  training: Sparkles,
  settings: Settings,
  arrow: ArrowRight,
  moon: Moon,
  sun: Sun,
  logout: LogOut,
  link: Link,
  shield: ShieldCheck,
  calendar: CalendarDays,
  steps: Footprints,
  distance: Ruler,
  refresh: RefreshCw,
  download: Download,
  location: MapPin,
  previous: ChevronLeft,
  next: ChevronRight,
  check: Check,
  close: X,
  loading: LoaderCircle,
  unplug: Unplug,
  search: Search,
  filter: Filter,
  trophy: Trophy,
  clock: Clock,
  mountain: Mountain,
  flame: Flame,
  gauge: Gauge,
  external: ExternalLink,
  copy: Copy,
};
</script>
<template>
  <component
    :is="icons[name] || Activity"
    :size="size"
    :stroke-width="1.7"
    aria-hidden="true"
  />
</template>
