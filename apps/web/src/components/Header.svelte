<script lang="ts">
import UserMenu from "./UserMenu.svelte";
</script>

<div>
	<div class="flex flex-row items-center justify-between px-4 py-2 md:px-6">
		<nav class="flex gap-4 text-lg">
			<a href="/" class="transition-colors hover:text-neutral-400">Home</a>
			<a href="/dashboard" class="transition-colors hover:text-neutral-400">Dashboard</a>
			<a href="/settings" class="transition-colors hover:text-neutral-400">Settings</a>
		</nav>
		<div class="flex items-center gap-2">
            <UserMenu />
		</div>
	</div>
	<hr class="border-neutral-800" />
</div>
