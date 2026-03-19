# Accessibility

Focus on document semantics and progressive enhancement.

## Things to look for

- **Nonsemantic HTML.** Consider whether that `<div>` or `<span>` could be better as a native HTML element. If not, are there ARIA roles that would improve its semantics? Have heading levels been skipped?
- **Inappropriate ARIA roles.** Ensure ARIA roles do more enhancement than polluting.
- **Decorative elements.** Interrogate whether `aria-hidden` is appropriate. (e.g. Some images and many icons accompany a text label.)
- **Unnecessary props.** Are there props that simply mirror the semantics of an ARIA role? Could we omit the prop and use an ARIA attribute as source of truth for that state?
- **CSS properties that modify semantics.** Some CSS properties hide an element from the accessibility tree, or break the default semantics of an element. Check this is appropriate, and whether any ARIA roles should be added as a result.

## Ignore

- Accessibility issues that are easily caught by DevTools or linters, including missing `alt` text or `<title>`s in SVGs.
- Omission of vendor-prefixed CSS properties; we typically use styled-components which generates these.
