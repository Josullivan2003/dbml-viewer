import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

function buildSystemPrompt(currentDbml: string): string {
  return `Design database schema extensions for Bubble.io using DBML. Extend the existing schema with new tables/fields for the requested feature.

BUBBLE TYPES ONLY: text, number, Y_N (yes/no), date (datetime), unique (primary keys), table names (foreign keys)
Examples: id (unique), user_id (user), post_id (post), chat_conversation_id (chat_conversation)
- DO NOT use: int, decimal, boolean, datetime, timestamp, varchar

BUBBLE LIST FIELDS (for schema descriptions only, NOT in DBML):
Bubble supports "list of [table_name]" fields to store multiple references (e.g., a conversation with a list of users).
- Use only when the collection will not exceed 100 items
- Do NOT add list fields to the DBML structure itself
- Mention in field notes if a field could alternatively be a list (e.g., "[field_name]: 'List of users in conversation (limit 100)'")

RULES:
1. Return ONLY valid DBML - no markdown/code blocks
2. Include ALL existing tables exactly as-is
3. Add only essential new tables/fields for the feature
4. Use snake_case names matching existing patterns - all lowercase with underscores
5. Primary key fields (named "id") use "unique" type
6. Foreign key naming: MUST be exactly {table_name}_id with NO prefixes or suffixes
   - Examples: user_id, post_id, chat_conversation_id
   - WRONG: sender_user_id, user_ID, userId, UserID (never use these variations)
7. Foreign key field types MUST be the referenced table name: user_id uses type "user", post_id uses type "post"
8. Relationships: > (many-to-one), < (one-to-many), - (one-to-one)
9. Add table-level Note: "Simple one-sentence explanation"
10. Add field-level Notes: "Simple one-line explanation"
11. Group new tables in TableGroup with color: #FFBD94

EXAMPLES:
Table "messages" {
  Note: "Stores messages between users."
  id unique [primary key, Note: "Message ID"]
  user_id user [Note: "Sender"]
  content text [Note: "Message text"]
  created_at date [Note: "When sent"]
}

Table "comments" {
  Note: "Stores comments on posts."
  id unique [primary key, Note: "Comment ID"]
  post_id post [Note: "Parent post"]
  user_id user [Note: "Comment author"]
  content text [Note: "Comment text"]
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

    // Default for unrecognized types
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

  // Default to text for unrecognized types
  return 'text';
}

function extractFieldTypesFromDbml(dbml: string): { [tableName: string]: { [fieldName: string]: string } } {
  const fieldTypes: { [tableName: string]: { [fieldName: string]: string } } = {};

  // Match table definitions
  const tableRegex = /Table\s+"([^"]+)"\s*\{([^}]+)\}/g;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(dbml)) !== null) {
    const tableName = tableMatch[1];
    const tableContent = tableMatch[2];

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
      } else if (fieldName.endsWith('_id')) {
        // Extract table name from field name (user_id -> user)
        bubbleType = fieldName.slice(0, -3);
      }

      fieldTypes[tableName][fieldName] = bubbleType;
    }
  }

  return fieldTypes;
}

function convertDbmlToBubbleTypes(dbml: string): string {
  // Replace DBML types with Bubble types in the entire DBML
  let converted = dbml;

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
