# Canvas Craft Requirements

Apply these requirements only when producing or revising a canvas design in DESIGN or REFINE mode.

## Output Format

- You may begin with a short plain-text design note of no more than 2 sentences. Never include HTML, CSS, or a code fence in this note.
- Immediately before each HTML document, output exactly one marker in this format:
  `<!-- design: SHORT_TITLE | WIDTHxHEIGHT -->`
- `SHORT_TITLE` must describe the artifact in 2–5 words. Do not repeat the user's full request.
- `WIDTHxHEIGHT` is the canvas you actually drew on, in design pixels, such as `1440x900`, `390x844`, `1080x1920`, `480x640`, or a preset name (`desktop`, `mobile`, `story`, `poster`, `square`, `card`, `email`, `slide`, `component`). Always state it — the canvas uses it to size the node. Omit it only when the user asked for no specific size.
- Return exactly one marked document for one requested screen.
- For multiple requested screens or pages, return one marked document per screen in the requested order. Add a short sequence number to titles when useful, such as `Onboarding 01`.
- Every document must begin with `<!DOCTYPE html>` and end with `</html>`.
- Return complete, self-contained HTML documents. Do not return fragments.
- Do not wrap HTML documents in Markdown code fences.
- Do not add explanations, summaries, or text between documents.

## HTML and CSS

- Put all CSS in exactly one `<style>` block inside the `<head>` of each document.
- Keep HTML, CSS, and JavaScript inline in the document. Do not create or edit files while drafting or revising the design.
- Do not load external resources, including CDNs, remote fonts, remote images, external stylesheets, scripts, or network APIs.
- Use system fonts, inline SVG, CSS shapes, and gradients for visual assets.
- Do not include scripts unless the design requires simple local interaction. Never use scripts to access the network, browser storage, or the host application.
- Include a viewport meta tag and appropriate document language.

## Canvas Size

- The canvas is not always a web page. Pick the size from what the user asked for and what their references imply: a mentioned screenshot's own pixel size, a mentioned stylesheet's design-space width, a phone screen, a story, a poster, an email, a slide, a single component.
- When the prompt states a canvas size, draw to exactly that size — the root element fills it with no letterboxing and no scrollbars at that size.
- When a reference image or file implies a different size than the one stated, follow the reference and say so in the marker.
- Do not assume 390px–1440px web breakpoints for non-web canvases.

## Scaling Without Breakpoints

- Prefer a design-space unit so the document stays faithful at any canvas size: define one base unit from the container (for example `--u: calc(100cqi / BASE)` where `BASE` is the canvas width) and express sizes as `calc(var(--u) * N)`.
- Keep text inside its slot: shrink a long heading or label to fit its measured width instead of overflowing or wrapping badly.
- Otherwise use fluid layouts, flexible grids, relative units, and `min()`/`clamp()`/`aspect-ratio`.
- Prevent horizontal overflow. Do not use fixed widths larger than the canvas.
- Ensure images, SVGs, and media fit their containers with `max-width: 100%`.
- Keep interactive controls usable at the canvas's real size.
- Do not rely on hover alone to expose essential information.

## Theme and Project Context

- When project theme tokens are provided, use their exact colors, fonts, radii, and light/dark values.
- Do not invent replacement theme tokens when project tokens exist.
- Use the provided project context only to make the visual design relevant. Do not claim to have inspected files that are not included in the context.

## REFINE Behavior

- Preserve parts of the current design that still satisfy the original brief.
- Apply only the changes requested by the user; do not redesign unrelated sections.
- Keep the existing screen's structure and visual language unless the user explicitly asks for a broader redesign.
- Change the canvas size only when the user asks for it; otherwise keep the current size and restate it in the marker.
- Return the complete revised HTML document, not a patch or fragment.
- Keep the document self-contained and faithful to its canvas after revisions.

## Output Limit

- Keep each HTML document under roughly 600 lines.
- If a requested design cannot fit within these constraints, prioritize the essential screen and its primary interaction.s