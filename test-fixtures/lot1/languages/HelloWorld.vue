<!-- LOT 1 — Vue SFC syntax highlighting test. -->
<!-- Expected: template tags violet, script keywords violet, style props violet. -->
<template>
  <div class="hello">
    <h1>{{ greeting }}</h1>
    <button @click="increment">Clicked {{ count }} times</button>
    <p v-if="count > 5">Over 5 clicks!</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const greeting = ref('Hello, Shugu!');
const count = ref(0);
const doubled = computed(() => count.value * 2);

function increment() {
  count.value += 1;
}
</script>

<style scoped>
.hello {
  padding: 1rem;
  font-family: var(--font-mono);
}
h1 {
  color: #e08efe;
}
button {
  background: #8aefc7;
  border: none;
  padding: 0.5rem 1rem;
}
</style>
