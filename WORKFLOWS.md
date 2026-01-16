# WORKFLOWS.md

Documentation of all pages, elements, and workflows in the DBML Viewer application, written in Bubble terminology.

---

## Pages

### Index Page (Main Page)

The entire application lives on a single page with multiple groups that show/hide based on user actions.

---

## Groups & Elements

### Header Group
- **Text Element**: "DBML Viewer" title
- **Text Element**: App description

### URL Input Group
- **Input Field**: Text input for Bubble app URL
- **Button**: "Fetch Schema" submit button
- **Text Element**: Error message (hidden by default, shown when fetch fails)

### Tab Navigation Group
- **Button**: "Diagram" tab
- **Button**: "Plan a Feature" tab
- **Button**: "Table Finder" tab
- **Button**: "Schema Analysis" tab

### Diagram Viewer Group
- **Tab Bar** (Repeating Group): Shows multiple diagram tabs when refactoring creates new versions
  - Each cell contains: Tab title, Close button
- **HTML Element (iframe)**: Embedded dbDiagram visualization
- **Button**: "Download PDF" - exports current diagram

### Feature Planning Group
- **Multiline Input**: Feature description text area
- **Button**: "Plan Feature" submit button
- **Group**: Loading state indicator

#### Proposed Changes Group (shown after planning)
- **Repeating Group**: New Tables list
  - Each cell shows: Table name, field count
  - Nested Repeating Group: Fields in each new table
    - Each cell shows: Field name, field type, editable inputs
- **Repeating Group**: Modified Tables list (existing tables getting new fields)
  - Each cell shows: Table name
  - Nested Repeating Group: New fields being added
    - Each cell shows: Field name, field type
- **Button**: "Apply Changes" - merges proposal into main schema
- **Button**: "Discard" - cancels the proposal

### Table Finder Group (Chat Interface)
- **Repeating Group**: Chat messages
  - Each cell shows: User question OR assistant response
  - Assistant responses include:
    - List of matched tables
    - Explanation for each table's role
    - Overall feature explanation
- **Input Field**: Question text input
- **Button**: "Ask" submit button
- **Group**: Shows grouped diagram highlighting relevant tables

### Schema Analysis Group
- **Score Display Group**:
  - **Text Element**: Performance score (0-100)
  - **Progress Bar Element**: Visual score indicator
  - **Text Element**: Impact explanation (e.g., "Your app is significantly slower than it should be.")

- **Repeating Group**: Issues list
  - Each cell is an expandable Issue Card containing:
    - **Icon**: Severity indicator (warning/suggestion/info)
    - **Text Element**: Issue title
    - **Text Element**: Category badge
    - **Collapsible Group** (expand on click):
      - **Text Element**: Full description
      - **Repeating Group**: Affected tables list
      - **Text Element**: Recommendation
      - **Button**: "Refactor" - auto-fix this issue

---

## Workflows

### Page Load Workflows

**When Page is Loaded**
- Set state: Active tab = "Diagram"
- Set state: Diagram tabs = empty list
- Set state: Feature planning status = "idle"
- Set state: Table finder messages = empty list
- Set state: Schema analysis = null

---

### URL Input Workflows

**When User Clicks "Fetch Schema" Button**

Step 1: Validate input
- Only when: URL input is not empty
- Action: Set state "Fetch Status" = "loading"

Step 2: Call API Workflow "Fetch Schema"
- Send: URL from input field
- This calls the external Bubble Schema API
- Returns: Cleaned DBML text

Step 3: On success - Call API Workflow "Create Diagram"
- Send: DBML from previous step
- This calls dbDiagram API to create visualization
- Returns: Embed URL for iframe

Step 4: On success - Display diagram
- Action: Set state "Current DBML" = returned DBML
- Action: Set state "Embed URL" = returned embed URL
- Action: Add new tab to Diagram Tabs list
- Action: Set state "Fetch Status" = "success"

Step 5: Auto-analyze schema
- Action: Trigger custom event "Analyze Schema"

Step 6: On error - Show error message
- Action: Set state "Fetch Status" = "error"
- Action: Set state "Error Message" = error text
- Action: Show error text element

---

### Tab Navigation Workflows

**When User Clicks "Diagram" Tab**
- Action: Set state "Active Tab" = "diagram"
- Action: Hide all content groups except Diagram Viewer Group

**When User Clicks "Plan a Feature" Tab**
- Action: Set state "Active Tab" = "feature"
- Action: Hide all content groups except Feature Planning Group

**When User Clicks "Table Finder" Tab**
- Action: Set state "Active Tab" = "tablefinder"
- Action: Hide all content groups except Table Finder Group

**When User Clicks "Schema Analysis" Tab**
- Action: Set state "Active Tab" = "analysis"
- Action: Hide all content groups except Schema Analysis Group

---

### Feature Planning Workflows

**When User Clicks "Plan Feature" Button**

Step 1: Validate input
- Only when: Feature description has 10+ characters
- Only when: Current DBML exists
- Action: Set state "Feature Planning Status" = "loading"

Step 2: Call API Workflow "Plan Feature"
- Send: Current DBML, Feature description
- This calls Claude AI to generate new tables
- Returns: Generated DBML, field types, table descriptions, feature title

Step 3: Process the response
- Action: Parse the generated DBML to extract new tables
- Action: Compare with current schema to find what's new vs modified
- Action: Set state "Proposed Tables" = list of new tables
- Action: Set state "Modified Tables" = list of existing tables with new fields
- Action: Set state "Feature Planning Status" = "success"

Step 4: Show proposed changes
- Action: Show Proposed Changes Group
- Action: Populate Repeating Groups with parsed data

**When User Clicks "Apply Changes" Button**

Step 1: Merge changes
- Action: Combine proposed DBML with current DBML
- Action: Set state "Current DBML" = merged result

Step 2: Create new diagram
- Action: Call API Workflow "Create Diagram" with merged DBML
- Action: Add new tab with feature title
- Action: Set active tab to new diagram

Step 3: Clean up
- Action: Reset feature planning states
- Action: Hide Proposed Changes Group

**When User Clicks "Discard" Button**
- Action: Set state "Feature Planning Status" = "idle"
- Action: Clear proposed tables/fields
- Action: Hide Proposed Changes Group

**When User Edits a Proposed Field (inline editing)**
- Action: Update the field in the Proposed Tables state
- This allows users to modify AI suggestions before applying

---

### Table Finder Workflows

**When User Clicks "Ask" Button**

Step 1: Validate input
- Only when: Question has 5+ characters
- Only when: Current DBML exists
- Action: Set state "Table Finder Status" = "loading"

Step 2: Add user message to chat
- Action: Add item to Table Finder Messages list
  - Type: "user"
  - Content: Question text

Step 3: Call API Workflow "Find Tables"
- Send: Current DBML, Question text
- This calls Claude AI to identify relevant tables
- Returns: Updated DBML with TableGroup, matched tables list, explanations

Step 4: Add assistant response to chat
- Action: Add item to Table Finder Messages list
  - Type: "assistant"
  - Content: Matched tables, explanations

Step 5: Create grouped diagram
- Action: Call API Workflow "Create Diagram" with updated DBML
- Action: Set state "Table Finder Diagram URL" = returned embed URL
- Action: Set state "Table Finder Status" = "success"

Step 6: Clear input
- Action: Reset question input field

---

### Schema Analysis Workflows

**Custom Event: "Analyze Schema"**

Step 1: Check prerequisites
- Only when: Current DBML exists
- Action: Set state "Analysis Status" = "loading"

Step 2: Call API Workflow "Analyze Schema"
- Send: Current DBML
- This calls Claude AI to find performance issues
- Returns: Performance score (0-100), Issues list

Step 3: Display results
- Action: Set state "Performance Score" = returned score
- Action: Set state "Schema Issues" = returned issues list
- Action: Set state "Analysis Status" = "success"
- Action: Display impact text based on score (e.g., low scores show "Your app is significantly slower than it should be.")

**When User Clicks Issue Card (to expand)**
- Action: Toggle "Is Expanded" state on this issue
- Action: Show/hide the collapsible details group

**When User Clicks "Refactor" Button on an Issue**

Step 1: Prepare refactoring
- Action: Set state "Refactoring Issue ID" = this issue's ID
- Action: Extract the affected table's DBML from current schema

Step 2: Call API Workflow "Refactor Schema"
- Send: Issue details, Table DBML, Full schema context
- This calls Claude AI to fix the issue
- Returns: Refactored DBML, new table names, issue description

Step 3: Create refactored diagram
- Action: Call API Workflow "Create Diagram" with refactored DBML
- Action: Add new tab with title "[Issue Title] - Refactored"
- Action: Set active tab to new diagram

Step 4: Update UI
- Action: Mark issue as "fixed" in the issues list
- Action: Show success message

---

### Diagram Tab Workflows

**When User Clicks a Diagram Tab**
- Action: Set state "Active Diagram Tab" = clicked tab ID
- Action: Update iframe source to this tab's embed URL

**When User Clicks Close Button on a Tab**
- Only when: More than one tab exists (can't close last tab)
- Action: Remove this tab from Diagram Tabs list
- Action: If this was active tab, switch to first remaining tab

---

### PDF Export Workflows

**When User Clicks "Download PDF" Button**

Step 1: Start export
- Action: Show loading indicator on button
- Action: Set state "PDF Exporting" = yes

Step 2: Call API Workflow "Download PDF"
- Send: Current diagram embed URL
- This launches a headless browser, renders the diagram, captures as PDF
- Returns: PDF file

Step 3: Download file
- Action: Trigger browser download of PDF file
- Action: Filename = "database-diagram.pdf"

Step 4: Clean up
- Action: Hide loading indicator
- Action: Set state "PDF Exporting" = no

---

## API Workflows (Backend)

### API Workflow: "Fetch Schema"
**Endpoint**: `/api/schema`

**Input**: Bubble app URL

**Steps**:
1. Encode the URL for the external API call
2. Make API call to Bubble Schema API
3. Clean the returned DBML:
   - Remove % characters (encoding artifacts)
   - Remove relationships pointing to non-existent tables
   - Remove duplicate fields
   - Remove foreign key fields pointing to deleted tables
   - Clean up broken reference brackets
4. Transform foreign key types:
   - Find fields ending in `_id` or `_ids` with type "unique"
   - Match them to actual table names
   - Update type to show the linked table (e.g., `user_id unique` → `user_id user`)
5. Return cleaned DBML

**Output**: Cleaned DBML text

---

### API Workflow: "Create Diagram"
**Endpoint**: `/api/diagram`

**Input**: DBML text

**Steps**:
1. Send DBML to dbDiagram API to create new diagram
2. Get the diagram ID from response
3. Create embed link with settings:
   - Dark mode: on
   - Detail level: show all fields
   - Relationships: visible
4. Return embed URL

**Output**: Diagram ID, Embed URL

---

### API Workflow: "Plan Feature"
**Endpoint**: `/api/plan-feature`

**Input**: Current DBML, Feature description

**Steps**:
1. Validate description is 10-1000 characters
2. Send to Claude AI (Opus model) with instructions:
   - Here's the existing schema
   - User wants to add this feature
   - Generate ONLY new tables needed (don't repeat existing ones)
   - Use Bubble field types (text, number, Y_N, date, unique)
   - Use snake_case naming
   - Add helpful notes to tables
3. Clean Claude's response (remove markdown formatting)
4. Validate the DBML structure
5. Generate short 2-4 word title for the feature
6. Return generated DBML and metadata

**Output**: Generated DBML, Field types, Table descriptions, Feature title

---

### API Workflow: "Edit DBML"
**Endpoint**: `/api/edit-dbml`

**Input**: Current DBML, Edit instruction

**Steps**:
1. Validate instruction is 5-500 characters
2. Send to Claude AI (Sonnet model) with:
   - Current schema to edit
   - User's natural language instruction
   - Rules for Bubble types and naming conventions
3. Clean and validate the response
4. Extract field types and table descriptions
5. Return modified DBML

**Output**: Updated DBML, Field types, Table descriptions

---

### API Workflow: "Analyze Schema"
**Endpoint**: `/api/analyze-schema`

**Input**: DBML text

**Steps**:
1. Validate DBML has tables
2. Send to Claude AI (Haiku model - fast/cheap) to analyze for:
   - **Wide Tables**: Tables with more than 15 fields (slows queries)
   - **Deep Relationships**: Chains of 3+ linked tables (causes timeouts)
   - **Missing Back-References**: One-way relationships that need reverse lookups
   - **Data Duplication**: Same data stored in multiple tables
   - **Consolidation Opportunities**: Similar tables that could merge
3. Claude returns JSON with:
   - Performance score (0-100) - overall database health combining query speed and growth readiness
   - List of issues with severity, description, affected tables, recommendation
4. Parse and validate the JSON response

**Output**: Performance score, Issues list with details

---

### API Workflow: "Refactor Schema"
**Endpoint**: `/api/refactor-schema`

**Input**: Issue details, Affected table DBML, Full schema context

**Steps**:
1. Determine refactoring type based on issue category:
   - **Wide Table** → Split into multiple focused tables
   - **Similar Tables** → Consolidate into single table with type field
2. Send to Claude AI (Opus model) with specific instructions:
   - For splitting: Break table into 2-4 smaller tables, keep core fields, create relationships
   - For consolidation: Merge tables, add type field, remove originals
3. Clean the response (remove markdown, self-references)
4. Merge refactored tables back into full schema
5. Add TableGroup to highlight the refactored tables
6. Return complete refactored schema

**Output**: Refactored DBML, Original table name(s), New table names, Issue description

---

### API Workflow: "Find Tables"
**Endpoint**: `/api/table-finder`

**Input**: DBML text, User question

**Steps**:
1. Validate question is 5-500 characters
2. Simplify DBML to reduce tokens (keep only table names and descriptions)
3. Send to Claude AI (Haiku model) with:
   - Simplified schema
   - User's question about which tables handle a feature
4. Claude identifies relevant tables and returns:
   - TableGroup definition highlighting the tables
   - Explanation for each table's role
   - Overall explanation of how the feature works
5. Filter out any hallucinated table names (tables that don't exist)
6. Append TableGroup to original DBML

**Output**: Updated DBML with TableGroup, Matched tables, Explanations

---

### API Workflow: "Download PDF"
**Endpoint**: `/api/download-pdf`

**Input**: Diagram embed URL

**Steps**:
1. Launch headless Chrome browser
2. Navigate to diagram URL
3. Wait for diagram to fully render (SVG element visible)
4. Wait extra time for animations to complete
5. Set zoom to 75% to fit more content
6. Generate PDF with:
   - A4 landscape orientation
   - Print background colors
   - Small margins (10px)
7. Close browser
8. Return PDF file

**Output**: PDF file download

---

## States (Custom States on Page)

| State Name | Type | Purpose |
|------------|------|---------|
| Fetch Status | Text (idle/loading/success/error) | Tracks schema fetching progress |
| Current DBML | Text | Stores the active database schema |
| Embed URL | Text | Current diagram iframe URL |
| Active Tab | Text (diagram/feature/tablefinder/analysis) | Which main tab is selected |
| Diagram Tabs | List of objects | Multiple diagram versions for comparison |
| Active Diagram Tab | Text | Which diagram tab is selected |
| Feature Planning Status | Text | Tracks feature planning progress |
| Proposed Tables | List of objects | New tables from feature planning |
| Modified Tables | List of objects | Existing tables with new fields |
| Table Finder Status | Text | Tracks table finder progress |
| Table Finder Messages | List of objects | Chat history for table finder |
| Table Finder Diagram URL | Text | Grouped diagram embed URL |
| Analysis Status | Text | Tracks schema analysis progress |
| Performance Score | Number | 0-100 overall database health score with impact explanation |
| Schema Issues | List of objects | Performance/structure issues found |
| Error Message | Text | Current error to display |
| PDF Exporting | Yes/No | PDF download in progress |

---

## Option Sets

### Issue Severity
- **warning** - Performance problem that should be fixed
- **suggestion** - Improvement that would help
- **info** - Information about schema structure

### Issue Category
- **table-width** - Tables with too many fields
- **relationship-depth** - Too many levels of linked tables
- **missing-back-reference** - One-way relationships
- **data-duplication** - Same data in multiple places
- **consolidation-opportunity** - Tables that could be combined

### Field Types (Bubble Types)
- **text** - Text/string values
- **number** - Numeric values (integers and decimals)
- **Y_N** - Yes/No boolean values
- **date** - Date and time values
- **unique** - Unique ID (primary key)
- **[table_name]** - Link to another table (foreign key)

---

## External API Connections

### Bubble Schema API
- **URL**: `https://xgkxmsaivblwqfkdhtekn3nase0tudjd.lambda-url.us-east-1.on.aws/api/schema/`
- **Method**: GET
- **Purpose**: Fetch database schema from any Bubble app
- **Returns**: DBML format schema

### dbDiagram API
- **URL**: `https://api.dbdiagram.io/v1/`
- **Authentication**: API token in header
- **Endpoints**:
  - POST `/diagrams` - Create new diagram
  - POST `/embed_link/{id}` - Get embeddable URL
- **Purpose**: Create visual database diagrams

### Claude AI API
- **URL**: Anthropic API
- **Authentication**: API key
- **Models Used**:
  - **Opus 4.5** - Best quality, used for feature planning
  - **Opus 4** - High quality, used for refactoring
  - **Sonnet 4** - Fast and capable, used for schema editing
  - **Haiku 4.5** - Fastest/cheapest, used for analysis and table finding
- **Purpose**: AI-powered schema generation, editing, and analysis

---

## Summary of All Workflows by Trigger

### Button Click Workflows
1. Fetch Schema → Loads Bubble app database
2. Plan Feature → AI generates new tables for a feature
3. Apply Changes → Merges proposed changes into schema
4. Discard → Cancels proposed changes
5. Ask (Table Finder) → AI identifies relevant tables
6. Refactor → AI fixes a performance issue
7. Download PDF → Exports diagram as PDF
8. Tab buttons → Switch between views
9. Diagram tab buttons → Switch between diagram versions
10. Close tab → Remove a diagram tab
11. Issue card click → Expand/collapse issue details

### Automatic Workflows
1. Page load → Initialize all states
2. After schema fetch → Auto-analyze for issues
3. After feature planning → Parse and display proposed changes
4. After refactoring → Create new diagram tab

### Data Change Workflows
1. Inline field editing → Update proposed changes state
