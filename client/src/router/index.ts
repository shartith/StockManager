import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from '@/views/Dashboard.vue';
import Portfolio from '@/views/Portfolio.vue';
import Transactions from '@/views/Transactions.vue';
import Dividends from '@/views/Dividends.vue';
import Alerts from '@/views/Alerts.vue';
import ChartView from '@/views/ChartView.vue';
import Settings from '@/views/Settings.vue';
import Recommendations from '@/views/Recommendations.vue';
import Watchlist from '@/views/Watchlist.vue';
import Feedback from '@/views/Feedback.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/portfolio', name: 'portfolio', component: Portfolio },
    { path: '/recommendations', name: 'recommendations', component: Recommendations },
    { path: '/watchlist', name: 'watchlist', component: Watchlist },
    { path: '/transactions', name: 'transactions', component: Transactions },
    { path: '/dividends', name: 'dividends', component: Dividends },
    { path: '/alerts', name: 'alerts', component: Alerts },
    { path: '/chart', name: 'chart', component: ChartView },
    { path: '/feedback', name: 'feedback', component: Feedback },
    { path: '/settings', name: 'settings', component: Settings },
  ],
});

export default router;
