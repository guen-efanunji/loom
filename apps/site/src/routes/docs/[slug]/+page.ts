import { error } from "@sveltejs/kit";
import { docs } from "$lib/docs";
export function entries() { return docs.map(doc => ({ slug: doc.slug })); }
export function load({ params }: { params: { slug: string } }) {
  const index = docs.findIndex(doc => doc.slug === params.slug);
  if (index < 0) error(404, "Documentation page not found");
  return { doc: docs[index], previous: docs[index - 1] ?? null, next: docs[index + 1] ?? null };
}
