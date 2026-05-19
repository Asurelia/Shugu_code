<!-- LOT 1 — Svelte syntax highlighting test. -->
<!-- Expected: keywords violet (let, function), reactive $: highlighted, {#if} block visible. -->
<script lang="ts">
  let count = 0;
  $: doubled = count * 2;
  $: parity = count % 2 === 0 ? 'even' : 'odd';

  function increment() {
    count += 1;
  }

  function reset() {
    count = 0;
  }
</script>

<button on:click={increment}>
  Clicked {count} times (doubled: {doubled}, parity: {parity})
</button>

{#if count > 5}
  <p>Over 5 clicks!</p>
  <button on:click={reset}>Reset</button>
{/if}

<style>
  button {
    padding: 0.5rem 1rem;
    margin: 0.25rem;
  }
  p {
    color: #d180ef;
  }
</style>
