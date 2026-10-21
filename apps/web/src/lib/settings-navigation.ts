export function safeWorkspaceReturnTo(value: string | null | undefined) {
	return value?.startsWith("/") &&
		!value.startsWith("//") &&
		!value.includes("\\")
		? value
		: "/";
}

export function settingsHref(
	path: string,
	returnTo: string | null | undefined,
) {
	const [pathnameAndQuery, hash = ""] = path.split("#", 2);
	const [pathname, query = ""] = pathnameAndQuery.split("?", 2);
	const params = new URLSearchParams(query);
	params.set("returnTo", safeWorkspaceReturnTo(returnTo));
	const search = params.toString();
	return `${pathname}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
}
