<template>
  <RouterView />
  <ToastContainer />
</template>

<script setup>
import { onMounted } from 'vue';
import { useAuthStore } from './stores/auth.js';
import { useSettingsStore } from './stores/settings.js';
import { useTheme } from './composables/useTheme.js';
import ToastContainer from './components/ToastContainer.vue';

const auth = useAuthStore();
const settings = useSettingsStore();

useTheme();

onMounted(() => {
  auth.fetchMe();
  if (!settings.loaded) settings.fetchAll().catch(() => {});
});
</script>
