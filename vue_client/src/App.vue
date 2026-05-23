<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <RouterView />
  <ToastContainer />
  <ContextMenu />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useAuthStore } from './stores/auth.js';
import { useSettingsStore } from './stores/settings.js';
import { useTheme } from './composables/useTheme.js';
import { useVisualViewportHeight } from './composables/useViewport.js';
import ToastContainer from './components/ToastContainer.vue';
import ContextMenu from './components/ContextMenu.vue';

const auth = useAuthStore();
const settings = useSettingsStore();

useTheme();

// Pin --viewport-h / --viewport-y to the visualViewport at the app root so both
// the mobile and desktop shells stay glued to the visible region when iOS
// shifts the layout viewport (URL-bar collapse, soft-keyboard open). Mobile
// originally owned this; iPad runs the desktop layout (width > 768px) and
// needs the same accounting — see issue #11.
useVisualViewportHeight();

onMounted(() => {
  auth.fetchMe();
  if (!settings.loaded) settings.fetchAll().catch(() => {});
});
</script>
