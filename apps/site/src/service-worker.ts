/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { base, build, files, prerendered, version } from "$service-worker";

declare const self: ServiceWorkerGlobalScope;

const CACHE = `loom-site-${version}`;
function absolutePath(path: string) {
	const prefix = base.replace(/\/$/, "");
	const normalized = `/${path.replace(/^\/+/, "")}`;
	if (!prefix || normalized === prefix || normalized.startsWith(`${prefix}/`))
		return normalized;
	return `${prefix}${normalized}`;
}
const PRECACHE_BASE = [...build, ...files, ...prerendered, absolutePath("/")];
// The installers must always come from the network: a stale cached script would
// keep pointing users at an old release contract.
const INSTALLER = /\/install\.(sh|ps1)$/;
const PRECACHE = [
	...new Set(PRECACHE_BASE.filter((path) => !INSTALLER.test(path))),
];
const SENSITIVE_API = /^\/api\//;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith("loom-site-") && key !== CACHE)
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (
		request.method !== "GET" ||
		url.origin !== self.location.origin ||
		SENSITIVE_API.test(url.pathname) ||
		INSTALLER.test(url.pathname)
	)
		return;

	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request).catch(async () => {
				const cache = await caches.open(CACHE);
				const cached = await cache.match(request);
				if (cached) return cached;
				return (await cache.match(absolutePath("/"))) ?? Response.error();
			}),
		);
		return;
	}

	if (!PRECACHE.includes(url.pathname)) return;
	event.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const cached = await cache.match(request);
			if (cached) return cached;
			const response = await fetch(request);
			if (response.ok) await cache.put(request, response.clone());
			return response;
		}),
	);
});
