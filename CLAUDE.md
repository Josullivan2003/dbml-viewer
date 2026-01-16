# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DBML Viewer is a Next.js application that allows users to view database schemas from Bubble.io apps. It leverages the Claude API for schema editing and dbDiagram for visualization.

## Common Commands

```bash
# Development
npm run dev          # Start dev server (runs on port 3005 by default)

# Build
npm run build        # Build for production
npm start            # Start production server

# Linting
npm run lint         # Run ESLint
```

## Architecture

### Tech Stack
- **Framework**: Next.js 15.5 with React 19
- **Language**: TypeScript
- **Styling**: Tailwind CSS with PostCSS
- **External APIs**: Claude API, dbDiagram API, Bubble Schema API
- **Headless Browser**: Puppeteer (for PDF export)

### Directory Structure
- `/app/page.tsx` - Main client component (2259 lines) - Contains the entire UI and schema editing logic
- `/app/api/` - Backend API routes
  - `schema/route.ts` - Fetches DBML from Bubble apps and transforms foreign keys
  - `diagram/route.ts` - Creates dbDiagram visualizations and embed links
  - `edit-dbml/route.ts` - Claude-powered schema editor
  - `plan-feature/route.ts` - Claude-powered feature planning
  - `download-pdf/route.ts` - PDF export functionality

### Key Features

#### 1. Schema Fetching (`/api/schema`)
- Receives a Bubble app URL
- Calls external Bubble Schema API to get DBML
- **Critical transformation**: Converts `_id` and `_ids` fields with `unique` type to proper foreign key references
- Validates tables exist and generates missing relationship references
- Returns processed DBML

#### 2. Schema Editing (`/api/edit-dbml`)
- Uses Claude API to edit DBML based on user instructions
- Key helper functions:
  - `buildSystemPrompt()` - Creates system prompt that constrains Claude to editing only the proposed schema
  - `validateDbml()` - Checks for Table definitions and balanced braces
  - `convertDbmlTypeToBubbleType()` - Maps standard DB types to Bubble types (text, number, Y_N, date, unique)
  - `extractFieldTypesFromDbml()` - Parses DBML to extract field type information

#### 3. Diagram Generation (`/api/diagram`)
- Takes DBML content
- Creates diagram via dbDiagram API (POST to `/v1/diagrams`)
- Creates embed link via dbDiagram API (POST to `/v1/embed_link/{id}`)
- Returns diagram ID and embed URL for iframe display

#### 4. Feature Planning (`/api/plan-feature`)
- Uses Claude to plan database schema changes for requested features
- Generates a schema proposal that the user can then edit

### Main Page Component (`/app/page.tsx`)

This is the core of the application. Key responsibilities:

1. **UI State Management**
   - Manages URL input, DBML state, schema changes, diagrams, etc.
   - Handles loading states and error messages

2. **Schema Type Conversion**
   - `convertDbmlToBubbleTypes()` - Converts DBML types to Bubble-compatible types
   - `parseDbml()` - Parses DBML to extract tables, fields, and notes

3. **API Orchestration**
   - Calls `/api/schema` to fetch and transform schemas
   - Calls `/api/diagram` to generate visualizations
   - Calls `/api/edit-dbml` for AI-powered editing
   - Calls `/api/plan-feature` for feature planning

4. **UI Rendering**
   - Input form for Bubble app URLs
   - DBML editor/viewer
   - Schema changes display (new tables, new fields)
   - Diagram iframe viewer
   - PDF export button

### Environment Variables

Required in `.env.local`:
- `ANTHROPIC_API_KEY` - Claude API key
- `DBDIAGRAM_API_TOKEN` - dbDiagram API token for creating diagrams
- (Any Puppeteer-related env vars if needed for PDF generation)

### Important Implementation Details

#### DBML Type System
The application works with multiple type systems:
1. **Bubble Types** (used in UI/database): text, number, Y_N, date, unique, table_name (for foreign keys)
2. **DBML Types** (used in exchange): varchar, int, decimal, boolean, datetime, text, unique
3. **Foreign Keys**: Represented as `{table_name}_id {referenced_table_name}` or `{table_name}_ids {table_name}` for lists

#### Data Transformation Pipeline

When the app fetches a schema from Bubble, it cleans and transforms the data in two stages before displaying it to users.

##### **Stage 1: Server-Side Cleanup** (`/api/schema/route.ts`)

These steps clean up messy data from the Bubble API:

1. **Remove % characters** - Strips out web encoding artifacts that sometimes appear in field names.

2. **Remove broken relationships (first pass)** - Deletes any relationship lines that point to tables that don't exist.

3. **Remove duplicate fields** - If a table has the same field listed twice, keeps only the first one.

4. **Remove orphaned link fields** - Deletes fields like `deleted_user_id` if there's no matching table to link to. Primary ID fields are never removed.

5. **Clean up broken inline references** - Some fields have embedded link info like `[ref: > old_table._id]`. If that table doesn't exist, the link info is removed but the field is kept.

6. **Remove broken relationships (second pass)** - After cleaning up fields, checks again for any relationship lines that now point to nothing.

7. **Convert link field types** - This is the main transformation. Bubble stores links to other tables as fields ending in `_id` or `_ids` with a generic "unique" type. This step figures out which table each field actually links to and updates the type to show that connection.
   - `user_id unique` becomes `user_id user`
   - `participant_ids unique` becomes `participant_ids participant`
   - Uses smart matching: tries exact name, then plural form, then partial matches for compound names like `business_owner_id` → links to `user` table

##### **Stage 2: Display Formatting** (`page.tsx`)

After the server returns clean data, the app formats it for display:

1. **Show link types clearly** - If a field has embedded link info, updates the displayed type to show which table it links to.

2. **Convert to Bubble types** - Translates standard database types to Bubble's type names:
   - Numbers (`int`, `decimal`, `float`, etc.) → `number`
   - Yes/No fields (`boolean`) → `Y_N`
   - Dates (`datetime`, `timestamp`) → `date`
   - Text variations (`varchar`) → `text`

3. **Mark ID fields** - Ensures all ID fields show as type `unique` for visual consistency.

##### **Stage 3: Schema Changes Display** (`/api/plan-feature/route.ts`)

When showing proposed changes in the UI, list fields display with "(list)" suffix to indicate they can hold multiple values. Example: `user_ids` displays as `user (list)`.

#### Flow Summary

```
Bubble API Response
  ↓
[Server: Clean & Transform]
  → Remove bad characters and duplicates
  → Delete fields linking to non-existent tables
  → Convert link fields to show which table they reference
  ↓
[Client: Format for Display]
  → Convert types to Bubble-friendly names
  → Mark ID fields consistently
  ↓
User sees clean, readable schema
```

### Common Development Tasks

#### Adding a New API Endpoint
1. Create `/app/api/{feature}/route.ts`
2. Export `async function POST(request: NextRequest)` or other HTTP method
3. Parse request with `request.json()`
4. Validate input
5. Implement logic (may call external APIs)
6. Return `NextResponse.json()` with data or error

#### Debugging Schema Issues
- Check console logs in `/api/schema/route.ts` for transformation details
- Review the "DBML FROM RENDER" and "TRANSFORMING FOREIGN KEY TYPES" log sections
- Test with a known Bubble app URL to see actual output

#### Working with Claude API
- The `edit-dbml` endpoint uses `@anthropic-ai/sdk`
- System prompts carefully constrain Claude's behavior (e.g., "edit ONLY the proposed schema")
- Validation happens post-generation to check DBML syntax
- Type conversion maps both directions between Bubble and DBML types

### Code Documentation Standards

**All code in this repository must be thoroughly documented using non-technical language that a non-coder could understand.**

#### Documentation Guidelines

1. **Function/Method Comments**
   - Always include a comment explaining WHAT the function does and WHY it exists
   - Avoid jargon; use plain English (e.g., "fetches the database schema" instead of "retrieves the serialized DBML object")
   - Explain the purpose in business terms when possible (e.g., "converts database field types so Bubble.io can understand them")
   - Document parameters in plain language with examples if helpful

2. **Complex Logic Comments**
   - Break down multi-step processes with inline comments
   - Explain the "why" behind conditional logic, not just the "what"
   - Example: Instead of `// Check if _ids exists`, write `// Fields ending in _ids are lists of foreign keys, so we need to rename them to point to the related table`

3. **Type/Interface Documentation**
   - Explain what each property represents in business terms
   - Use examples when the data structure is complex

4. **API Endpoint Documentation**
   - Include a header comment describing what the endpoint does for end users
   - Explain inputs and outputs in non-technical terms
   - Document any external API calls made and why

5. **Variable/Constant Names**
   - Use clear, descriptive names that explain the purpose
   - Avoid abbreviations except for universally understood terms (e.g., "ID" for identifier)

#### Example

Bad:
```javascript
// Transform FKs
const transformed = dbml.split('\n').filter(line => line.includes('_id')).map(transformFK);
```

Good:
```javascript
// Convert Bubble's way of storing relationships (fields ending in _id or _ids)
// into proper database foreign key references that the diagram tool can understand
const transformed = dbml.split('\n')
  .filter(line => line.includes('_id')) // Bubble stores foreign keys as _id fields
  .map(transformFK); // Convert to database relationship syntax
```

### External API Integration

#### Bubble Schema API
- Endpoint: `https://bubble-schema-api.onrender.com/api/schema/{encodedUrl}?format=dbml`
- Method: GET
- Returns: DBML format schema
- Error: Returns 400 if URL is not a valid Bubble app

#### dbDiagram API
- Endpoints:
  - POST `/v1/diagrams` - Create diagram from DBML
  - POST `/v1/embed_link/{id}` - Generate embed URL for iframe
- Headers: `dbdiagram-access-token` (from env var)
- Requires valid DBML syntax

#### Claude API
- Used via `@anthropic-ai/sdk`
- Two main uses: schema editing and feature planning
- System prompts are carefully constructed to enforce constraints
