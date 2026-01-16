/**
 * AI-Powered Schema Editing API Endpoint
 *
 * PURPOSE:
 * This endpoint allows users to edit their database schema using natural language.
 * Instead of manually modifying DBML text, users can say things like "add a phone field
 * to the user table" and Claude AI will make the changes for them.
 *
 * WHAT IT DOES:
 * 1. Receives the current DBML schema and a plain English edit instruction
 * 2. Sends both to Claude AI with careful instructions about how to edit schemas
 * 3. Claude returns the modified DBML with the requested changes applied
 * 4. The endpoint validates the output and converts types to Bubble-compatible formats
 *
 * WHY THIS MATTERS:
 * Editing DBML manually requires knowing the syntax. This feature lets users describe
 * what they want in plain language, making schema changes accessible to everyone.
 *
 * INPUT:
 * - currentDbml: The current DBML schema to edit
 * - editInstruction: Plain English description of what to change (e.g., "add email field to users")
 *
 * OUTPUT:
 * - updatedDbml: The modified schema with changes applied
 * - updatedDbmlWithBubbleTypes: Same schema with types converted for Bubble.io
 * - fieldTypes: Mapping of table -> field -> type for UI display
 * - tableDescriptions: Any table-level notes/descriptions
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Builds the System Prompt for Claude
 *
 * This function creates detailed instructions that tell Claude exactly how to
 * edit the DBML schema. It includes:
 * - The current schema that should be edited
 * - Rules about what types to use (Bubble-compatible types only)
 * - Formatting rules (snake_case, proper primary keys, etc.)
 * - Examples of correct syntax
 *
 * WHY SO DETAILED:
 * Claude needs very specific instructions to produce valid DBML that works with
 * Bubble.io's type system. Without these rules, it might use standard SQL types
 * that don't work in Bubble.
 */
function buildSystemPrompt(currentDbml: string): string {
  return `You are editing a Bubble.io database schema proposal in DBML format.

IMPORTANT: You are editing ONLY the proposed/newly generated schema shown below.
Apply the user's requested changes to these tables only.
Do NOT add new tables unless explicitly requested by the user.

PROPOSED SCHEMA TO EDIT:
${currentDbml}

EDIT OPERATIONS: MODIFY, REMOVE, RENAME fields/tables
- MODIFY: change field names, types, descriptions, add fields to existing tables
- REMOVE: delete fields or tables from the proposal
- RENAME: rename tables or fields

BUBBLE TYPES ONLY: text, number, Y_N (yes/no), date (datetime), unique (primary keys), table names (foreign keys)
Examples: _id (unique), user_id (user), post_id (post)
- DO NOT use: int, decimal, boolean, datetime, timestamp, varchar, id (use _id instead)

RULES:
1. Return ONLY valid DBML - no markdown code blocks, no explanations
2. Ensure ALL braces are balanced
3. Include ALL tables from the proposed schema (even ones you don't modify)
4. Use snake_case names - all lowercase with underscores
5. Primary key fields MUST be named "_id" (not "id") with type "unique" - DO NOT add notes to _id fields
   - Correct: _id unique
   - Incorrect: id unique
6. Foreign key fields: {table_name}_id {referenced_table_name}
7. Relationships MUST reference "_id" field (NOT "id"):
   - Correct: Ref: review.business_id > business._id
   - Incorrect: Ref: review.business_id > business.id
8. Add table and field notes for clarity (but NOT for _id/primary key fields)
9. Preserve all existing Ref statements exactly as they are - ensure they reference "_id"

Return ONLY the complete updated proposal DBML. Nothing else.`;
}

/**
 * Validates DBML Syntax
 *
 * Performs basic checks to ensure the DBML is structurally valid:
 * 1. Checks that at least one table is defined
 * 2. Checks that all opening braces { have matching closing braces }
 *
 * WHY THIS IS NEEDED:
 * If Claude returns malformed DBML (missing braces, no tables), it would break
 * the diagram generation. This catches obvious errors before they cause problems.
 */
function validateDbml(dbml: string): { valid: boolean; error?: string } {
  // Check that there's at least one table defined
  if (!dbml.includes("Table ")) {
    return { valid: false, error: "No tables defined" };
  }

  // Check that braces are balanced (every { has a matching })
  const openBraces = (dbml.match(/\{/g) || []).length;
  const closeBraces = (dbml.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    return { valid: false, error: "Mismatched braces" };
  }

  return { valid: true };
}

/**
 * Converts Standard Database Types to Bubble.io Types
 *
 * Bubble.io uses its own type system that differs from standard SQL:
 * - "text" for any string/varchar
 * - "number" for any numeric type (int, decimal, float, etc.)
 * - "Y_N" for yes/no (boolean) fields
 * - "date" for any date/time type
 * - "unique" for ID fields
 *
 * This function takes any standard database type and returns the
 * corresponding Bubble type for display in the UI.
 */
function convertDbmlTypeToBubbleType(dbmlType: string): string {
  // Map of standard types to Bubble types
  const typeMap: { [key: string]: string } = {
    // Text types -> text
    text: "text",
    varchar: "text",
    // Numeric types -> number
    int: "number",
    integer: "number",
    decimal: "number",
    float: "number",
    double: "number",
    numeric: "number",
    number: "number",
    // Date/time types -> date
    datetime: "date",
    timestamp: "date",
    date: "date",
    time: "date",
    // Boolean types -> Y_N (yes/no)
    boolean: "Y_N",
    bool: "Y_N",
    bit: "Y_N",
    y_n: "Y_N",
    // ID type -> unique
    unique: "unique",
  };

  const normalized = dbmlType.toLowerCase().trim();
  return typeMap[normalized] || "text"; // Default to text if unknown type
}

/**
 * Extracts Field Type Information from DBML
 *
 * Parses the DBML schema and builds a mapping of every field's type,
 * organized by table. This is used by the UI to display field types
 * in a user-friendly format.
 *
 * SPECIAL HANDLING:
 * - "id" fields are always marked as "unique" (primary key indicator)
 * - Fields ending in "_id" are shown as the referenced table name
 *   (e.g., "user_id" becomes type "user" to show it links to the user table)
 *
 * Returns: { tableName: { fieldName: bubbleType, ... }, ... }
 */
function extractFieldTypesFromDbml(dbml: string): { [tableName: string]: { [fieldName: string]: string } } {
  const fieldTypes: { [tableName: string]: { [fieldName: string]: string } } = {};
  // Pattern to match table definitions: Table "name" { ... } or Table name { ... }
  const tableRegex = /Table\s+(?:"([^"]+)"|(\w+))\s*\{([^}]+)\}/g;
  let tableMatch;

  // Process each table in the DBML
  while ((tableMatch = tableRegex.exec(dbml)) !== null) {
    const tableName = tableMatch[1] || tableMatch[2];
    const tableContent = tableMatch[3];
    fieldTypes[tableName] = {};

    // Pattern to match field definitions: fieldname type [constraints]
    const fieldRegex = /(\w+)\s+(\w+(?:\s*<\s*\w+(?:\s*,\s*\w+)*>)?)\s*(?:\[|;|Note:|$)/g;
    let fieldMatch;

    // Process each field in this table
    while ((fieldMatch = fieldRegex.exec(tableContent)) !== null) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];

      // Skip Note: lines (these are comments, not fields)
      if (fieldName.toLowerCase() === "note") continue;

      // Convert the field type to Bubble-friendly format
      let bubbleType = convertDbmlTypeToBubbleType(fieldType);

      // Special cases for ID fields:
      if (fieldName === "id") {
        // Primary key fields are always "unique"
        bubbleType = "unique";
      } else if (fieldName.endsWith("_id")) {
        // Foreign key fields show the referenced table name
        // user_id -> "user", post_id -> "post"
        bubbleType = fieldName.slice(0, -3);
      }

      fieldTypes[tableName][fieldName] = bubbleType;
    }
  }

  return fieldTypes;
}

/**
 * Converts All Types in DBML to Bubble-Compatible Types
 *
 * This function performs a bulk find-and-replace on the entire DBML text
 * to convert standard database types to Bubble types. Unlike extractFieldTypesFromDbml
 * which just extracts info, this actually modifies the DBML content.
 *
 * CONVERSIONS:
 * - decimal, float, double, numeric, integer -> number
 * - boolean, bool -> Y_N
 * - datetime, timestamp, date, time -> date
 * - varchar -> text
 * - Any _id field with numeric type -> unique (for proper foreign key display)
 */
function convertDbmlToBubbleTypes(dbml: string): string {
  let converted = dbml;
  // Replace numeric types with "number"
  converted = converted.replace(/\b(decimal|float|double|numeric|integer)\b(?=\s*[\[\n;])/gi, "number");
  // Replace boolean types with "Y_N" (Bubble's yes/no)
  converted = converted.replace(/\bbool(?:ean)?\b(?=\s*[\[\n;])/gi, "Y_N");
  // Replace date/time types with "date"
  converted = converted.replace(/\b(datetime|timestamp|date|time)\b(?=\s*[\[\n;])/gi, "date");
  // Replace varchar with "text"
  converted = converted.replace(/\bvarchar\b(?=\s*[\[\n;])/gi, "text");
  // Replace int with "number"
  converted = converted.replace(/\bint(?:eger)?\b(?=\s*[\[\n;])/gi, "number");
  // Ensure _id fields have "unique" type (for foreign keys)
  converted = converted.replace(/(\w*_id)\s+(number|text|int|integer)\b/gi, "$1 unique");
  // Ensure standalone id field has "unique" type (for primary key)
  converted = converted.replace(/\bid\s+(number|text|int|integer)\b/gi, "id unique");
  return converted;
}

/**
 * Extracts Table-Level Descriptions from DBML
 *
 * Tables in DBML can have Note: "description" lines that explain what the table is for.
 * This function finds those notes and returns them as a mapping of table name to description.
 *
 * Example DBML:
 *   Table user {
 *     Note: "Stores all registered users"
 *     _id unique
 *     ...
 *   }
 *
 * Would return: { "user": "Stores all registered users" }
 *
 * These descriptions are displayed in the UI to help users understand what each table does.
 */
function extractTableDescriptions(dbml: string): { [tableName: string]: string } {
  const tableDescriptions: { [tableName: string]: string } = {};
  const tableRegex = /Table\s+(?:"([^"]+)"|(\w+))\s*\{([^}]+)\}/g;
  let tableMatch;

  // Process each table looking for Note: lines
  while ((tableMatch = tableRegex.exec(dbml)) !== null) {
    const tableName = tableMatch[1] || tableMatch[2];
    const tableBody = tableMatch[3];
    // Look for Note: "description" at the start of a line within the table
    const tableNoteMatch = tableBody.match(/^\s*Note:\s*"([^"]+)"/m);
    if (tableNoteMatch) {
      tableDescriptions[tableName] = tableNoteMatch[1];
    }
  }

  return tableDescriptions;
}

/**
 * Main Request Handler
 *
 * Processes edit requests by:
 * 1. Validating the input (DBML exists, instruction is reasonable length)
 * 2. Sending the edit request to Claude AI
 * 3. Cleaning up and validating Claude's response
 * 4. Extracting type information for the UI
 * 5. Returning the updated schema
 */
export async function POST(request: NextRequest) {
  try {
    const { currentDbml, editInstruction } = await request.json();

    // Validate inputs - we need both the current schema and an edit instruction
    if (!currentDbml) {
      return NextResponse.json({ error: "Current DBML is required" }, { status: 400 });
    }

    // Edit instruction must be at least 5 characters (prevents empty/meaningless requests)
    if (!editInstruction || editInstruction.trim().length < 5) {
      return NextResponse.json({ error: "Edit instruction too short" }, { status: 400 });
    }

    // Cap instruction length to prevent abuse and excessive API costs
    if (editInstruction.length > 500) {
      return NextResponse.json({ error: "Edit instruction too long" }, { status: 400 });
    }

    // Check that Claude API key is configured
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "API key not configured" }, { status: 500 });
    }

    // Call Claude AI to perform the edit
    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",     // Use Sonnet for fast, capable responses
      max_tokens: 8192,                        // Allow long schemas in response
      temperature: 0.3,                        // Lower temperature for more consistent output
      system: buildSystemPrompt(currentDbml), // Instructions include the current schema
      messages: [
        {
          role: "user",
          content: editInstruction,           // The user's edit request in plain English
        },
      ],
    });

    // Extract the updated DBML from Claude's response
    let updatedDbml = message.content[0].type === "text" ? message.content[0].text : "";

    if (!updatedDbml) {
      return NextResponse.json({ error: "No response from AI" }, { status: 500 });
    }

    // Clean up markdown code blocks if Claude wrapped the response in them
    // Claude is instructed not to, but sometimes does anyway
    updatedDbml = updatedDbml.trim();
    if (updatedDbml.startsWith("```")) {
      updatedDbml = updatedDbml.replace(/^```(?:dbml)?\n?/, "").replace(/\n?```$/, "");
    }
    updatedDbml = updatedDbml.trim();

    // Validate that Claude returned valid DBML
    const validation = validateDbml(updatedDbml);
    if (!validation.valid) {
      return NextResponse.json(
        { error: `Invalid DBML: ${validation.error}` },
        { status: 400 }
      );
    }

    // Extract metadata for the UI (field types, table descriptions)
    const fieldTypes = extractFieldTypesFromDbml(updatedDbml);
    const tableDescriptions = extractTableDescriptions(updatedDbml);
    // Also create a version with Bubble-compatible types for display
    const updatedDbmlWithBubbleTypes = convertDbmlToBubbleTypes(updatedDbml);

    // Return the edited schema with all extracted metadata
    return NextResponse.json({
      updatedDbml,                    // The raw edited DBML
      updatedDbmlWithBubbleTypes,     // DBML with types converted for Bubble
      fieldTypes,                     // Type info for UI display
      tableDescriptions,              // Table descriptions for UI
    });
  } catch (error) {
    console.error("Error in edit-dbml route:", error);

    if (error instanceof Anthropic.APIError) {
      if (error.status === 429) {
        return NextResponse.json(
          { error: "Too many requests" },
          { status: 429 }
        );
      }
      if (error.status === 401) {
        return NextResponse.json(
          { error: "API configuration error" },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to process edit" },
      { status: 500 }
    );
  }
}
