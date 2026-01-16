/**
 * Feature Planning API Endpoint
 *
 * PURPOSE:
 * This endpoint helps users plan new features for their Bubble.io app by automatically
 * generating the database tables they'll need. Users describe what feature they want
 * (like "add a chat system" or "implement user reviews") and Claude AI designs the
 * database schema to support that feature.
 *
 * WHAT IT DOES:
 * 1. Receives a description of the feature the user wants to build
 * 2. Analyzes the existing database schema to understand the current structure
 * 3. Uses Claude AI to design new tables and fields needed for the feature
 * 4. Returns the proposed schema additions that can be merged with the existing schema
 *
 * WHY THIS MATTERS:
 * Designing database tables is one of the hardest parts of building an app. This feature
 * removes that barrier by letting users describe what they want in plain English, and
 * getting back a professional database design that follows best practices.
 *
 * INPUT:
 * - currentDbml: The user's existing database schema
 * - featureDescription: Plain English description of the feature to build
 *
 * OUTPUT:
 * - generatedDbml: New tables and fields to add for this feature
 * - generatedDbmlWithBubbleTypes: Same schema with Bubble-compatible types
 * - fieldTypes: Type information for displaying in the UI
 * - tableDescriptions: Descriptions of what each new table is for
 * - featureTitle: A short 2-4 word title summarizing the feature
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Builds the System Prompt for Feature Planning
 *
 * Creates detailed instructions for Claude on how to design database tables
 * for a new feature. The prompt includes:
 * - The existing schema (so Claude knows what tables already exist)
 * - Rules about Bubble-compatible types
 * - Examples of correct table and field definitions
 * - Instructions for proper relationships and foreign keys
 */
function buildSystemPrompt(currentDbml: string): string {
  return `Design database schema extensions for Bubble.io using DBML. Create new tables and relationships for the requested feature.

IMPORTANT: Return ONLY new tables/fields for this feature - do NOT include existing tables from the current schema in your response.
The system will automatically merge your new tables with the existing schema.

BUBBLE TYPES ONLY: text, number, Y_N (yes/no), date (datetime), unique (primary keys), table names (foreign keys)
Examples: _id (unique), user_id (user), post_id (post), chat_conversation_id (chat_conversation)
- DO NOT use: int, decimal, boolean, datetime, timestamp, varchar, id (use _id instead)

REFERENCE SCHEMA (do not include these tables in response):
${currentDbml}

RULES:
1. Return ONLY valid DBML - no markdown code blocks
2. Ensure ALL braces are balanced: each Table { must have a closing }
3. Return ONLY NEW tables/fields for this feature - do NOT include existing tables above
4. Create essential new tables/fields for the feature
5. Use snake_case names matching existing patterns - all lowercase with underscores
6. Primary key fields MUST be named "_id" (not "id") with type "unique"
   - Correct: _id unique
   - Incorrect: id unique
7. Foreign key fields MUST follow this pattern: {table_name}_id {referenced_table_name}
   - Naming: MUST be exactly {table_name}_id with NO prefixes or suffixes
   - Type: MUST be the referenced table name (NOT "unique")
   - Examples: user_id user, post_id post, chat_conversation_id chat_conversation
   - WRONG: sender_user_id unique, user_ID unique, userId unique (never use these)
8. Relationships MUST reference "_id" field (NOT "id"):
   - Correct: Ref: review.business_id > business._id
   - Incorrect: Ref: review.business_id > business.id
9. Add table-level Note: "Simple one-sentence explanation" to each new table
10. Add field-level Notes: "Simple one-line explanation" to each field
11. OPTIONAL - TABLEGROUP: At the END of the DBML, create a single TableGroup with color #FFBD94 containing all new tables
    - CRITICAL SYNTAX: TableGroup "feature_name" [color: #FFBD94] { table_name... Note: '''description''' }
    - TableGroup name MUST be in quotes
    - Color MUST use syntax: [color: #FFBD94]
    - Include a Note section with triple quotes for multi-line description of the feature
    - Only add TableGroup if there are new tables

EXAMPLES:
Table "messages" {
  Note: "Stores messages between users."
  _id unique [primary key, Note: "Message ID"]
  user_id user [Note: "Sender"]
  content text [Note: "Message text"]
  created_at date [Note: "When sent"]
}

Table "comments" {
  Note: "Stores comments on posts."
  _id unique [primary key, Note: "Comment ID"]
  post_id post [Note: "Parent post"]
  user_id user [Note: "Comment author"]
  content text [Note: "Comment text"]
}

Table "payroll_run" {
  Note: "Represents a weekly payroll processing batch."
  _id unique [primary key, Note: "Payroll run ID"]
  week_start_date date [Note: "Start date of payroll"]
  processed_by_user_id user [Note: "Admin who processed - foreign key uses table name"]
  status text [Note: "Payroll status"]
}

IMPORTANT DISTINCTION:
- Single foreign key: {table}_id {table} (e.g., processed_by_user_id user)

TABLEGROUP EXAMPLE (with proper syntax):
TableGroup "Messaging System" [color: #FFBD94] {
  conversations
  messages

  Note: '''
  This group manages the messaging functionality.
  - conversations: Stores group conversations between multiple users.
  - messages: Stores messages within conversations.
  '''
}

Start response immediately with Table definitions.

Current Schema:
${currentDbml}`;
}

function validateDbml(dbml: string): { valid: boolean; error?: string } {
  // Check for Table definitions
  if (!dbml.includes("Table ")) {
    return { valid: false, error: "No tables defined in generated schema" };
  }

  // Check for balanced braces
  const openBraces = (dbml.match(/\{/g) || []).length;
  const closeBraces = (dbml.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    return {
      valid: false,
      error: "Invalid DBML syntax (mismatched braces)",
    };
  }

  return { valid: true };
}

function convertDbmlTypeToBubbleType(dbmlType: string): string {
  const typeMap: { [key: string]: string } = {
    // Text types
    'text': 'text',
    'varchar': 'text',
    'string': 'text',

    // Numeric types
    'int': 'number',
    'integer': 'number',
    'decimal': 'number',
    'float': 'number',
    'double': 'number',
    'numeric': 'number',
    'number': 'number',

    // Date/Time types
    'datetime': 'date',
    'timestamp': 'date',
    'date': 'date',
    'time': 'date',

    // Boolean type (use Y_N for Bubble display)
    'boolean': 'Y_N',
    'bool': 'Y_N',
    'bit': 'Y_N',
    'y_n': 'Y_N',

    // Unique/ID type
    'unique': 'unique',
  };

  const normalized = dbmlType.toLowerCase().trim();

  // Check for exact matches first
  if (typeMap[normalized]) {
    return typeMap[normalized];
  }

  // Check if it contains a recognized type
  for (const [key, value] of Object.entries(typeMap)) {
    if (normalized.includes(key)) {
      return value;
    }
  }

  // Return the original type if not recognized
  return dbmlType;
}

function extractFieldTypesFromDbml(dbml: string): { [tableName: string]: { [fieldName: string]: string } } {
  const fieldTypes: { [tableName: string]: { [fieldName: string]: string } } = {};

  // Parse inline Ref relationships to build a foreign key map
  // Pattern: field_name text [ref: > table._id]
  const inlineRefMap: { [tableAndField: string]: string } = {};
  const inlineRefRegex = /(\w+)\s+\w+\s+\[ref:\s*>\s*(\w+)\.(\w+)\]/g;
  let refMatch;

  // We'll need to track which table each field belongs to, so we parse refs after extracting tables
  const refInfo: Array<{ fieldName: string; referencedTable: string }> = [];

  while ((refMatch = inlineRefRegex.exec(dbml)) !== null) {
    const fieldName = refMatch[1];
    const referencedTable = refMatch[2];
    refInfo.push({ fieldName, referencedTable });
  }

  // Match table definitions
  const tableRegex = /Table\s+(?:"([^"]+)"|(\w+))\s*\{([^}]+)\}/g;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(dbml)) !== null) {
    const tableName = tableMatch[1] || tableMatch[2];
    const tableContent = tableMatch[3];

    fieldTypes[tableName] = {};

    // Match field definitions: field_name type [constraints]
    const fieldRegex = /(\w+)\s+(\w+(?:\s*<\s*\w+(?:\s*,\s*\w+)*>)?)\s*(?:\[|;|Note:|$)/g;
    let fieldMatch;

    while ((fieldMatch = fieldRegex.exec(tableContent)) !== null) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];

      // Skip if this is a Note or other non-field line
      if (fieldName.toLowerCase() === 'note') continue;

      let bubbleType = convertDbmlTypeToBubbleType(fieldType);

      // For schema changes display: convert id fields to table name reference
      if (fieldName === 'id') {
        bubbleType = 'unique';
      } else if (fieldName.endsWith('_ids')) {
        // Extract table name from field name (user_ids -> users (list))
        const entityName = fieldName.slice(0, -4); // Remove '_ids' suffix
        // Simple pluralization: add 's' if not already ending in 's'
        const pluralEntity = entityName.endsWith('s') ? entityName : `${entityName}s`;
        bubbleType = `${pluralEntity} (list)`;
      } else if (fieldName.endsWith('_id')) {
        // Extract table name from field name (user_id -> user)
        bubbleType = fieldName.slice(0, -3);
      } else {
        // Check if this field has an inline Ref relationship
        const refInfo_ = refInfo.find(r => r.fieldName === fieldName);
        if (refInfo_) {
          bubbleType = refInfo_.referencedTable;
        }
      }

      fieldTypes[tableName][fieldName] = bubbleType;
    }
  }

  return fieldTypes;
}

function convertDbmlToBubbleTypes(dbml: string): string {
  // Replace DBML types with Bubble types in the entire DBML
  let converted = dbml;

  // Handle inline Ref relationships: field_name text [ref: > table._id]
  // Replace the field's type with the referenced table name
  // Pattern: any word characters (field), any type, [ref: > table._id] -> replace type with table name
  converted = converted.replace(/(\w+)\s+\w+\s+(\[ref:\s*>\s*(\w+)\.)/g, '$1 $3 $2');

  // Replace type declarations: field_name oldType -> field_name newType
  // Do numeric types first (more specific)
  converted = converted.replace(/\b(decimal|float|double|numeric|integer)\b(?=\s*[\[\n;])/gi, 'number');
  converted = converted.replace(/\bbool(?:ean)?\b(?=\s*[\[\n;])/gi, 'Y_N');
  converted = converted.replace(/\b(datetime|timestamp|date|time)\b(?=\s*[\[\n;])/gi, 'date');
  converted = converted.replace(/\bvarchar\b(?=\s*[\[\n;])/gi, 'text');
  converted = converted.replace(/\bint(?:eger)?\b(?=\s*[\[\n;])/gi, 'number');

  // Replace types for fields ending in _id or _ID with "unique"
  // Match: field_name_id <type> [constraints]
  converted = converted.replace(/(\w*_id)\s+(number|text|int|integer)\b/gi, '$1 unique');

  // Replace standalone "id" fields with "unique"
  // Match: id <type> [constraints]
  converted = converted.replace(/\bid\s+(number|text|int|integer)\b/gi, 'id unique');

  return converted;
}


export async function POST(request: NextRequest) {
  try {
    const { currentDbml, featureDescription } = await request.json();

    // Validate inputs
    if (!currentDbml) {
      return NextResponse.json(
        { error: "Current DBML is required" },
        { status: 400 }
      );
    }

    if (!featureDescription) {
      return NextResponse.json(
        { error: "Feature description is required" },
        { status: 400 }
      );
    }

    if (featureDescription.trim().length < 10) {
      return NextResponse.json(
        {
          error: "Please provide a more detailed feature description (at least 10 characters)",
        },
        { status: 400 }
      );
    }

    if (featureDescription.length > 1000) {
      return NextResponse.json(
        {
          error: "Feature description too long. Please keep it under 1000 characters.",
        },
        { status: 400 }
      );
    }

    // Validate API key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not configured");
      return NextResponse.json(
        { error: "Service configuration error. Please contact support." },
        { status: 500 }
      );
    }

    // Call Claude API
    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: "claude-opus-4-5-20251101",
      max_tokens: 8192,
      temperature: 0.3,
      system: buildSystemPrompt(currentDbml),
      messages: [
        {
          role: "user",
          content: featureDescription,
        },
      ],
    });

    // Extract the generated DBML
    let generatedDbml =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!generatedDbml) {
      return NextResponse.json(
        { error: "Failed to generate schema from AI response" },
        { status: 500 }
      );
    }

    // Remove markdown code block wrapper if present
    generatedDbml = generatedDbml.trim();
    if (generatedDbml.startsWith('```')) {
      generatedDbml = generatedDbml.replace(/^```(?:dbml)?\n?/, '').replace(/\n?```$/, '');
    }

    // Validate the generated DBML
    const validation = validateDbml(generatedDbml);
    if (!validation.valid) {
      console.error("Invalid DBML generated:", generatedDbml);
      return NextResponse.json(
        {
          error: `Generated invalid schema: ${validation.error}. Please try rephrasing your feature request.`,
        },
        { status: 500 }
      );
    }

    // Extract field types and convert to Bubble types
    const fieldTypes = extractFieldTypesFromDbml(generatedDbml);

    console.log("=== FIELD TYPES GENERATED ===");
    console.log(JSON.stringify(fieldTypes, null, 2));

    // Extract table descriptions from DBML
    const tableDescriptions: { [tableName: string]: string } = {};
    const tableRegex = /Table\s+"([^"]+)"\s*\{([^}]+)\}/g;
    let tableMatch;
    while ((tableMatch = tableRegex.exec(generatedDbml)) !== null) {
      const tableName = tableMatch[1];
      const tableBody = tableMatch[2];
      const tableNoteMatch = tableBody.match(/^\s*Note:\s*"([^"]+)"/m);
      if (tableNoteMatch) {
        tableDescriptions[tableName] = tableNoteMatch[1];
      }
    }

    console.log("=== TABLE DESCRIPTIONS ===");
    console.log(JSON.stringify(tableDescriptions, null, 2));

    // Convert DBML to use Bubble types for display in diagram
    const generatedDbmlWithBubbleTypes = convertDbmlToBubbleTypes(generatedDbml);

    // Generate a short summary title for the feature
    let featureTitle = featureDescription;
    try {
      const titleMessage = await anthropic.messages.create({
        model: "claude-opus-4-5-20251101",
        max_tokens: 50,
        temperature: 0.3,
        system: "Generate a very short, 2-4 word title for this feature request. Return ONLY the title, nothing else.",
        messages: [
          {
            role: "user",
            content: featureDescription,
          },
        ],
      });

      if (titleMessage.content[0].type === "text") {
        featureTitle = titleMessage.content[0].text.trim();
      }
    } catch (error) {
      console.error("Error generating feature title:", error);
      // Fall back to original description if title generation fails
    }

    return NextResponse.json({
      generatedDbml,
      generatedDbmlWithBubbleTypes,
      fieldTypes,
      tableDescriptions,
      featureTitle,
    });
  } catch (error) {
    console.error("Error in plan-feature route:", error);

    if (error instanceof Anthropic.APIError) {
      if (error.status === 429) {
        return NextResponse.json(
          { error: "Too many requests. Please try again in a moment." },
          { status: 429 }
        );
      }

      if (error.status === 401) {
        return NextResponse.json(
          {
            error: "Service configuration error. Please contact support.",
          },
          { status: 500 }
        );
      }

      if (error.status === 503) {
        return NextResponse.json(
          { error: "AI service temporarily unavailable. Please try again soon." },
          { status: 503 }
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to generate schema. Please try again." },
      { status: 500 }
    );
  }
}
