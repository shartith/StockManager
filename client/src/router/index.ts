import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('@/views/Dashboard.vue') },
    { path: '/top-market-cap', name: 'top-market-cap', component: () => import('@/views/TopMarketCap.vue') },
    { path: '/portfolio', name: 'portfolio', component: () => import('@/views/Portfolio.vue') },
    { path: '/transactions', name: 'transactions', component: () => import('@/views/Transactions.vue') },
    { path: '/chart', name: 'chart', component: () => import('@/views/ChartView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/Settings.vue') },
  ],
});

export default router;
