<script lang="ts">
import { authClient } from "$lib/auth-client";

const sessionQuery = authClient.useSession();
</script>

<div>
	<h1>Dashboard</h1>
	{#if $sessionQuery.data}
		<p>Welcome {$sessionQuery.data.user.name}</p>
	{/if}
</div>
