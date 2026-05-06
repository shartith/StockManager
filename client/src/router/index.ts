import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('@/views/Dashboard.vue') },
    { path: '/portfolio', name: 'portfolio', component: () => import('@/views/Portfolio.vue') },
    { path: '/watch-targets', name: 'watch-targets', component: () => import('@/views/WatchTargets.vue') },
    { path: '/reserved-orders', name: 'reserved-orders', component: () => import('@/views/ReservedOrders.vue') },
    { path: '/transactions', name: 'transactions', component: () => import('@/views/Transactions.vue') },
    { path: '/chart', name: 'chart', component: () => import('@/views/ChartView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/Settings.vue') },
  ],
});

export default router;
