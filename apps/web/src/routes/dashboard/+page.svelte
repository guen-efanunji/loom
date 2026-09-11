<script lang="ts">
import { createQuery } from "@tanstack/svelte-query";
import { goto } from "$app/navigation";
import { authClient } from "$lib/auth-client";
import { orpc } from "$lib/orpc";

const sessionQuery = authClient.useSession();

const privateDataQuery = createQuery(() => orpc.privateData.queryOptions());

$effect(() => {
	if (!$sessionQuery.isPending && !$sessionQuery.data) {
		goto("/login");
	}
});
</script>

{#if $sessionQuery.isPending}
	<div>Loading...</div>
{:else if !$sessionQuery.data}
	<div>Redirecting to login...</div>
{:else}
	<div>
		<h1>Dashboard</h1>
		<p>Welcome {$sessionQuery.data.user.name}</p>
		<p>API: {privateDataQuery.data?.message}</p>
	</div>
{/if}
