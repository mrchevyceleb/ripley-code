# Project Instructions (RIPLEY.md)

Project instructions let users customize Ripley's behavior per project. Like `CLAUDE.md` for Claude Code.

## How It Works

1. Create a file called `RIPLEY.md` at the project root
2. Ripley automatically loads it into the system prompt on every message
3. The AI sees these instructions as part of its context

## File Locations

- **Primary**: `RIPLEY.md` at project root (recommended)
- **Legacy fallback**: `.ripley/instructions.md`

## What to Put in RIPLEY.md

- Project stack and conventions (e.g., "This is a Next.js 14 app using TypeScript")
- Coding style preferences (e.g., "Use functional components, no classes")
- File structure notes (e.g., "API routes are in src/app/api/")
- Testing conventions (e.g., "Use vitest, tests live next to source files")
- Deployment info (e.g., "Deployed on Vercel, use edge runtime")
- Any rules or constraints the AI should follow

## Commands

- `/instructions` - Opens RIPLEY.md in the default editor, or creates a template if it doesn't exist

## Example RIPLEY.md

```markdown
# Project: My SaaS App

Stack: Next.js 14, TypeScript, Tailwind CSS, Supabase
Testing: Vitest + React Testing Library
Deploy: Vercel (edge runtime for API routes)

## Conventions
- Use server components by default, client components only when needed
- All database queries go through lib/db.ts
- Use Zod for validation
- Prefer named exports

## File Structure
- src/app/ - Next.js app router pages
- src/components/ - Shared UI components
- src/lib/ - Utilities and database client
- supabase/migrations/ - Database migrations
```
