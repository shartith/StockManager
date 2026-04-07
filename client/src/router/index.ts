import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('@/views/Dashboard.vue') },
    { path: '/portfolio', name: 'portfolio', component: () => import('@/views/Portfolio.vue') },
    { path: '/recommendations', name: 'recommendations', component: () => import('@/views/Recommendations.vue') },
    { path: '/watchlist', name: 'watchlist', component: () => import('@/views/Watchlist.vue') },
    { path: '/transactions', name: 'transactions', component: () => import('@/views/Transactions.vue') },
    { path: '/dividends', name: 'dividends', component: () => import('@/views/Dividends.vue') },
    { path: '/alerts', name: 'alerts', component: () => import('@/views/Alerts.vue') },
    { path: '/chart', name: 'chart', component: () => import('@/views/ChartView.vue') },
    { path: '/heatmap', name: 'heatmap', component: () => import('@/views/Heatmap.vue') },
    { path: '/feedback', name: 'feedback', component: () => import('@/views/Feedback.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/Settings.vue') },
  ],
});

export default router;
