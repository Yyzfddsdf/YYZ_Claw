---
name: write-novel
description: Write, outline, edit, and manage novel-length fiction with structured chapter-by-chapter support.
version: 1.0.0
author: YYZ_Claw
license: MIT
---

# Write Novel

Use this skill when the user wants to brainstorm, outline, draft, edit, or manage a fiction novel project.

## Workflow Overview

1. **Project Init** — create or load the novel manifest (`novel.json`)
2. **Foundation** — premise, setting, characters, plot arcs
3. **Outline** — chapter-by-chapter plan
4. **Drafting** — write chapters with continuity checks
5. **Revision** — edit, rewrite, or add new material
6. **Export** — assemble full manuscript

---

## Novel Project Structure

```
novel-name/
  novel.json          # project manifest (metadata, outline, characters, plot)
  style-guide.md      # tone, prose rules, formatting conventions
  chapters/
    001.md
    002.md
    ...
  revisions/
    001-rev2.md
    ...
  exports/
    novel-name.md
    novel-name.docx
```

---

## novel.json Manifest

Every project must have a `novel.json`. Structure:

```json
{
  "title": "Novel Title",
  "author": "Author Name",
  "genre": ["fantasy", "mystery"],
  "status": "outline | drafting | revising | complete",
  "premise": "One-paragraph core premise.",
  "pov": "third-limited",
  "tense": "past",
  "styleGuide": "style-guide.md",
  "characters": [
    {
      "id": "char-1",
      "name": "Elena Voss",
      "role": "protagonist",
      "age": 34,
      "description": "Brief physical and personality description.",
      "motivation": "What drives this character.",
      "arc": "How they change over the story.",
      "voice": "Key speech patterns, mannerisms.",
      "relationships": ["char-2: partner", "char-3: rival"]
    }
  ],
  "plotThreads": [
    {
      "id": "thread-1",
      "name": "The Missing Artifact",
      "type": "main",
      "summary": "Elena searches for an ancient relic.",
      "status": "active",
      "setupChapters": [1, 2, 3],
      "payoffChapter": null,
      "notes": ""
    }
  ],
  "outline": [
    {
      "chapter": 1,
      "title": "The Discovery",
      "summary": "Elena finds a strange artifact in the ruins.",
      "pov": "Elena",
      "threads": ["thread-1"],
      "wordCountTarget": 3000,
      "status": "drafting | drafted | revised"
    }
  ],
  "settings": [
    {
      "id": "loc-1",
      "name": "Thornwall City",
      "description": "A walled city of gray stone.",
      "notes": ""
    }
  ],
  "lore": [
    {
      "id": "lore-1",
      "name": "The Old Religion",
      "description": "Belief system outlawed 200 years ago.",
      "notes": ""
    }
  ]
}
```

---

## Drafting Workflow

### Before Writing a Chapter
1. Read the outline entry for the chapter.
2. Review the previous chapter's ending (or last 500 words) for continuity.
3. Check all active plot threads — are any unresolved from the previous chapter?
4. Confirm character states (location, emotional state, companions).

### Writing
- Maintain consistent POV and tense per the manifest.
- Follow the style guide.
- Write in plain Markdown. Use `---` for scene breaks.
- Aim for the word count target in the outline.

### After Writing
1. Update `novel.json`: set chapter status to `drafted`, update active plot thread states.
2. Add any new characters, settings, or lore introduced in the chapter to the manifest.
3. Log any continuity notes (things to check in revision).

---

## Revision Workflow

- Read the chapter to be revised and the revision request.
- Mark changed sections with `<!-- REVISED: YYYY-MM-DD -->`.
- Save the original chapter to `revisions/<num>-rev<N>.md` before overwriting.
- Update `novel.json`: set chapter status to `revised`.

---

## Continuity Gate (Blocking)

Before every new chapter or revision pass, automatically check:
- Are there any **open plot threads** whose `setupChapters` have passed but have no `payoffChapter`?
- Are any characters in a location they shouldn't be, given the previous chapter?
- Is the POV consistent with the outline?

Flag any issues to the user before proceeding. Do not silently paper over continuity gaps.

---

## Export

Full manuscript assembly:
- Concatenate all drafted/revised chapters in order.
- Add title page and optional table of contents.
- Export as `.md` (always available) or `.docx` (on request).
- Save to `exports/` with the novel title as filename.
