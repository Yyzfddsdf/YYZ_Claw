# Novel Writer — Plugin Rules

## Scope
- This plugin handles all fiction writing workflows: novel outlining, chapter drafting, character development, plot management, revision, and manuscript assembly.
- Do not use this plugin for non-fiction, technical writing, academic papers, or document formatting tasks.

## Writing Standards
- Maintain consistent narrative voice, tense, and POV across all chapters.
- Track character traits, motivations, and arcs to prevent contradictions.
- Track plot threads, subplots, and setup-payoff pairs.
- Respect the established style guide (tone, prose density, dialogue formatting).

## File Organization
- Each novel project lives in a dedicated directory under the workspace or a user-specified path.
- Keep one `novel.json` manifest per project: metadata, outline, character sheets, plot threads.
- Keep chapters as individual markdown files: `chapters/001.md`, `chapters/002.md`, etc.
- Keep revisions or alternate drafts in a `revisions/` subdirectory.
- Export manuscripts as `.md` or `.docx` only on explicit user request.

## Continuity Gate
- Before writing a new chapter, review the previous chapter's summary to ensure continuity.
- Flag any pending plot threads or unresolved character states before advancing.
- Do not invent new characters, locations, or lore without recording them in the manifest.
