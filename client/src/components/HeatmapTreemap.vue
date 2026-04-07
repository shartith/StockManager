<template>
  <div ref="containerRef" class="relative w-full overflow-hidden rounded-xl" :style="{ height }">
    <!-- Sector groups -->
    <div v-for="sector in computedTiles" :key="sector.sector"
      class="absolute overflow-hidden" :style="sector.style">
      <!-- Sector label -->
      <div class="sticky top-0 z-10 px-1.5 py-0.5 text-[10px] font-semibold truncate"
        style="background: rgba(0,0,0,0.3); color: rgba(255,255,255,0.8);">
        {{ sector.sector }}
      </div>
      <!-- Stock tiles -->
      <div v-for="tile in sector.tiles" :key="tile.ticker"
        class="absolute flex flex-col items-center justify-center cursor-pointer
               transition-opacity duration-fast hover:opacity-80 overflow-hidden
               border border-white/5"
        :style="tile.style"
        @mouseenter="onTileEnter(tile, $event)"
        @mouseleave="tooltipData = null"
        @click="$emit('stock-click', tile.ticker)">
        <template v-if="tile.showLabel">
          <span class="text-[11px] font-bold text-white leading-tight drop-shadow">{{ tile.ticker }}</span>
          <span class="text-[10px] text-white/80 leading-tight drop-shadow">
            {{ tile.changePercent >= 0 ? '+' : '' }}{{ tile.changePercent.toFixed(1) }}%
          </span>
        </template>
      </div>
    </div>
    <!-- Empty state -->
    <div v-if="!data || data.sectors.length === 0"
      class="absolute inset-0 flex items-center justify-center text-txt-tertiary text-sm">
      데이터가 없습니다
    </div>
    <!-- Tooltip -->
    <div v-if="tooltipData" class="fixed z-[200] pointer-events-none"
      :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }">
      <div class="glass-card p-3 text-xs space-y-1 min-w-[160px]">
        <div class="font-bold text-txt-primary">{{ tooltipData.name }}</div>
        <div class="text-txt-secondary">{{ tooltipData.ticker }} · {{ tooltipData.sector }}</div>
        <div class="flex justify-between">
          <span class="text-txt-tertiary">현재가</span>
          <span class="font-medium tabular-nums text-txt-primary">{{ tooltipData.price.toLocaleString() }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-txt-tertiary">등락률</span>
          <span class="font-bold tabular-nums" :class="tooltipData.changePercent >= 0 ? 'text-profit' : 'text-loss'">
            {{ tooltipData.changePercent >= 0 ? '+' : '' }}{{ tooltipData.changePercent.toFixed(2) }}%
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';

interface Stock {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  weight: number;
}

interface Sector {
  sector: string;
  stocks: Stock[];
}

interface HeatmapData {
  sectors: Sector[];
  advancers?: number;
  decliners?: number;
  totalStocks?: number;
  updatedAt?: string;
}

interface TileData {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  weight: number;
  showLabel: boolean;
  style: Record<string, string>;
}

interface SectorTiles {
  sector: string;
  style: Record<string, string>;
  tiles: TileData[];
}

const props = withDefaults(defineProps<{
  data: HeatmapData;
  compact?: boolean;
  height?: string;
}>(), {
  compact: false,
  height: '500px',
});

defineEmits<{
  'stock-click': [ticker: string];
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref(800);
const containerHeight = ref(500);
const tooltipData = ref<Stock | null>(null);
const tooltipPos = ref({ x: 0, y: 0 });

let resizeObserver: ResizeObserver | null = null;

function getChangeColor(pct: number): string {
  const clamped = Math.max(-5, Math.min(5, pct));
  if (clamped > 0) {
    const intensity = clamped / 5;
    const r = Math.round(180 + 75 * intensity);
    const g = Math.round(60 - 30 * intensity);
    const b = Math.round(60 - 30 * intensity);
    return `rgb(${r}, ${g}, ${b})`;
  } else if (clamped < 0) {
    const intensity = Math.abs(clamped) / 5;
    const r = Math.round(60 - 30 * intensity);
    const g = Math.round(80 - 20 * intensity);
    const b = Math.round(180 + 75 * intensity);
    return `rgb(${r}, ${g}, ${b})`;
  }
  return 'rgb(100, 100, 110)';
}

const computedTiles = computed<SectorTiles[]>(() => {
  if (!props.data || props.data.sectors.length === 0) return [];

  const w = containerWidth.value;
  const h = containerHeight.value;
  if (w <= 0 || h <= 0) return [];

  const rootData = {
    name: 'root',
    children: props.data.sectors.map(s => ({
      name: s.sector,
      children: s.stocks.map(st => ({
        name: st.ticker,
        value: st.weight,
        stock: st,
      })),
    })),
  };

  const root = hierarchy(rootData)
    .sum(d => (d as { value?: number }).value ?? 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const layoutRoot = treemap<typeof rootData>()
    .size([w, h])
    .paddingOuter(2)
    .paddingInner(1)
    .paddingTop(16)
    .tile(treemapSquarify)(root) as any;

  const sectorNodes = (layoutRoot.children ?? []) as any[];

  return sectorNodes.map((sectorNode: any) => {
    const sx0 = sectorNode.x0 ?? 0;
    const sy0 = sectorNode.y0 ?? 0;
    const sx1 = sectorNode.x1 ?? 0;
    const sy1 = sectorNode.y1 ?? 0;

    const tiles: TileData[] = (sectorNode.children ?? []).map((leaf: any) => {
      const lx0 = (leaf.x0 ?? 0) - sx0;
      const ly0 = (leaf.y0 ?? 0) - sy0;
      const lx1 = (leaf.x1 ?? 0) - sx0;
      const ly1 = (leaf.y1 ?? 0) - sy0;
      const tileW = lx1 - lx0;
      const tileH = ly1 - ly0;

      const stockData = (leaf.data as any).stock as Stock;
      const minW = props.compact ? 50 : 40;
      const minH = props.compact ? 35 : 28;

      return {
        ticker: stockData.ticker,
        name: stockData.name,
        sector: stockData.sector,
        price: stockData.price,
        changePercent: stockData.changePercent,
        weight: stockData.weight,
        showLabel: tileW >= minW && tileH >= minH,
        style: {
          left: `${lx0}px`,
          top: `${ly0}px`,
          width: `${tileW}px`,
          height: `${tileH}px`,
          backgroundColor: getChangeColor(stockData.changePercent),
        },
      };
    });

    return {
      sector: (sectorNode.data as { name: string }).name,
      style: {
        left: `${sx0}px`,
        top: `${sy0}px`,
        width: `${sx1 - sx0}px`,
        height: `${sy1 - sy0}px`,
      },
      tiles,
    };
  });
});

function onTileEnter(tile: TileData, event: MouseEvent) {
  tooltipData.value = {
    ticker: tile.ticker,
    name: tile.name,
    sector: tile.sector,
    price: tile.price,
    changePercent: tile.changePercent,
    weight: tile.weight,
  };
  tooltipPos.value = {
    x: event.clientX + 12,
    y: event.clientY - 10,
  };
}

function updateSize() {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth;
    containerHeight.value = containerRef.value.clientHeight;
  }
}

onMounted(() => {
  updateSize();
  resizeObserver = new ResizeObserver(updateSize);
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

watch(() => props.data, () => {
  updateSize();
});
</script>
